/**
 * Lane D — Phase 1, invariants 6 and 7: concurrency and the append-only journal.
 *
 * These are the two that a single-threaded happy-path test can never reach, so
 * they get their own file and their own real-Postgres path.
 */

import { Client } from 'pg';

import type { StoreAdapter } from '../../lib/adapters/types';
import { applyStage, reconcileRollout, rollbackRollout } from '../../lib/pricing/writer';
import { evaluateRollout } from '../../lib/evaluator/index';
import { nowIso, today, type DayString } from '../../lib/dates';
import type { Product, Rollout, Shop } from '../../lib/types';

import { FakeShopify, assert, assertEqual, assertExactCents, makeProduct, section, skip, test } from './_harness';
import { makeScenario, advanceTo } from './invariants.test';

// ---------------------------------------------------------------------------
// 6. concurrency
// ---------------------------------------------------------------------------

export async function runConcurrencySuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] 6. concurrency`);

  await test('two evaluators racing on one rollout: exactly one runs, the other skips', async () => {
    const products = [0, 1, 2, 3].map((i) => makeProduct(i, { priceCents: 1000 + i * 100, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });
    await advanceTo(scenario, 0);

    const day = today(shop.timezone) as DayString;
    const notifier = async (): Promise<void> => undefined;

    const [a, b] = await Promise.all([
      evaluateRollout(adapter, shop, scenario.rollout, {
        asOfDay: day,
        client: scenario.shopify.asClient(),
        notifier: notifier as never,
      }),
      evaluateRollout(adapter, shop, scenario.rollout, {
        asOfDay: day,
        client: scenario.shopify.asClient(),
        notifier: notifier as never,
      }),
    ]);

    const locked = [a, b].filter((result) => result.skipped === 'locked').length;
    const ran = [a, b].filter((result) => result.skipped === null).length;

    assertEqual(locked + ran, 2, 'both calls returned a decision or a skip');
    assertEqual(
      locked,
      1,
      `the lease must exclude: expected exactly one "locked", got ${locked} (ran=${ran}). ` +
        `If this is 0, two evaluators ran concurrently on one rollout.`,
    );
  });

  await test('a stage never half-applies: the advance gate holds when a write failed', async () => {
    const products = [0, 1, 2, 3, 4, 5].map((i) => makeProduct(i, { priceCents: 2000 + i * 50, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });

    const doomed = products[2] as Product;
    scenario.shopify.program({ kind: 'server_error', products: [doomed.product_gid], onCall: 0 });

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 0, stage_entered_at: nowIso() });
    const applied = await applyStage(scenario.context as never, scenario.rollout, 0);

    if (applied.intended === 0) {
      // The doomed variant did not land in cohort 0; force the whole selection.
      scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2 });
      const all = await applyStage(scenario.context as never, scenario.rollout, 2);
      assertEqual(all.fully_applied, false, 'a failed write means the stage is not fully applied');
      return;
    }
    assert(
      applied.fully_applied === (applied.failed === 0),
      '`fully_applied` must be exactly "nothing failed and nothing was externally changed"',
    );
  });

  await test('rollback issued during a stage advance leaves no price above its baseline', async () => {
    const products = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => makeProduct(i, { priceCents: 3000 + i * 25, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 20 });
    await advanceTo(scenario, 0);

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 1, stage_entered_at: nowIso() });

    // Race: the stage-1 write and a merchant-triggered rollback, interleaved.
    await Promise.all([
      applyStage(scenario.context as never, scenario.rollout, 1),
      rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'merchant panicked mid-advance' }),
    ]);

    // Whatever the interleaving, a second rollback must settle every price back
    // to baseline. The invariant is convergence, not instantaneous consistency.
    await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'settle' });

    for (const product of products) {
      assertExactCents(
        scenario.shopify.priceOf(product.variant_gid),
        product.price_cents,
        `${product.sku} settled back to baseline after a rollback/advance race`,
      );
    }
  });

  await test('kill switch during an active write still converges to every baseline', async () => {
    const products = [0, 1, 2, 3].map((i) => makeProduct(i, { priceCents: 4000 + i * 10, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 15 });
    await advanceTo(scenario, 0);

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });

    await Promise.all([
      applyStage(scenario.context as never, scenario.rollout, 2),
      rollbackRollout(scenario.context as never, scenario.rollout, {
        reason: 'kill switch mid-write',
        source: 'kill_switch',
        actor: 'merchant',
      }),
    ]);
    await rollbackRollout(scenario.context as never, scenario.rollout, {
      reason: 'settle',
      source: 'kill_switch',
      actor: 'merchant',
    });

    for (const product of products) {
      assertExactCents(
        scenario.shopify.priceOf(product.variant_gid),
        product.price_cents,
        `${product.sku} back at baseline after a kill switch during a write`,
      );
    }
  });

  await test('the kill switch unwinds CHAINED rollouts back to the original price', async () => {
    // The scenario the kill switch exists for. Rollout A takes 1000 -> 1100 and
    // completes; rollout B then takes 1100 -> 1210. "Revert everything Priceflag
    // ever changed" (R21) must land on 1000.
    //
    // The route unwinds each rollout to its OWN captured baseline, in whatever
    // order `listRollouts` returns. That composes to the original price only if
    // the order is strictly newest-first. `listRollouts` sorts on `created_at`
    // with no tie-breaker, so two rollouts created inside the same clock tick
    // sort as equal and fall back to insertion order — oldest first — and the
    // merchant is left on a price Priceflag invented.
    //
    // Repeated, because it is a race: a single pass passes or fails depending on
    // whether the two `created_at` values happen to differ.
    const ATTEMPTS = 12;
    const wrong: string[] = [];

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const base = makeProduct(0, { priceCents: 1000, productIndex: 0 });

      const first = await makeScenario(adapter, shop, [base], { type: 'percent', percent: 10 });
      await advanceTo(first, first.rollout.stages.length - 1);
      await adapter.updateRollout(first.rollout.id, {
        status: 'completed',
        ended_at: nowIso(),
        ended_reason: 'completed',
      });

      const moved: Product = { ...base, price_cents: 1100 };
      const second = await makeScenario(adapter, shop, [moved], { type: 'percent', percent: 10 });
      // Both rollouts must see the SAME store.
      second.shopify.prices.clear();
      for (const [gid, row] of first.shopify.prices) second.shopify.prices.set(gid, { ...row });
      await advanceTo(second, second.rollout.stages.length - 1);
      await adapter.updateRollout(second.rollout.id, {
        status: 'completed',
        ended_at: nowIso(),
        ended_reason: 'completed',
      });

      // The EXACT loop `app/api/kill-switch/route.ts` runs.
      const shared = second.shopify;
      const context = { adapter, client: shared.asClient(), shop };
      const listed = await adapter.listRollouts(shop.id);
      const pair = listed.filter((r) => r.id === first.rollout.id || r.id === second.rollout.id);

      for (const rollout of pair) {
        await rollbackRollout(context as never, rollout as Rollout, {
          reason: 'Store-wide undo (kill switch).',
          source: 'kill_switch',
          actor: 'merchant',
        });
      }

      const final = shared.priceOf(base.variant_gid);
      if (final !== 1000) {
        const order = pair.map((r) => (r.id === first.rollout.id ? 'A(old)' : 'B(new)')).join(' -> ');
        wrong.push(`attempt ${attempt}: left on ${final} (order ${order})`);
      }
    }

    assertEqual(
      wrong.length,
      0,
      `R21 broken in ${wrong.length}/${ATTEMPTS} attempts — the kill switch left the merchant on a ` +
        `price Priceflag invented instead of the pre-Priceflag 1000.\n      ${wrong.slice(0, 4).join('\n      ')}\n` +
        `      Cause: listRollouts sorts on created_at with no tie-breaker, so same-tick rollouts unwind oldest-first.`,
    );
  });
}

// ---------------------------------------------------------------------------
// R4 — external change detection, before AND after a variant goes live
// ---------------------------------------------------------------------------

export async function runExternalChangeSuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] R4. external price changes mid-rollout`);

  await test('an admin edit BEFORE the variant goes live is detected and nothing is overwritten', async () => {
    const products = [makeProduct(0, { priceCents: 1000, productIndex: 0 })];
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });

    // Merchant runs a promo in the Shopify admin before our stage lands.
    scenario.shopify.setPrice((products[0] as Product).variant_gid, 800);

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });
    const applied = await applyStage(scenario.context as never, scenario.rollout, 2);

    assertEqual(applied.external_changes.length, 1, 'the external change is detected (R4)');
    assertEqual(applied.applied, 0, 'and nothing was overwritten');
    assertEqual(applied.fully_applied, false, 'so the stage is not "fully applied"');
    assertExactCents(scenario.shopify.priceOf((products[0] as Product).variant_gid), 800, "the merchant's price stands");
  });

  await test('an admin edit AFTER the variant went live is detected and preserved by reconcile', async () => {
    const products = [makeProduct(0, { priceCents: 1000, productIndex: 0 })];
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });
    const gid = (products[0] as Product).variant_gid;

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });
    await applyStage(scenario.context as never, scenario.rollout, 2);
    assertExactCents(scenario.shopify.priceOf(gid), 1100, 'our stage price is live');

    // Now the merchant discounts it by hand in the Shopify admin.
    scenario.shopify.setPrice(gid, 850);

    const reconciled = await reconcileRollout(scenario.context as never, scenario.rollout);
    const livePrice = scenario.shopify.priceOf(gid);

    // The R4 promise is "external price edits pause any rollout touching that
    // product". `applyStage` only tests for that when `applied_at === null`, so a
    // post-apply edit takes the ordinary repair path instead.
    assertEqual(
      reconciled.external_changes.length,
      1,
      `R4: an admin edit after the variant went live must be detected as external, not repaired. ` +
        `external_changes=${reconciled.external_changes.length}, applied=${reconciled.applied}, ` +
        `merchant's 850 is now ${livePrice}`,
    );
  });

  await test('rollback preserves an admin edit made after activation', async () => {
    const products = [makeProduct(0, { priceCents: 1000, productIndex: 0 })];
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });
    const gid = (products[0] as Product).variant_gid;

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, {
      current_stage: 2,
      stage_entered_at: nowIso(),
    });
    await applyStage(scenario.context as never, scenario.rollout, 2);
    scenario.shopify.setPrice(gid, 850);

    const undo = await rollbackRollout(scenario.context as never, scenario.rollout, {
      reason: 'merchant requested rollback after editing Shopify',
      actor: 'merchant',
    });

    assertEqual(undo.external_changes.length, 1, 'the rollback reports the conflicting merchant edit');
    assertEqual(undo.applied, 0, 'the rollback does not overwrite the merchant');
    assertExactCents(scenario.shopify.priceOf(gid), 850, "the merchant's live price remains authoritative");
  });
}

