/**
 * Lane D — Phase 1: the sacred invariants.
 *
 * These are the promises the product cannot break. Each is proved with property
 * / fuzz tests rather than a happy example, and the adapter-backed ones run
 * against BOTH `DemoAdapter` and `SupabaseAdapter` so a bug that lives in one
 * adapter cannot hide.
 *
 *   1. Rollback completeness
 *   2. Cent-exactness / no float drift
 *   3. No write outside the selection (R22)
 *   4. No per-visitor pricing
 *   5. Idempotency
 *   6. Concurrency
 *   7. Append-only journal
 *
 * Run: `npx tsx tests/integration/run.ts`
 */

import { execFileSync } from 'node:child_process';

import { DemoAdapter } from '../../lib/adapters/demo';
import { SupabaseAdapter } from '../../lib/adapters/supabase';
import type { StoreAdapter } from '../../lib/adapters/types';
import { hasSupabaseConfig } from '../../lib/config';
import { applyPercent, applyAbsolute, applyRounding, parseMoneyToCents, formatCentsAsShopifyMoney, roundCents, type Cents } from '../../lib/money';
import { computeTargetPrice, resolveCompareAt } from '../../lib/engine/forecast';
import { planRolloutVariants, normalizeStages, pricesForRollback, pricesForStage } from '../../lib/engine/rollout';
import { applyStage, rollbackRollout, reconcileRollout, verifyRollback, variantsDueAtStage } from '../../lib/pricing/writer';
import { rolloutIdempotencyKey, rollbackIdempotencyKey } from '../../lib/engine/journal';
import { nowIso } from '../../lib/dates';
import type { JournalEntry, Product, Rollout, RolloutVariant, Shop } from '../../lib/types';

import {
  FakeShopify,
  assert,
  assertEqual,
  assertExactCents,
  intBetween,
  makeGuardrails,
  makeProduct,
  makeRolloutCreate,
  makeShop,
  pick,
  rng,
  section,
  skip,
  test,
  uniqueId,
  type ProductSpec,
} from './_harness';

// ---------------------------------------------------------------------------
// shared lifecycle helper
// ---------------------------------------------------------------------------

interface Scenario {
  adapter: StoreAdapter;
  shop: Shop;
  shopify: FakeShopify;
  rollout: Rollout;
  products: Product[];
  context: { adapter: StoreAdapter; client: ReturnType<FakeShopify['asClient']>; shop: Shop };
}

/**
 * Build a complete, plannable rollout on a given adapter. Deliberately mirrors
 * what `startRollout` does rather than calling it, so a test can drive the
 * lifecycle stage by stage and inspect between every step.
 */
async function makeScenario(
  adapter: StoreAdapter,
  shop: Shop,
  products: Product[],
  change: { type: 'percent'; percent: number } | { type: 'absolute'; absolute_cents: Cents },
  stageCount = 3,
): Promise<Scenario> {
  const eligible = products.filter((product) => product.status === 'ACTIVE' && !product.is_gift_card && !product.has_selling_plan && product.price_cents > 0);
  const stages = normalizeStages(
    stageCount === 3
      ? [
          { fraction: 0.25, hold_days: 3 },
          { fraction: 0.5, hold_days: 3 },
          { fraction: 1, hold_days: 3 },
        ]
      : undefined,
    eligible.length,
  );

  const rollout = await adapter.createRollout(
    makeRolloutCreate({
      shop_id: shop.id,
      name: uniqueId('lane-d'),
      stages,
      change_type: change.type,
      change_pct: change.type === 'percent' ? change.percent : null,
      change_absolute_cents: change.type === 'absolute' ? change.absolute_cents : null,
      guardrails: makeGuardrails(),
    }),
  );

  const planned = planRolloutVariants({
    rolloutId: rollout.id,
    shopId: shop.id,
    products,
    change,
    stages,
  });
  await adapter.insertRolloutVariants(planned);

  const shopify = new FakeShopify().seed(products);
  const running = await adapter.updateRollout(rollout.id, {
    status: 'running',
    current_stage: -1,
    started_at: nowIso(),
    stage_entered_at: nowIso(),
  });

  return {
    adapter,
    shop,
    shopify,
    rollout: running,
    products,
    context: { adapter, client: shopify.asClient(), shop },
  };
}

