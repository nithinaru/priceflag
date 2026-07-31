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

  await test('computeTargetPrice rejects a no-op change but accepts a change to zero', async () => {
    let rejectedNoop = false;
    try {
      computeTargetPrice(1000, { type: 'percent', percent: 0 });
    } catch {
      rejectedNoop = true;
    }
    assert(rejectedNoop, 'a 0% change is correctly rejected as "not a change"');

    // The asymmetry: "no change" is an error, "change it to free" is not.
    assertEqual(
      computeTargetPrice(1000, { type: 'percent', percent: -100 }),
      0,
      'a -100% change is accepted and returns a $0.00 target price',
    );
  });

  await test('a -100% rollout writes $0.00 to the storefront', async () => {
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
      change: { type: 'percent', percent: -100 },
      stages,
    });
    await adapter.insertRolloutVariants(planned);

    assert(
      planned.every((row) => row.excluded || row.target_price_cents === 0),
      'every planned target price is $0.00',
    );

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
        `variants (applied=${result.applied}). Nothing in the money layer, the forecast, the rollout planner ` +
        `or the price writer floors a target price above zero, so a merchant who types -100 — or an absolute ` +
        `cut larger than the price — gives every selected product away for free.`,
    );
  });
}