// ---------------------------------------------------------------------------
// 7. append-only journal, in real Postgres
// ---------------------------------------------------------------------------

export async function runJournalImmutabilitySuite(): Promise<void> {
  section('7. append-only journal (real Postgres)');

  const url = process.env.SUPABASE_DB_URL;
  if (url === undefined || url === '') {
    skip('journal immutability', 'SUPABASE_DB_URL not set');
    return;
  }

  const attempts: { name: string; sql: string; mustFail: boolean }[] = [
    {
      name: 'UPDATE is rejected, even from the service role',
      sql: `update journal_entries set after_price_cents = after_price_cents + 1 where id = (select id from journal_entries limit 1)`,
      mustFail: true,
    },
    {
      name: 'DELETE is rejected',
      sql: `delete from journal_entries where id = (select id from journal_entries limit 1)`,
      mustFail: true,
    },
    {
      name: 'ON CONFLICT DO UPDATE cannot be used to rewrite history',
      sql: `insert into journal_entries (id, shop_id, variant_gid, product_gid, title, source, actor, status,
              before_price_cents, after_price_cents, currency, applied_at, idempotency_key)
            select id, shop_id, variant_gid, product_gid, title, source, actor, status,
              before_price_cents, 1, currency, applied_at, idempotency_key
            from journal_entries limit 1
            on conflict (id) do update set after_price_cents = 1`,
      mustFail: true,
    },
    {
      name: 'TRUNCATE is rejected',
      sql: `truncate table journal_entries`,
      mustFail: true,
    },
  ];

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query('select count(*)::int as n from journal_entries');
    const count = (rows[0] as { n: number }).n;
    if (count === 0) {
      skip('journal immutability', 'journal_entries is empty — run scripts/smoke.ts first');
      return;
    }

    for (const attempt of attempts) {
      await test(attempt.name, async () => {
        // Everything runs inside a transaction that is ALWAYS rolled back, so a
        // statement that unexpectedly succeeds cannot damage the real journal.
        await client.query('begin');
        let failed = false;
        let message = '';
        try {
          await client.query(attempt.sql);
        } catch (cause) {
          failed = true;
          message = cause instanceof Error ? cause.message : String(cause);
        } finally {
          await client.query('rollback');
        }

        if (attempt.mustFail) {
          assert(failed, `the journal accepted "${attempt.name}" — it is not append-only`);
          assert(message.length > 0, 'the rejection carries a reason');
        }
      });
    }

    await test('the append-only guard is a trigger/rule on the table, not app-level convention', async () => {
      const { rows: triggers } = await client.query(
        `select tgname from pg_trigger
         where tgrelid = 'journal_entries'::regclass and not tgisinternal`,
      );
      const { rows: rules } = await client.query(
        `select rulename from pg_rules where tablename = 'journal_entries'`,
      );
      const { rows: policies } = await client.query(
        `select policyname, cmd from pg_policies where tablename = 'journal_entries'`,
      );
      assert(
        triggers.length > 0 || rules.length > 0 || policies.length > 0,
        'nothing in the database enforces append-only — the guarantee is app-level only',
      );
    });

    await test('a service-role caller cannot simply drop the guard and rewrite a row', async () => {
      await client.query('begin');
      let droppedAndRewrote = false;
      try {
        const { rows: triggers } = await client.query(
          `select tgname from pg_trigger where tgrelid = 'journal_entries'::regclass and not tgisinternal`,
        );
        for (const trigger of triggers as { tgname: string }[]) {
          await client.query(`alter table journal_entries disable trigger ${trigger.tgname}`);
        }
        await client.query(
          `update journal_entries set after_price_cents = after_price_cents where id = (select id from journal_entries limit 1)`,
        );
        droppedAndRewrote = true;
      } catch {
        droppedAndRewrote = false;
      } finally {
        await client.query('rollback');
      }

      // This is documented as an expected property of a superuser-equivalent
      // connection, not a pass/fail gate — it is recorded so the report can state
      // plainly what the guarantee is and is not worth.
      process.stdout.write(
        `    \x1b[2mnote: direct-Postgres owner can disable the trigger and update: ${droppedAndRewrote}\x1b[0m\n`,
      );
    });
  } finally {
    await client.end();
  }
}

export { FakeShopify };