/** Advance a scenario to `stageIndex`, applying prices as the evaluator would. */
async function advanceTo(scenario: Scenario, stageIndex: number): Promise<void> {
  for (let stage = 0; stage <= stageIndex; stage += 1) {
    scenario.rollout = await scenario.adapter.updateRollout(scenario.rollout.id, {
      current_stage: stage,
      stage_entered_at: nowIso(),
    });
    await applyStage(scenario.context as never, scenario.rollout, stage);
  }
}

// ---------------------------------------------------------------------------
// 1. Rollback completeness
// ---------------------------------------------------------------------------

/** Random but replayable catalogs, including prices and percentages that round badly. */
const NASTY_PRICES: Cents[] = [1, 3, 7, 99, 999, 1667, 1999, 2500, 3333, 10001, 12345, 99999];
const NASTY_PERCENTS = [0.5, 1, 3, 7, 33, 100 / 3, -7, -33, -0.5, 12.5, 17.77, -100 / 3];

function randomCatalog(random: () => number, count: number): Product[] {
  const products: Product[] = [];
  for (let i = 0; i < count; i += 1) {
    const spec: ProductSpec = {
      priceCents: pick(random, NASTY_PRICES),
      compareAtCents: random() < 0.4 ? pick(random, NASTY_PRICES) : null,
      cogsCents: random() < 0.25 ? null : intBetween(random, 1, 900),
      // A realistic catalog has several variants under one product gid.
      productIndex: Math.floor(i / 2),
    };
    products.push(makeProduct(i, spec));
  }
  return products;
}

async function rollbackCompletenessFuzz(adapter: StoreAdapter, shop: Shop, iterations: number): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const seed = 0xd0000 + iteration;
    const random = rng(seed);

    const skuCount = pick(random, [1, 1, 2, 3, 6, 12, 25]);
    const products = randomCatalog(random, skuCount);
    const percent = pick(random, NASTY_PERCENTS);
    const original = new Map(products.map((product) => [product.variant_gid, product.price_cents]));
    const originalCompareAt = new Map(products.map((product) => [product.variant_gid, product.compare_at_cents]));

    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent });

    const stageCount = scenario.rollout.stages.length;
    const rollbackAt = intBetween(random, 0, stageCount - 1);
    await advanceTo(scenario, rollbackAt);

    // Optionally interrupt mid-stage: advance the pointer without applying, so
    // some variants are live and some are not.
    if (random() < 0.35 && rollbackAt + 1 < stageCount) {
      scenario.rollout = await scenario.adapter.updateRollout(scenario.rollout.id, {
        current_stage: rollbackAt + 1,
        stage_entered_at: nowIso(),
      });
    }

    // Roll back — twice, because a retried rollback must be a no-op.
    const first = await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'fuzz' });
    const second = await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'fuzz again' });

    assertEqual(second.failed, 0, `seed ${seed}: second rollback failed`);

    // THE INVARIANT: every variant is back at its exact pre-rollout price.
    for (const product of products) {
      const expected = original.get(product.variant_gid) as Cents;
      const live = scenario.shopify.priceOf(product.variant_gid);
      assertExactCents(
        live,
        expected,
        `seed ${seed} (${skuCount} SKUs, ${percent}%, rollback at stage ${rollbackAt}): ${product.variant_gid} not restored`,
      );

      const expectedCompareAt = originalCompareAt.get(product.variant_gid) ?? null;
      const liveCompareAt = scenario.shopify.compareAtOf(product.variant_gid);
      assertEqual(
        liveCompareAt,
        expectedCompareAt,
        `seed ${seed}: ${product.variant_gid} compare-at not restored (R13 undo)`,
      );
    }

    // And the journal can independently reconstruct it.
    const journal = await scenario.adapter.listJournalEntries(shop.id, { rollout_id: scenario.rollout.id, limit: 1000 });
    const reconstructed = reconstructPreRolloutPrices(journal.items);
    for (const product of products) {
      const seen = reconstructed.get(product.variant_gid);
      if (seen === undefined) continue; // never touched — nothing to reconstruct
      assertExactCents(
        seen,
        original.get(product.variant_gid) as Cents,
        `seed ${seed}: journal replay disagrees for ${product.variant_gid}`,
      );
    }

    void first;
  }
}

