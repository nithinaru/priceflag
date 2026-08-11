/**
 * Lane D — can Priceflag write a $0.00 price to a real storefront?
 *
 * The low-level arithmetic deliberately clamps over-cuts to zero. The public
 * planning boundary must reject that result, and the final Shopify writer must
 * repeat the check in case corrupt persisted intent bypasses planning.
 */

import { applyAbsolute, applyPercent } from '../../lib/money';
import { computeTargetPrice } from '../../lib/engine/forecast';
import { normalizeStages, planRolloutVariants } from '../../lib/engine/rollout';
import { applyStage } from '../../lib/pricing/writer';
import { nowIso } from '../../lib/dates';
import type { StoreAdapter } from '../../lib/adapters/types';
import type { RolloutVariant, Shop } from '../../lib/types';

import {
  FakeShopify,
  assert,
  assertEqual,
  assertThrows,
  makeGuardrails,
  makeProduct,
  makeRolloutCreate,
  section,
  test,
  uniqueId,
} from './_harness';

export async function runZeroPriceSuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] can a $0.00 price reach the storefront?`);

  await test('the money layer clamps to zero rather than refusing', async () => {
    assertEqual(applyPercent(1000, -100), 0, 'a -100% change produces 0 cents');
    assertEqual(applyPercent(1000, -150), 0, 'a -150% change also produces 0 cents, not a negative');
    assertEqual(applyAbsolute(1000, -1000), 0, 'an absolute cut to exactly zero produces 0');
    assertEqual(applyAbsolute(1000, -5000), 0, 'an over-cut clamps to 0 rather than going negative');
  });

  await test('computeTargetPrice rejects any change that lands below one cent', async () => {
    await assertThrows(
      () => computeTargetPrice(1000, { type: 'percent', percent: 0 }),
      'a 0% change is rejected as a no-op',
    );
    await assertThrows(
      () => computeTargetPrice(1000, { type: 'percent', percent: -100 }),
      'a -100% change must be rejected before planning',
    );
    await assertThrows(
      () => computeTargetPrice(1000, { type: 'absolute', absolute_cents: -5000 }),
      'an absolute over-cut must be rejected before planning',
    );
  });

  await test('planning, storage, and the writer all enforce the included-variant minimum honestly', async () => {
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

    await assertThrows(
      () =>
        planRolloutVariants({
          rolloutId: rollout.id,
          shopId: shop.id,
          products,
          change: { type: 'percent', percent: -100 },
          stages,
        }),
      'rollout planning must reject a free target',
    );

    // Simulate a corrupt persisted row or a caller that bypassed planning. The
    // final Shopify boundary must still refuse the write.
    const planned = planRolloutVariants({
      rolloutId: rollout.id,
      shopId: shop.id,
      products,
      change: { type: 'percent', percent: 10 },
      stages,
    });
    await adapter.insertRolloutVariants(planned);
    const stored = await adapter.getRolloutVariants(rollout.id);

    await assertThrows(
      () => adapter.updateRolloutVariant((stored[0] as RolloutVariant).id, { target_price_cents: 0 }),
      'the adapter must reject an included zero-price target at rest',
    );

    // The final boundary still treats persisted state as untrusted. Inject a
    // corrupt read without weakening either adapter's real storage invariant.
    const corruptAdapter = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'getRolloutVariants') {
          return async (rolloutId: string): Promise<RolloutVariant[]> => {
            const rows = await target.getRolloutVariants(rolloutId);
            return rows.map((row) => ({ ...row, excluded: false, target_price_cents: 0 }));
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const shopify = new FakeShopify().seed(products);
    const context = { adapter: corruptAdapter, client: shopify.asClient(), shop };
    const running = await adapter.updateRollout(rollout.id, {
      status: 'running',
      current_stage: stages.length - 1,
      started_at: nowIso(),
      stage_entered_at: nowIso(),
    });
    const result = await applyStage(context as never, running, stages.length - 1);

    const live = products.map((product) => shopify.priceOf(product.variant_gid));
    assert(
      live.every((price) => price !== null && price >= 1),
      'the storefront must retain valid non-zero prices',
    );
    assertEqual(result.applied, 0, 'the writer applies no corrupt zero-price intent');
    assertEqual(result.failed, products.length, 'every corrupt target is reported as failed');
    assertEqual(shopify.writeLog.length, 0, 'no Shopify mutation is attempted');

    // A zero-price Shopify variant is valid historical/input data when excluded;
    // the database constraint must not make legitimate catalog sync impossible.
    const excluded = await adapter.updateRolloutVariant((stored[0] as RolloutVariant).id, {
      excluded: true,
      exclusion_reason: 'zero_price',
      target_price_cents: 0,
    });
    assertEqual(excluded.target_price_cents, 0, 'excluded zero-price target is retained honestly');
    assertEqual(excluded.excluded, true, 'zero-price row remains excluded from every write');
  });
}
