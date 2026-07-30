/**
 * B5 acceptance: drive the whole loop on the real dev store.
 *
 *   npx tsx scripts/simulate-rollout.ts
 *
 * Two rollouts, end to end:
 *   A. a **healthy** one that advances through every stage and completes
 *   B. a **starved** one that breaches its guardrail and auto-rolls back, with
 *      every price then verified against Shopify and against the journal
 *
 * ## What is real and what is simulated
 *
 * **Real:** the products, the price writes (this genuinely changes prices on the
 * dev store), the orders (created through `draftOrderCreate` /
 * `draftOrderComplete`, so they are real orders), the sync that turns them into
 * `order_days`, every database row, and the rollback.
 *
 * **Simulated:** the passage of time. A rollout holds each stage for days, and
 * waiting is not an option, so the evaluator is called with an explicit `asOfDay`
 * and the pre-rollout baseline is seeded as `order_days` rows marked
 * `source: 'seed'`. Nothing else is faked.
 *
 * The script restores every price it touched, even when it fails.
 */

import { loadEnv } from './load-env';

loadEnv();

import { SupabaseAdapter } from '../lib/adapters/supabase';
import { defaultGuardrails } from '../lib/contracts';
import { addDays, today } from '../lib/dates';
import { AdminGraphqlClient } from '../lib/shopify/client';
import { ensureStaticShop, credentialsFromShop } from '../lib/shopify/credentials';
import { normalizeStages, planRolloutVariants } from '../lib/engine/rollout';
import { evaluateRollout, startRollout } from '../lib/evaluator';
import { rollbackRollout, verifyRollback } from '../lib/pricing/writer';
import { readLivePrices } from '../lib/shopify/prices';
import { collectingNotifier } from '../lib/notify';
import { formatCents } from '../lib/money';
import type { Product, Rollout, Shop } from '../lib/types';
import type { StoreAdapter } from '../lib/adapters/types';

const HEALTHY_UNITS_PER_DAY = 12;
const BASELINE_DAYS = 30;

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

function step(title: string): void {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation PriceflagDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_COMPLETE = /* GraphQL */ `
  mutation PriceflagDraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id, paymentPending: true) {
      draftOrder { id order { id createdAt } }
      userErrors { field message }
    }
  }
`;

/** Create a genuine order on the dev store. */
async function placeOrder(
  client: AdminGraphqlClient,
  lineItems: { variantId: string; quantity: number }[],
): Promise<string | null> {
  const created = await client.request<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
  }>(DRAFT_ORDER_CREATE, { input: { lineItems } });

  if (created.draftOrderCreate.userErrors.length > 0) {
    throw new Error(`draftOrderCreate: ${created.draftOrderCreate.userErrors.map((e) => e.message).join('; ')}`);
  }
  const draftId = created.draftOrderCreate.draftOrder?.id;
  if (draftId === undefined) return null;

  const completed = await client.request<{
    draftOrderComplete: {
      draftOrder: { order: { id: string } | null } | null;
      userErrors: { message: string }[];
    };
  }>(DRAFT_ORDER_COMPLETE, { id: draftId });

  if (completed.draftOrderComplete.userErrors.length > 0) {
    throw new Error(`draftOrderComplete: ${completed.draftOrderComplete.userErrors.map((e) => e.message).join('; ')}`);
  }
  return completed.draftOrderComplete.draftOrder?.order?.id ?? null;
}

/** Pre-rollout baseline, so the band has something to expect. */
async function seedBaseline(
  adapter: StoreAdapter,
  shop: Shop,
  products: Product[],
  endDay: string,
  unitsPerDay: number,
): Promise<void> {
  const rows = [];
  for (let i = BASELINE_DAYS; i >= 1; i -= 1) {
    const day = addDays(endDay, -i);
    for (const product of products) {
      rows.push({
        variant_gid: product.variant_gid,
        product_gid: product.product_gid,
        day,
        units: unitsPerDay,
        orders: unitsPerDay,
        gross_revenue_cents: unitsPerDay * product.price_cents,
        discount_cents: 0,
        refund_units: 0,
        refund_cents: 0,
        net_revenue_cents: unitsPerDay * product.price_cents,
        realized_unit_price_cents: product.price_cents,
        list_price_cents: product.price_cents,
        had_stockout: false,
        on_promo: false,
        source: 'seed' as const,
      });
    }
  }
  await adapter.upsertOrderDays(shop.id, rows);
}