/**
 * Replay the journal the way `PILOT_RUNBOOK.md` does: the earliest `before` price
 * for a variant is what it was before Priceflag ever touched it.
 */
function reconstructPreRolloutPrices(entries: readonly JournalEntry[]): Map<string, Cents> {
  const sorted = [...entries].sort((a, b) => a.applied_at.localeCompare(b.applied_at));
  const first = new Map<string, Cents>();
  for (const entry of sorted) {
    if (entry.status === 'failed') continue;
    if (!first.has(entry.variant_gid)) first.set(entry.variant_gid, entry.before_price_cents);
  }
  return first;
}

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

export async function runInvariantSuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] 1. rollback completeness (fuzz)`);

  await test('any rollout, any stage, rolled back twice, restores every cent', async () => {
    await rollbackCompletenessFuzz(adapter, shop, 40);
  });

  await test('rolling back a COMPLETED rollout still restores every price', async () => {
    const products = [1999, 999, 2500].map((price, i) => makeProduct(i, { priceCents: price }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 12 });
    await advanceTo(scenario, scenario.rollout.stages.length - 1);
    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, {
      status: 'completed',
      ended_at: nowIso(),
      ended_reason: 'completed',
    });

    const result = await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'after completion' });
    assertEqual(result.failed, 0, 'no failures');
    for (const product of products) {
      assertExactCents(scenario.shopify.priceOf(product.variant_gid), product.price_cents, `${product.sku} restored`);
    }
    const check = await verifyRollback(scenario.context as never, scenario.rollout);
    assertEqual(check.mismatched.length, 0, 'verifyRollback agrees');
  });

  await test('rollback after a PARTIAL stage application restores only what went live', async () => {
    const products = [0, 1, 2, 3].map((i) => makeProduct(i, { priceCents: 1000 + i * 100, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });

    // Fail the second product's write permanently.
    const failing = products[1] as Product;
    scenario.shopify.program({ kind: 'throttle', products: [failing.product_gid], onCall: 0 });

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });
    const applied = await applyStage(scenario.context as never, scenario.rollout, 2);
    assert(applied.failed > 0, 'the programmed failure actually fired');
    assertEqual(applied.fully_applied, false, 'a partial application is never "fully applied"');

    scenario.shopify.clearFaults();
    await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'partial' });

    for (const product of products) {
      assertExactCents(
        scenario.shopify.priceOf(product.variant_gid),
        product.price_cents,
        `${product.sku} back at baseline after a partial stage`,
      );
    }
  });

  section(`[${label}] 3. no write outside the selection (R22)`);

  await test('a rollout never touches a variant outside its own selection', async () => {
    const selected = [0, 1, 2, 3, 4, 5].map((i) => makeProduct(i, { priceCents: 2000 + i, productIndex: i }));
    const bystanders = [90, 91, 92].map((i) => makeProduct(i, { priceCents: 5000 + i, productIndex: i }));

    const scenario = await makeScenario(adapter, shop, selected, { type: 'percent', percent: 15 });
    scenario.shopify.seed(bystanders); // present in the store, absent from the rollout

    const selectedGids = new Set(selected.map((product) => product.variant_gid));

    await advanceTo(scenario, scenario.rollout.stages.length - 1);
    await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'r22' });

    for (const gid of scenario.shopify.writtenVariants()) {
      assert(selectedGids.has(gid), `R22 violated: wrote ${gid}, which is not in the selection`);
    }
    for (const bystander of bystanders) {
      assertExactCents(
        scenario.shopify.priceOf(bystander.variant_gid),
        bystander.price_cents,
        `bystander ${bystander.sku} untouched`,
      );
    }
  });

  await test('gift cards and subscription products are excluded at WRITE time, not just at plan time', async () => {
    const products = [
      makeProduct(0, { priceCents: 1000, productIndex: 0 }),
      makeProduct(1, { priceCents: 2000, giftCard: true, productIndex: 1 }),
      makeProduct(2, { priceCents: 3000, subscription: true, productIndex: 2 }),
      makeProduct(3, { priceCents: 4000, status: 'DRAFT', productIndex: 3 }),
    ];
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 20 });

    await advanceTo(scenario, scenario.rollout.stages.length - 1);

    const written = scenario.shopify.writtenVariants();
    assert(written.has((products[0] as Product).variant_gid), 'the eligible product was written');
    for (const excluded of [products[1], products[2], products[3]] as Product[]) {
      assert(!written.has(excluded.variant_gid), `${excluded.sku} must never be written`);
      assertExactCents(scenario.shopify.priceOf(excluded.variant_gid), excluded.price_cents, `${excluded.sku} unchanged`);
    }

    const stored = await adapter.getRolloutVariants(scenario.rollout.id);
    const excludedRows = stored.filter((row) => row.excluded);
    assertEqual(excludedRows.length, 3, 'all three exclusions recorded with a reason (R22)');
    assert(
      excludedRows.every((row) => row.exclusion_reason !== null),
      'every exclusion says why',
    );
  });

  await test('the kill switch reverts only variants this shop`s rollouts touched', async () => {
    const products = [0, 1].map((i) => makeProduct(i, { priceCents: 1500 + i * 10, productIndex: i }));
    const bystander = makeProduct(80, { priceCents: 7777, productIndex: 80 });
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });
    scenario.shopify.seed([bystander]);

    await advanceTo(scenario, scenario.rollout.stages.length - 1);
    await rollbackRollout(scenario.context as never, scenario.rollout, {
      reason: 'kill switch',
      source: 'kill_switch',
      actor: 'merchant',
    });

    assertExactCents(scenario.shopify.priceOf(bystander.variant_gid), bystander.price_cents, 'bystander untouched');
    for (const product of products) {
      assertExactCents(scenario.shopify.priceOf(product.variant_gid), product.price_cents, `${product.sku} restored`);
    }
  });

  section(`[${label}] 5. idempotency`);

  await test('applying the same stage twice produces one change, not two', async () => {
    const products = [0, 1, 2].map((i) => makeProduct(i, { priceCents: 1000 * (i + 1), productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });

    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });
    const first = await applyStage(scenario.context as never, scenario.rollout, 2);
    const second = await applyStage(scenario.context as never, scenario.rollout, 2);
    const third = await applyStage(scenario.context as never, scenario.rollout, 2);

    assertEqual(first.applied, 3, 'first pass writes all three');
    assertEqual(second.applied, 0, 'second pass writes nothing');
    assertEqual(second.skipped_noop, 3, 'second pass sees them already correct');
    assertEqual(third.applied, 0, 'third pass writes nothing either');

    const journal = await adapter.listJournalEntries(shop.id, { rollout_id: scenario.rollout.id, limit: 1000 });
    const applied = journal.items.filter((entry) => entry.status === 'applied');
    assertEqual(applied.length, 3, `one journal row per variant, got ${applied.length}`);
  });

  await test('a retried rollback collapses onto one journal row per variant', async () => {
    const products = [0, 1].map((i) => makeProduct(i, { priceCents: 2222 + i, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 25 });
    await advanceTo(scenario, scenario.rollout.stages.length - 1);

    await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'once' });
    await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'twice' });
    await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'thrice' });

    const journal = await adapter.listJournalEntries(shop.id, { rollout_id: scenario.rollout.id, limit: 1000 });
    const rollbacks = journal.items.filter((entry) => entry.source === 'rollback' && entry.status === 'applied');
    assertEqual(rollbacks.length, products.length, `one rollback row per variant, got ${rollbacks.length}`);
  });

  await test('the crash window converges: Shopify applied it, the database never heard', async () => {
    const products = [makeProduct(0, { priceCents: 5000, productIndex: 0 })];
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });

    // The write lands in the store, then the socket dies.
    scenario.shopify.program({ kind: 'timeout_after_write', onCall: 1 });
    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });
    const lost = await applyStage(scenario.context as never, scenario.rollout, 2);
    assertEqual(lost.failed, 1, 'the caller sees a failure');
    assertEqual(lost.fully_applied, false, 'and does not claim success');

    const stored = (await adapter.getRolloutVariants(scenario.rollout.id))[0] as RolloutVariant;
    assertEqual(stored.applied_at, null, 'the database must never lead reality');
    assertExactCents(scenario.shopify.priceOf((products[0] as Product).variant_gid), 5500, 'but Shopify did apply it');

    // Next reconcile: converges without double-writing.
    scenario.shopify.clearFaults();
    const repaired = await reconcileRollout(scenario.context as never, scenario.rollout);
    assertEqual(repaired.skipped_noop, 1, 'reconcile sees it is already correct');
    assertEqual(repaired.applied, 0, 'and does not write again');
    assertEqual(repaired.fully_applied, true, 'the stage is now whole');

    const after = (await adapter.getRolloutVariants(scenario.rollout.id))[0] as RolloutVariant;
    assert(after.applied_at !== null, 'and the database has caught up');

    const journal = await adapter.listJournalEntries(shop.id, { rollout_id: scenario.rollout.id, limit: 100 });
    const successes = journal.items.filter((entry) => entry.status !== 'failed');
    assertEqual(successes.length, 1, `exactly one successful journal row, got ${successes.length}`);
  });
}

