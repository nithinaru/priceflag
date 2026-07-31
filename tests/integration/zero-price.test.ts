/**
 * Lane D — can Priceflag write a $0.00 price to a real storefront?
 *
 * `applyPercent` and `applyAbsolute` both clamp with `Math.max(0, …)`.
 * `computeTargetPrice` rejects a 0% change and a 0-cent change, but nothing
 * anywhere rejects a change that takes the price *to* zero. This file answers
 * the question end to end: plan a rollout, apply it against the fake Shopify,
 * and read back what the storefront now shows.
 */

import { applyAbsolute, applyPercent } from '../../lib/money';
import { computeTargetPrice } from '../../lib/engine/forecast';
import { normalizeStages, planRolloutVariants } from '../../lib/engine/rollout';
import { applyStage } from '../../lib/pricing/writer';
import { nowIso } from '../../lib/dates';
import type { StoreAdapter } from '../../lib/adapters/types';
import type { Shop } from '../../lib/types';

import { FakeShopify, assert, assertEqual, makeGuardrails, makeProduct, makeRolloutCreate, section, test, uniqueId } from './_harness';

export async function runZeroPriceSuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] can a $0.00 price reach the storefront?`);

  await test('the money layer clamps to zero rather than refusing', async () => {
    assertEqual(applyPercent(1000, -100), 0, 'a -100% change produces 0 cents');
    assertEqual(applyPercent(1000, -150), 0, 'a -150% change also produces 0 cents, not a negative');
    assertEqual(applyAbsolute(1000, -1000), 0, 'an absolute cut to exactly zero produces 0');
    assertEqual(applyAbsolute(1000, -5000), 0, 'an over-cut clamps to 0 rather than going negative');
  });

  await test('computeTargetPrice rejects a no-op change AND a change to zero (D-06 fixed)', async () => {
    let rejectedNoop = false;
    try {
      computeTargetPrice(1000, { type: 'percent', percent: 0 });
    } catch {
      rejectedNoop = true;
    }
    assert(rejectedNoop, 'a 0% change is correctly rejected as "not a change"');

    // The asymmetry this test was written to record — "no change" is an error,
    // "change it to free" is not — is now closed at the planning boundary.
    for (const change of [
      { type: 'percent', percent: -100 } as const,
      { type: 'percent', percent: -150 } as const,
      { type: 'absolute', absolute_cents: -1000 } as const,
      { type: 'absolute', absolute_cents: -5000 } as const,
    ]) {
      let refused: string | null = null;
      try {
        computeTargetPrice(1000, change);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      assert(
        refused !== null,
        `computeTargetPrice must refuse ${JSON.stringify(change)} rather than returning a $0.00 target price`,
      );
      assert(
        /at least/.test(refused ?? ''),
        `the refusal must say what the floor is, in merchant language. Got: ${String(refused)}`,
      );
    }

    // A one-cent price is still allowed: the floor is "not free", not "not cheap".
    assertEqual(computeTargetPrice(1000, { type: 'absolute', absolute_cents: -999 }), 1, 'a 1 cent target is allowed');
  });

  await test('a -100% rollout cannot be planned at all', async () => {
    const products = [0, 1, 2].map((i) => makeProduct(i, { priceCents: 1000 + i * 500, productIndex: i }));
    const stages = normalizeStages(undefined, products.length);

    let refused = false;
    try {
      planRolloutVariants({
        rolloutId: uniqueId('zero-plan'),
        shopId: shop.id,
        products,
        change: { type: 'percent', percent: -100 },
        stages,
      });
    } catch {
      refused = true;
    }

    assert(refused, 'planRolloutVariants must refuse a change that takes any selected price to $0.00');
  });

  await test('the writer refuses a stored $0.00 plan even when the planner is bypassed', async () => {
    // Rollouts planned before the floor existed are still in the database, and a
    // future caller could build rows by hand. The writer is the last thing
    // between a stored plan and a real storefront, so it must refuse
    // independently rather than trusting that planning already checked.
    const products = [0, 1, 2].map((i) => makeProduct(i, { priceCents: 1000 + i * 500, productIndex: i }));
    const stages = normalizeStages(undefined, products.length);

    const rollout = await adapter.createRollout(
      makeRolloutCreate({
        shop_id: shop.id,
        name: uniqueId('zero'),
        stages,
        change_type: 'percent',
        change_pct: -100,
        guardrails: makeGuardrails(),
      }),
    );

    const planned = planRolloutVariants({
      rolloutId: rollout.id,
      shopId: shop.id,
      products,
      change: { type: 'percent', percent: -50 },
      stages,
    }).map((row) => (row.excluded ? row : { ...row, target_price_cents: 0, target_compare_at_cents: null }));
    await adapter.insertRolloutVariants(planned);

    const shopify = new FakeShopify().seed(products);
    const context = { adapter, client: shopify.asClient(), shop };
    const running = await adapter.updateRollout(rollout.id, {
      status: 'running',
      current_stage: stages.length - 1,
      started_at: nowIso(),
      stage_entered_at: nowIso(),
    });
    const result = await applyStage(context as never, running, stages.length - 1);

    const live = products.map((product) => shopify.priceOf(product.variant_gid));
    assert(
      live.every((price) => price !== 0),
      `Priceflag wrote $0.00 to the storefront for ${live.filter((p) => p === 0).length}/${products.length} ` +
        `variants (applied=${result.applied}).`,
    );
    assertEqual(result.applied, 0, 'nothing was applied');
    assertEqual(result.failed, products.length, 'every $0.00 variant is reported as a failure, not silently skipped');
    assert(!result.fully_applied, 'a refused stage must not be reported as fully applied, so it cannot advance');
    assert(
      shopify.writeLog.length === 0,
      `the writer must not call Shopify at all for a $0.00 plan (${shopify.writeLog.length} write calls made)`,
    );
  });
}
