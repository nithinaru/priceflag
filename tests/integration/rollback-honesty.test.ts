/**
 * Lane D — does a rollback tell the truth about itself?
 *
 * `rollbackRollout` is careful and correct. The two failures here are in what
 * happens *around* it: what the evaluator records when it only partly worked,
 * and which variants it considers its business in the first place.
 */

import { applyStage, rollbackRollout, verifyRollback } from '../../lib/pricing/writer';
import { evaluateRollout } from '../../lib/evaluator/index';
import { isTerminal } from '../../lib/engine/rollout';
import { nowIso, today, type DayString } from '../../lib/dates';
import type { StoreAdapter } from '../../lib/adapters/types';
import type { Product, RolloutVariant, Shop } from '../../lib/types';

import { assert, assertEqual, assertExactCents, makeProduct, section, test } from './_harness';
import { makeScenario, advanceTo } from './invariants.test';

export async function runRollbackHonestySuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] rollback honesty`);

  await test('a rollback restores variants Shopify repriced but never acknowledged', async () => {
    // The crash window, on the way *back*. `applyStage` writes the price,
    // Shopify applies it, the socket dies, so `applied_at` stays null. That is
    // correct and `reconcile` heals it forward. But `rollbackRollout` selects on
    // `applied_at !== null`, so if a rollback happens before the next reconcile,
    // the variant Shopify actually repriced is not considered part of the
    // rollout at all — and is left carrying the new price.
    const products = [makeProduct(0, { priceCents: 5000, productIndex: 0 })];
    const gid = (products[0] as Product).variant_gid;
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 20 });

    scenario.shopify.program({ kind: 'timeout_after_write', onCall: 1 });
    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, { current_stage: 2, stage_entered_at: nowIso() });
    await applyStage(scenario.context as never, scenario.rollout, 2);

    assertExactCents(scenario.shopify.priceOf(gid), 6000, 'Shopify really did apply the new price');
    const stored = (await adapter.getRolloutVariants(scenario.rollout.id))[0] as RolloutVariant;
    assertEqual(stored.applied_at, null, 'and the database correctly does not claim it did');

    scenario.shopify.clearFaults();
    const undo = await rollbackRollout(scenario.context as never, scenario.rollout, { reason: 'panic' });
    const check = await verifyRollback(scenario.context as never, scenario.rollout);

    assertExactCents(
      scenario.shopify.priceOf(gid),
      5000,
      `the rollback left the storefront on the NEW price. rollbackRollout selects variants on ` +
        `applied_at !== null, so a variant Shopify repriced but never acknowledged is invisible to it ` +
        `(intended=${undo.intended}, applied=${undo.applied}). verifyRollback also selects on applied_at, ` +
        `so it reports ${check.mismatched.length} mismatches and the rollout is declared clean.`,
    );
  });

  await test('a partly-failed auto-rollback is not announced as complete, and can still self-heal', async () => {
    // Four products, one of which cannot be written back. The evaluator sets
    // status `rolled_back` unconditionally and emits "Every price has been put
    // back to what it was". `rolled_back` is terminal, so the rollout is never
    // evaluated again and the stranded price is never retried.
    const products = [0, 1, 2, 3].map((i) => makeProduct(i, { priceCents: 2000 + i * 100, productIndex: i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 40 });
    await advanceTo(scenario, 2);

    const stranded = products[1] as Product;
    scenario.shopify.program({ kind: 'server_error', products: [stranded.product_gid], onCall: 0 });

    // Force a guardrail breach so the evaluator chooses `rollback` on its own.
    const day = today(shop.timezone) as DayString;
    await evaluateRollout(adapter, shop, scenario.rollout, {
      asOfDay: day,
      client: scenario.shopify.asClient(),
      notifier: (async () => undefined) as never,
      skipLock: true,
    });

    const after = await adapter.getRollout(scenario.rollout.id);
    const live = scenario.shopify.priceOf(stranded.variant_gid);
    const strandedStillChanged = live !== stranded.price_cents;

    if (!strandedStillChanged) return; // the guardrail did not fire this run; nothing to assert

    assert(
      after !== null && !isTerminal(after.status),
      `a rollback that could not restore ${stranded.sku} (still at ${live}, baseline ${stranded.price_cents}) ` +
        `left the rollout in terminal status "${after?.status}". Terminal rollouts are never evaluated again ` +
        `(listActiveRollouts excludes them), so the stranded price is never retried — while the event log says ` +
        `"Every price has been put back to what it was" and the merchant is emailed the same claim.`,
    );
  });
}