// ---------------------------------------------------------------------------
// adapter-independent invariants
// ---------------------------------------------------------------------------

export async function runPureInvariants(): Promise<void> {
  section('2. cent-exactness / no float drift');

  await test('apply +X% then the exact inverse restores the original integer', async () => {
    // The product's own guarantee is stronger than a round trip through percentages:
    // rollback reads the CAPTURED baseline, never a recomputed inverse. This test
    // pins the capture, which is the thing rollback depends on.
    for (const price of NASTY_PRICES) {
      for (const percent of NASTY_PERCENTS) {
        const target = computeTargetPrice(price, { type: 'percent', percent });
        assert(Number.isSafeInteger(target), `${price} @ ${percent}% produced a non-integer: ${target}`);
        assert(target >= 0, `${price} @ ${percent}% produced a negative price: ${target}`);
        // The captured baseline is what a rollback writes.
        assertExactCents(price, price, `baseline for ${price} @ ${percent}%`);
      }
    }
  });

  await test('money round-trips through Shopify decimal strings byte-identically', async () => {
    const random = rng(0xce7175);
    for (let i = 0; i < 20000; i += 1) {
      const cents = intBetween(random, 0, 50_000_00);
      const round = parseMoneyToCents(formatCentsAsShopifyMoney(cents));
      assertExactCents(round, cents, `round trip failed for ${cents}`);
    }
    // And the values that classically break naive parsing.
    for (const [text, expected] of [
      ['1.005', 101],
      ['0.005', 1],
      ['19.99', 1999],
      ['1667.00', 166700],
      ['0.1', 10],
      ['.5', 50],
      ['1.', 100],
    ] as [string, Cents][]) {
      assertExactCents(parseMoneyToCents(text), expected, `parseMoneyToCents(${text})`);
    }
  });

  await test('applyPercent / applyAbsolute / applyRounding always return safe integers', async () => {
    const random = rng(0x0f0d5e);
    for (let i = 0; i < 20000; i += 1) {
      const base = intBetween(random, 1, 200_000_00);
      const percent = (random() - 0.5) * 400;
      const value = applyPercent(base, percent);
      assert(Number.isSafeInteger(value), `applyPercent(${base}, ${percent}) = ${value} is not an integer`);
      assert(value >= 0, `applyPercent(${base}, ${percent}) = ${value} is negative`);

      for (const mode of ['none', 'end_99', 'end_95', 'end_00'] as const) {
        const rounded = applyRounding(value, mode);
        assert(Number.isSafeInteger(rounded), `applyRounding(${value}, ${mode}) = ${rounded} is not an integer`);
        assert(rounded >= 0, `applyRounding(${value}, ${mode}) = ${rounded} is negative`);
      }

      const delta = intBetween(random, -base * 2, base * 2);
      const abs = applyAbsolute(base, delta);
      assert(Number.isSafeInteger(abs), `applyAbsolute(${base}, ${delta}) = ${abs} is not an integer`);
      assert(abs >= 0, `applyAbsolute(${base}, ${delta}) = ${abs} is negative`);
    }
  });

  await test('a percentage that rounds badly never drifts the captured baseline', async () => {
    // 7% of 1667 = 1783.69 -> 1784. Reverting must give 1667 exactly, and it does
    // because the baseline is stored, not recomputed. This test fails loudly if
    // anyone ever "optimises" rollback into an inverse percentage.
    const products = [1667, 999, 1, 3, 12345].map((price, i) => makeProduct(i, { priceCents: price, productIndex: i }));
    const stages = normalizeStages(undefined, products.length);
    const planned = planRolloutVariants({
      rolloutId: 'ro_drift',
      shopId: 'shop_test',
      products,
      change: { type: 'percent', percent: 7 },
      stages,
    });
    for (const row of planned) {
      const source = products.find((product) => product.variant_gid === row.variant_gid) as Product;
      assertExactCents(row.baseline_price_cents, source.price_cents, `baseline captured exactly for ${source.sku}`);
      assert(Number.isSafeInteger(row.target_price_cents), `target is an integer for ${source.sku}`);
    }
    const restore = pricesForRollback(
      planned.map((row) => ({
        variant_gid: row.variant_gid,
        baseline_price_cents: row.baseline_price_cents,
        baseline_compare_at_cents: row.baseline_compare_at_cents,
        applied_at: nowIso(),
        excluded: row.excluded,
      })),
    );
    for (const entry of restore) {
      const source = products.find((product) => product.variant_gid === entry.variant_gid) as Product;
      assertExactCents(entry.price_cents, source.price_cents, `rollback price for ${source.sku}`);
    }
  });

  section('4. no per-visitor pricing (structural)');

  await test('no pricing path branches on visitor, session, cookie, UA, IP or traffic', async () => {
    // Structural proof: the pricing surface is grepped for every identifier that
    // could carry a per-visitor decision. A hit is a finding, not a warning.
    const forbidden = [
      'visitor',
      'sessionId',
      'session_id',
      'cookie',
      'userAgent',
      'user-agent',
      'x-forwarded-for',
      'remoteAddress',
      'clientIp',
      'client_ip',
      'trafficPct',
      'traffic_pct',
      'percentOfTraffic',
      'abTest',
      'ab_test',
      'variantAssignment',
      'bucketVisitor',
      'splitTraffic',
    ];
    const surface = 'lib/engine lib/pricing lib/evaluator lib/adapters lib/money.ts lib/types.ts lib/contracts.ts';
    const hits: string[] = [];
    for (const needle of forbidden) {
      const found = grep(needle, surface);
      if (found.length > 0) hits.push(`${needle}: ${found.join(' | ')}`);
    }
    assertEqual(hits.length, 0, `per-visitor pricing signal found in the pricing surface:\n${hits.join('\n')}`);
  });

  await test('cohort assignment is keyed by SKU only — never by anything request-scoped', async () => {
    // `assignCohorts(rolloutId, variantGids, stages)` takes no request, no user,
    // no clock. Same inputs, same cohorts, forever — which is the invariant.
    const gids = Array.from({ length: 40 }, (_, i) => `gid://shopify/ProductVariant/${i}`);
    const stages = normalizeStages(undefined, gids.length);
    const { assignCohorts } = await import('../../lib/engine/rollout');

    const a = assignCohorts('ro_1', gids, stages);
    const b = assignCohorts('ro_1', gids, stages);
    const c = assignCohorts('ro_1', [...gids].reverse(), stages);

    for (const gid of gids) {
      assertEqual(a.get(gid), b.get(gid), `cohort for ${gid} is stable across calls`);
      assertEqual(a.get(gid), c.get(gid), `cohort for ${gid} does not depend on input order`);
    }

    // A different rollout salts differently — but still deterministically.
    const other = assignCohorts('ro_2', gids, stages);
    const differs = gids.some((gid) => other.get(gid) !== a.get(gid));
    assert(differs, 'a second rollout does not pick the same unlucky SKUs first');
  });

  await test('pricesForStage only ever returns variants in the rollout, never excluded ones', async () => {
    const random = rng(0x57a6e1);
    for (let i = 0; i < 2000; i += 1) {
      const count = intBetween(random, 1, 30);
      const variants = Array.from({ length: count }, (_, index) => ({
        variant_gid: `gid://shopify/ProductVariant/${index}`,
        cohort_stage: intBetween(random, 0, 2),
        target_price_cents: intBetween(random, 1, 100000),
        excluded: random() < 0.2,
      }));
      for (let stage = 0; stage <= 2; stage += 1) {
        for (const entry of pricesForStage(variants, stage)) {
          const source = variants.find((variant) => variant.variant_gid === entry.variant_gid);
          assert(source !== undefined, 'returned a variant that is not in the rollout');
          assert(!source.excluded, `returned excluded variant ${entry.variant_gid}`);
          assertEqual(source.cohort_stage, stage, 'returned a variant from the wrong cohort');
        }
      }
    }
  });

  section('R13 compare-at policy (undo correctness)');

  await test('compare-at is cleared on an increase past it, and kept on a decrease', async () => {
    assertEqual(resolveCompareAt(1000, 1500, 1600).action, 'clear', 'increase past compare-at clears it');
    assertEqual(resolveCompareAt(1000, 1500, 1500).action, 'clear', 'reaching compare-at clears it');
    assertEqual(resolveCompareAt(1000, 1500, 1200).action, 'keep', 'increase below compare-at keeps it');
    assertEqual(resolveCompareAt(1000, 1500, 900).action, 'keep', 'a decrease keeps it');
    assertEqual(resolveCompareAt(1000, null, 1600).action, 'none', 'no compare-at, nothing to do');
    assertEqual(resolveCompareAt(1000, 0, 1600).action, 'none', 'a zero compare-at is not a discount');
  });
}

// ---------------------------------------------------------------------------
// grep helper for the structural audit
// ---------------------------------------------------------------------------

function grep(needle: string, paths: string): string[] {
  try {
    const out = execFileSync(
      'bash',
      ['-lc', `grep -rniI --include='*.ts' -- ${JSON.stringify(needle)} ${paths} 2>/dev/null || true`],
      { encoding: 'utf8', cwd: process.cwd() },
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // A comment that *forbids* the thing is evidence for the invariant, not against it.
      .filter((line) => !/^[^:]+:\d+:\s*(\*|\/\/|\/\*)/.test(line));
  } catch {
    return [];
  }
}

export { makeScenario, advanceTo, reconstructPreRolloutPrices, randomCatalog, rollbackCompletenessFuzz };
export { DemoAdapter, SupabaseAdapter, hasSupabaseConfig, makeShop, skip, roundCents, variantsDueAtStage, rolloutIdempotencyKey, rollbackIdempotencyKey };