async function createRollout(
  adapter: StoreAdapter,
  shop: Shop,
  name: string,
  products: Product[],
  percent: number,
): Promise<Rollout> {
  const stages = normalizeStages(undefined, products.length);
  const rollout = await adapter.createRollout({
    shop_id: shop.id,
    name,
    status: 'draft',
    change_type: 'percent',
    change_pct: percent,
    change_absolute_cents: null,
    rounding: 'none',
    horizon_days: 90,
    stages,
    current_stage: -1,
    guardrails: defaultGuardrails(),
    forecast: null,
    scheduled_start_at: null,
    started_at: null,
    ended_at: null,
    ended_reason: null,
    paused_reason: null,
    notify_emails: [],
    created_by: 'simulator',
  });

  await adapter.insertRolloutVariants(
    planRolloutVariants({
      rolloutId: rollout.id,
      shopId: shop.id,
      products,
      change: { type: 'percent', percent },
      stages,
    }),
  );
  return rollout;
}

async function main(): Promise<void> {
  const adapter = new SupabaseAdapter();
  const shop = await ensureStaticShop(adapter);
  if (shop === null) throw new Error('no static shop configured');

  const client = new AdminGraphqlClient(credentialsFromShop(shop));
  const { notifier, sent } = collectingNotifier();
  const context = { adapter, client, shop };

  const tz = shop.timezone;
  const now = new Date();
  const todayDay = today(tz, now);

  process.stdout.write(`\x1b[1mB5 acceptance — ${shop.shop_domain}\x1b[0m\n`);
  process.stdout.write(`This writes REAL prices and creates REAL orders. Everything is restored at the end.\n`);

  // Pick real, repriceable products.
  const catalog = await adapter.listProducts(shop.id, { only_repriceable: true, limit: 6 });
  const healthyProducts = catalog.items.slice(0, 3);
  const starvedProducts = catalog.items.slice(3, 6);

  if (healthyProducts.length < 3 || starvedProducts.length < 3) {
    throw new Error(`need 6 repriceable products, found ${catalog.items.length}`);
  }

  const originalPrices = new Map(
    [...healthyProducts, ...starvedProducts].map((p) => [p.variant_gid, p.price_cents]),
  );

  let healthy: Rollout | null = null;
  let starved: Rollout | null = null;

  try {
    // ================= A. the healthy rollout =========================
    step('A. Healthy rollout — should advance through every stage');

    // Time is the simulated part. The rollout starts on a day in the past and
    // each evaluation is passed a `now` matching the day being evaluated —
    // otherwise the evaluator stamps `stage_entered_at` as the real clock time,
    // "days held in this stage" is always zero, and nothing ever advances.
    const startDay = addDays(todayDay, -11);
    const at = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

    await seedBaseline(adapter, shop, healthyProducts, startDay, HEALTHY_UNITS_PER_DAY);
    healthy = await createRollout(adapter, shop, 'Simulator: healthy', healthyProducts, 10);

    const started = await startRollout(adapter, shop, healthy, { client, notifier, now: at(startDay) });
    check('stage 0 went live', started.fully_applied && started.applied > 0, `${started.applied} price(s) written`);

    // Confirm against Shopify, not against our own belief.
    const liveAfterStart = await readLivePrices(client, healthyProducts.map((p) => p.variant_gid));
    const stage0 = (await adapter.getRolloutVariants(healthy.id)).filter((v) => v.cohort_stage === 0 && !v.excluded);
    check(
      'Shopify really shows the new price',
      stage0.every((v) => liveAfterStart.get(v.variant_gid)?.priceCents === v.target_price_cents),
      `${stage0.length} variant(s) verified on the store`,
    );

    // A real order, to prove the order path end to end.
    const orderId = await placeOrder(client, [
      { variantId: (healthyProducts[0] as Product).variant_gid, quantity: 2 },
    ]);
    check('a real order was created on the dev store', orderId !== null, orderId ?? '');

    // Walk the days. Healthy demand, so every guardrail check passes.
    let current = await adapter.getRollout(healthy.id);
    for (let dayOffset = 1; dayOffset <= 12 && current !== null; dayOffset += 1) {
      const day = addDays(startDay, dayOffset);

      const liveVariants = (await adapter.getRolloutVariants(current.id)).filter(
        (v) => !v.excluded && v.cohort_stage <= current!.current_stage,
      );
      await adapter.upsertOrderDays(
        shop.id,
        liveVariants.map((v) => ({
          variant_gid: v.variant_gid,
          product_gid: v.product_gid,
          day,
          units: HEALTHY_UNITS_PER_DAY,
          orders: HEALTHY_UNITS_PER_DAY,
          gross_revenue_cents: HEALTHY_UNITS_PER_DAY * v.target_price_cents,
          discount_cents: 0,
          refund_units: 0,
          refund_cents: 0,
          net_revenue_cents: HEALTHY_UNITS_PER_DAY * v.target_price_cents,
          realized_unit_price_cents: v.target_price_cents,
          list_price_cents: v.target_price_cents,
          had_stockout: false,
          on_promo: false,
          source: 'seed' as const,
        })),
      );

      const outcome = await evaluateRollout(adapter, shop, current, {
        asOfDay: day,
        client,
        notifier,
        now: at(day),
        skipLock: true,
      });
      process.stdout.write(`    ${day}  stage ${current.current_stage}  -> ${outcome.decision}\n`);

      current = await adapter.getRollout(healthy.id);
      if (current?.status === 'completed' || current?.status === 'rolled_back') break;
    }

    check('the healthy rollout completed', current?.status === 'completed', `status=${current?.status}`);
    check('it reached the final stage', current?.current_stage === (current?.stages.length ?? 0) - 1, `stage ${current?.current_stage}`);
    check('it was never rolled back', current?.ended_reason === 'completed', String(current?.ended_reason));

    const advanceEmails = sent.filter((n) => n.kind === 'stage_advanced').length;
    check('stage-advance emails were sent', advanceEmails >= 1, `${advanceEmails} sent`);
    check('a completion email was sent', sent.some((n) => n.kind === 'completed'));

    // ================= B. the starved rollout =========================
    step('B. Starved rollout — should breach and auto-roll back');

    const startDayB = addDays(todayDay, -4);
    await seedBaseline(adapter, shop, starvedProducts, startDayB, HEALTHY_UNITS_PER_DAY);
    starved = await createRollout(adapter, shop, 'Simulator: starved', starvedProducts, 25);

    const startedB = await startRollout(adapter, shop, starved, { client, notifier, now: at(startDayB) });
    check('stage 0 went live', startedB.applied > 0, `${startedB.applied} price(s) written`);

    const baselineForCheck = new Map(
      (await adapter.getRolloutVariants(starved.id)).map((v) => [v.variant_gid, v.baseline_price_cents]),
    );

    // Zero sales, two days running: exactly what the default guardrail is for.
    let currentB = await adapter.getRollout(starved.id);
    for (let dayOffset = 1; dayOffset <= 4 && currentB !== null; dayOffset += 1) {
      const day = addDays(startDayB, dayOffset);
      const liveVariants = (await adapter.getRolloutVariants(currentB.id)).filter(
        (v) => !v.excluded && v.cohort_stage <= currentB!.current_stage,
      );
      await adapter.upsertOrderDays(
        shop.id,
        liveVariants.map((v) => ({
          variant_gid: v.variant_gid,
          product_gid: v.product_gid,
          day,
          units: 0,
          orders: 0,
          gross_revenue_cents: 0,
          discount_cents: 0,
          refund_units: 0,
          refund_cents: 0,
          net_revenue_cents: 0,
          realized_unit_price_cents: null,
          list_price_cents: v.target_price_cents,
          had_stockout: false,
          on_promo: false,
          source: 'seed' as const,
        })),
      );

      const outcome = await evaluateRollout(adapter, shop, currentB, {
        asOfDay: day,
        client,
        notifier,
        now: at(day),
        skipLock: true,
      });
      process.stdout.write(
        `    ${day}  units 0  -> ${outcome.decision}${outcome.reading?.breach ? ` (breach, streak ${outcome.reading.breach_streak})` : ''}\n`,
      );

      currentB = await adapter.getRollout(starved.id);
      if (currentB?.status === 'rolled_back') {
        check('auto-rollback verified every price against Shopify', outcome.rollback_verified === true);
        break;
      }
    }

    check('the starved rollout auto-rolled back', currentB?.status === 'rolled_back', `status=${currentB?.status}`);
    check('for the right reason', currentB?.ended_reason === 'guardrail_breach', String(currentB?.ended_reason));

    // The claim that matters: prices are actually back.
    const liveAfter = await readLivePrices(client, starvedProducts.map((p) => p.variant_gid));
    const restoredOnStore = starvedProducts.every(
      (p) => liveAfter.get(p.variant_gid)?.priceCents === baselineForCheck.get(p.variant_gid),
    );
    check('Shopify shows the original prices again', restoredOnStore);

    const verified = await verifyRollback(context, currentB as Rollout);
    check('verifyRollback found no mismatches', verified.mismatched.length === 0, `${verified.verified} verified`);

    // And the journal agrees — R18, and the manual recovery path.
    const journal = await adapter.listJournalEntries(shop.id, { rollout_id: (starved as Rollout).id });
    const rollbackEntries = journal.items.filter((e) => e.source === 'rollback');
    check('every restore is journalled', rollbackEntries.length > 0, `${rollbackEntries.length} entries`);
    check(
      'the journal records the true before-and-after',
      rollbackEntries.every((e) => e.after_price_cents === baselineForCheck.get(e.variant_gid)),
      'after_price_cents matches the captured baseline for every entry',
    );
    check('an auto-rollback email was sent', sent.some((n) => n.kind === 'auto_rollback'));

    // ================= C. idempotency =================================
    step('C. Same-day re-run is a no-op');

    const before = await adapter.listRolloutReadings((healthy as Rollout).id);
    const rerunDay = before[before.length - 1]?.day as string;
    const completed = await adapter.getRollout((healthy as Rollout).id);
    const rerun = await evaluateRollout(adapter, shop, completed as Rollout, {
      asOfDay: rerunDay,
      client,
      notifier,
      now,
      skipLock: true,
    });
    const after = await adapter.listRolloutReadings((healthy as Rollout).id);

    check('re-running the same day added no reading', before.length === after.length, `${before.length} readings`);
    check('and took no action on a finished rollout', rerun.skipped === 'not_running', String(rerun.skipped));
  } finally {
    // ================= restore, whatever happened =====================
    step('Cleanup — restoring every price this script touched');

    for (const rollout of [healthy, starved]) {
      if (rollout === null) continue;
      const fresh = await adapter.getRollout(rollout.id);
      if (fresh === null) continue;
      await rollbackRollout(context, fresh, { reason: 'Simulator cleanup.', source: 'kill_switch' });
      if (fresh.status === 'running' || fresh.status === 'paused') {
        await adapter.updateRollout(fresh.id, {
          status: 'rolled_back',
          ended_at: new Date().toISOString(),
          ended_reason: 'kill_switch',
        });
      }
    }

    const finalPrices = await readLivePrices(client, [...originalPrices.keys()]);
    const allRestored = [...originalPrices.entries()].every(
      ([gid, price]) => finalPrices.get(gid)?.priceCents === price,
    );
    check('every price is back to where it started', allRestored);
    if (!allRestored) {
      for (const [gid, price] of originalPrices) {
        const found = finalPrices.get(gid)?.priceCents;
        if (found !== price) {
          process.stdout.write(
            `    \x1b[31mMISMATCH\x1b[0m ${gid}: expected ${formatCents(price, shop.currency)}, found ${
              found === undefined ? 'missing' : formatCents(found, shop.currency)
            }\n`,
          );
        }
      }
    }
  }

  process.stdout.write(
    failures === 0
      ? '\n\x1b[32mB5 acceptance passed.\x1b[0m\n'
      : `\n\x1b[31mB5 acceptance FAILED — ${failures} check(s).\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`\nSimulator crashed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exit(1);
});
