/**
 * The price writer. The most safety-critical code in the product.
 *
 * ## Can a throttled or partly-failed write leave a rollout half-applied?
 *
 * Physically, yes — and no API Shopify offers can prevent it. A stage touching
 * twelve products is twelve `productVariantsBulkUpdate` calls; the eighth can be
 * throttled after seven have landed. So the guarantee is not "this cannot happen"
 * but **"this cannot persist"**:
 *
 *   1. **Within a product**, `allowPartialUpdates: false` makes Shopify apply all
 *      variants in the call or none.
 *   2. **The database records intent, Shopify records fact.** `rollout_variants`
 *      holds `target_price_cents` (intent) and `applied_at` (fact, stamped only
 *      after Shopify confirms). The set of variants that *should* be live but are
 *      not is therefore always computable.
 *   3. **Every write is compare-before-write.** A variant already at its target is
 *      journalled `skipped_noop` and stamped applied. Re-running is free.
 *   4. **`reconcile()` re-applies the difference**, and the evaluator runs it
 *      before every decision.
 *   5. **A stage never advances while the current one is not fully applied.**
 *      `fully_applied` gates it. This is what stops a partial failure compounding
 *      into a bigger one.
 *
 * ### The crash window, enumerated
 *
 * The dangerous gap is: Shopify accepted the write, then the process died before
 * the database recorded it. On the next reconcile, the live price already equals
 * the target, so it takes the `skipped_noop` path, stamps `applied_at`, and the
 * journal insert is de-duplicated by `idempotency_key`. It converges, and it does
 * not double-write or double-journal.
 *
 * The reverse gap — database says applied, Shopify never got it — cannot happen,
 * because `applied_at` is only ever written after Shopify has confirmed.
 */

import type { StoreAdapter } from '../adapters/types';
import { nowIso } from '../dates';
import type { Cents } from '../money';
import { MIN_PRICE_CENTS, formatCents } from '../money';
import type { JournalEntryCreate, Rollout, RolloutVariant, Shop } from '../types';
import { buildJournalEntry, rollbackIdempotencyKey, rolloutIdempotencyKey } from '../engine/journal';
import { assertWritable } from '../shopify/credentials';
import { ShopifyApiError, type AdminGraphqlClient } from '../shopify/client';
import { readLivePrices, writeProductVariantPrices, type LivePrice, type PriceWrite } from '../shopify/prices';

export interface WriterContext {
  adapter: StoreAdapter;
  client: AdminGraphqlClient;
  shop: Shop;
}

export interface WriteFailure {
  variant_gid: string;
  message: string;
}

export interface ExternalChange {
  variant_gid: string;
  expected_cents: Cents;
  found_cents: Cents;
}

export interface ApplyResult {
  intended: number;
  applied: number;
  skipped_noop: number;
  failed: number;
  failures: WriteFailure[];
  /** Variants whose live price is neither the baseline nor our target (R4). */
  external_changes: ExternalChange[];
  /** The gate. A stage must never advance unless this is true. */
  fully_applied: boolean;
}

function emptyResult(): ApplyResult {
  return {
    intended: 0,
    applied: 0,
    skipped_noop: 0,
    failed: 0,
    failures: [],
    external_changes: [],
    fully_applied: true,
  };
}

/** Variants that should carry the new price once `stageIndex` is live. */
export function variantsDueAtStage(variants: readonly RolloutVariant[], stageIndex: number): RolloutVariant[] {
  return variants.filter((variant) => !variant.excluded && variant.cohort_stage <= stageIndex);
}

/**
 * Bring every variant due at `stageIndex` to its target price.
 *
 * Safe to call repeatedly. Calling it after a partial failure is exactly how the
 * partial failure is repaired, so the evaluator calls it unconditionally rather
 * than only when it believes something is wrong.
 */
export async function applyStage(
  context: WriterContext,
  rollout: Rollout,
  stageIndex: number,
): Promise<ApplyResult> {
  // R21: the kill switch is checked at the writer, not only in the UI, so no
  // future caller can route around it.
  assertWritable(context.shop);

  const all = await context.adapter.getRolloutVariants(rollout.id);
  const due = variantsDueAtStage(all, stageIndex);
  if (due.length === 0) return emptyResult();

  const live = await readLivePrices(context.client, due.map((variant) => variant.variant_gid));

  const result = emptyResult();
  result.intended = due.length;

  const journal: JournalEntryCreate[] = [];
  const byProduct = new Map<string, { variant: RolloutVariant; write: PriceWrite }[]>();
  const stamped: { id: string; price: Cents }[] = [];

  for (const variant of due) {
    const current = live.get(variant.variant_gid);

    if (current === undefined) {
      // The variant has been deleted in Shopify. Nothing to write, and pretending
      // otherwise would leave a rollout permanently unable to complete.
      result.failed += 1;
      result.failures.push({
        variant_gid: variant.variant_gid,
        message: 'This product variant no longer exists in Shopify, so its price could not be changed.',
      });
      continue;
    }

    if (variant.target_price_cents < MIN_PRICE_CENTS) {
      // D-06, defence in depth. `computeTargetPrice` refuses this at planning
      // time, but a rollout planned before that check existed is still in the
      // database, and the writer is the last thing between a stored plan and a
      // real storefront. Refusing here fails the stage rather than the product.
      result.failed += 1;
      result.failures.push({
        variant_gid: variant.variant_gid,
        message:
          `This rollout would set the price to ${formatCents(variant.target_price_cents)}, and Priceflag will ` +
          `not put a price below ${formatCents(MIN_PRICE_CENTS)} on your store. The price was left unchanged.`,
      });
      continue;
    }

    if (current.priceCents === variant.target_price_cents) {
      // Already correct. Either we wrote it and lost the acknowledgement, or the
      // merchant set it by hand. Record it and move on — this is the branch that
      // closes the crash window.
      result.skipped_noop += 1;
      if (variant.applied_at === null) {
        journal.push(
          buildJournalEntry(
            {
              variant_gid: variant.variant_gid,
              product_gid: variant.product_gid,
              title: variant.title,
              sku: variant.sku,
              before_price_cents: current.priceCents,
              after_price_cents: variant.target_price_cents,
              before_compare_at_cents: current.compareAtCents,
              after_compare_at_cents: variant.target_compare_at_cents,
              currency: context.shop.currency,
            },
            {
              source: 'rollout',
              actor: 'priceflag',
              rollout_id: rollout.id,
              rollout_name: rollout.name,
              stage_index: stageIndex,
              status: 'skipped_noop',
              idempotency_key: rolloutIdempotencyKey(
                rollout.id,
                variant.cohort_stage,
                variant.variant_gid,
                variant.target_price_cents,
              ),
            },
          ),
        );
        stamped.push({ id: variant.id, price: variant.target_price_cents });
      }
      continue;
    }

    // Somebody else moved this price. Not ours to overwrite silently (R4): the
    // caller pauses the rollout and asks, rather than mis-attributing the demand
    // shift that follows.
    if (variant.applied_at === null && current.priceCents !== variant.baseline_price_cents) {
      result.external_changes.push({
        variant_gid: variant.variant_gid,
        expected_cents: variant.baseline_price_cents,
        found_cents: current.priceCents,
      });
      continue;
    }

    const bucket = byProduct.get(variant.product_gid) ?? [];
    bucket.push({
      variant,
      write: {
        variantGid: variant.variant_gid,
        priceCents: variant.target_price_cents,
        compareAtCents: variant.compare_at_action === 'none' ? undefined : variant.target_compare_at_cents,
      },
    });
    byProduct.set(variant.product_gid, bucket);
  }

  // --- the writes, one atomic call per product ------------------------------
  for (const [productGid, items] of byProduct) {
    try {
      await writeProductVariantPrices(
        context.client,
        productGid,
        items.map((item) => item.write),
      );

      for (const { variant } of items) {
        const before = live.get(variant.variant_gid) as LivePrice;
        result.applied += 1;
        journal.push(
          buildJournalEntry(
            {
              variant_gid: variant.variant_gid,
              product_gid: variant.product_gid,
              title: variant.title,
              sku: variant.sku,
              before_price_cents: before.priceCents,
              after_price_cents: variant.target_price_cents,
              before_compare_at_cents: before.compareAtCents,
              after_compare_at_cents: variant.target_compare_at_cents,
              currency: context.shop.currency,
            },
            {
              source: 'rollout',
              actor: 'priceflag',
              rollout_id: rollout.id,
              rollout_name: rollout.name,
              stage_index: stageIndex,
              idempotency_key: rolloutIdempotencyKey(
                rollout.id,
                variant.cohort_stage,
                variant.variant_gid,
                variant.target_price_cents,
              ),
            },
          ),
        );
        stamped.push({ id: variant.id, price: variant.target_price_cents });
      }
    } catch (cause) {
      // This product did not change at all (allowPartialUpdates: false). Leave
      // `applied_at` null so the next reconcile retries it, and journal the
      // failure so it is visible rather than merely logged.
      const message = cause instanceof ShopifyApiError ? cause.message : String(cause);
      for (const { variant } of items) {
        result.failed += 1;
        result.failures.push({ variant_gid: variant.variant_gid, message });
        const before = live.get(variant.variant_gid) as LivePrice;
        journal.push(
          buildJournalEntry(
            {
              variant_gid: variant.variant_gid,
              product_gid: variant.product_gid,
              title: variant.title,
              sku: variant.sku,
              before_price_cents: before.priceCents,
              after_price_cents: variant.target_price_cents,
              before_compare_at_cents: before.compareAtCents,
              after_compare_at_cents: variant.target_compare_at_cents,
              currency: context.shop.currency,
            },
            {
              source: 'rollout',
              actor: 'priceflag',
              rollout_id: rollout.id,
              rollout_name: rollout.name,
              stage_index: stageIndex,
              status: 'failed',
              error: message,
              // A failed attempt takes no idempotency key: the retry must be
              // allowed to write, and its own success is what gets de-duplicated.
              idempotency_key: null,
            },
          ),
        );
      }
    }
  }

  if (journal.length > 0) await context.adapter.appendJournalEntries(context.shop.id, journal);

  // Stamped only after Shopify confirmed. The database can lag reality; it must
  // never lead it.
  const appliedAt = nowIso();
  for (const item of stamped) {
    await context.adapter.updateRolloutVariant(item.id, {
      applied_price_cents: item.price,
      applied_at: appliedAt,
      reverted_at: null,
    });
  }

  result.fully_applied = result.failed === 0 && result.external_changes.length === 0;
  return result;
}

/**
 * Repair drift for the currently live stage.
 *
 * Called before every evaluator decision, not only when something looks wrong —
 * the whole point is that we do not know a write was lost until we look.
 */
export async function reconcileRollout(context: WriterContext, rollout: Rollout): Promise<ApplyResult> {
  if (rollout.current_stage < 0) return emptyResult();
  return applyStage(context, rollout, rollout.current_stage);
}

/**
 * Restore every price this rollout changed, from the baselines captured at
 * creation (R12/R17).
 *
 * Idempotent, and deliberately tolerant: a variant already back at its baseline
 * is still stamped `reverted_at`, so a partly-completed rollback finishes rather
 * than restarting.
 */
export async function rollbackRollout(
  context: WriterContext,
  rollout: Rollout,
  options: { reason: string; source?: 'rollback' | 'kill_switch'; actor?: 'priceflag' | 'merchant' } = {
    reason: 'Rolled back.',
  },
): Promise<ApplyResult> {
  const source = options.source ?? 'rollback';
  // A kill switch must work *because* the store is in a bad state, so it is the
  // one writer that does not check the kill-switch flag.
  if (source !== 'kill_switch') assertWritable(context.shop);

  const all = await context.adapter.getRolloutVariants(rollout.id);
  const touched = all.filter((variant) => !variant.excluded && variant.applied_at !== null);
  if (touched.length === 0) return emptyResult();

  const live = await readLivePrices(context.client, touched.map((variant) => variant.variant_gid));

  const result = emptyResult();
  result.intended = touched.length;

  const journal: JournalEntryCreate[] = [];
  const byProduct = new Map<string, { variant: RolloutVariant; write: PriceWrite }[]>();
  const reverted: string[] = [];

  for (const variant of touched) {
    const current = live.get(variant.variant_gid);
    if (current === undefined) {
      result.failed += 1;
      result.failures.push({
        variant_gid: variant.variant_gid,
        message: 'This variant no longer exists in Shopify, so its original price could not be restored.',
      });
      continue;
    }

    if (current.priceCents === variant.baseline_price_cents) {
      result.skipped_noop += 1;
      if (variant.reverted_at === null) reverted.push(variant.id);
      continue;
    }

    const bucket = byProduct.get(variant.product_gid) ?? [];
    bucket.push({
      variant,
      write: {
        variantGid: variant.variant_gid,
        priceCents: variant.baseline_price_cents,
        // Restore compare-at exactly as it was, including having been absent.
        compareAtCents: variant.baseline_compare_at_cents,
      },
    });
    byProduct.set(variant.product_gid, bucket);
  }

  for (const [productGid, items] of byProduct) {
    try {
      await writeProductVariantPrices(
        context.client,
        productGid,
        items.map((item) => item.write),
      );
      for (const { variant } of items) {
        const before = live.get(variant.variant_gid) as LivePrice;
        result.applied += 1;
        reverted.push(variant.id);
        journal.push(
          buildJournalEntry(
            {
              variant_gid: variant.variant_gid,
              product_gid: variant.product_gid,
              title: variant.title,
              sku: variant.sku,
              before_price_cents: before.priceCents,
              after_price_cents: variant.baseline_price_cents,
              before_compare_at_cents: before.compareAtCents,
              after_compare_at_cents: variant.baseline_compare_at_cents,
              currency: context.shop.currency,
            },
            {
              source,
              actor: options.actor ?? 'priceflag',
              rollout_id: rollout.id,
              rollout_name: rollout.name,
              reason: options.reason,
              idempotency_key: rollbackIdempotencyKey(
                rollout.id,
                variant.variant_gid,
                variant.baseline_price_cents,
              ),
            },
          ),
        );
      }
    } catch (cause) {
      const message = cause instanceof ShopifyApiError ? cause.message : String(cause);
      for (const { variant } of items) {
        result.failed += 1;
        result.failures.push({ variant_gid: variant.variant_gid, message });
      }
    }
  }

  if (journal.length > 0) await context.adapter.appendJournalEntries(context.shop.id, journal);

  const revertedAt = nowIso();
  for (const id of reverted) {
    await context.adapter.updateRolloutVariant(id, { reverted_at: revertedAt });
  }

  result.fully_applied = result.failed === 0;
  return result;
}

/**
 * Verify against Shopify that a rollback actually restored every price (R17).
 *
 * The journal says what we believe; this asks the store. "100% of auto-rollbacks
 * restore correct prices" is a launch metric, and a metric nobody checks against
 * the source of truth is a hope.
 */
export async function verifyRollback(
  context: WriterContext,
  rollout: Rollout,
): Promise<{ verified: number; mismatched: { variant_gid: string; expected: Cents; found: Cents | null }[] }> {
  const all = await context.adapter.getRolloutVariants(rollout.id);
  const touched = all.filter((variant) => !variant.excluded && variant.applied_at !== null);
  const live = await readLivePrices(context.client, touched.map((variant) => variant.variant_gid));

  const mismatched: { variant_gid: string; expected: Cents; found: Cents | null }[] = [];
  let verified = 0;

  for (const variant of touched) {
    const current = live.get(variant.variant_gid);
    if (current === undefined) {
      mismatched.push({ variant_gid: variant.variant_gid, expected: variant.baseline_price_cents, found: null });
      continue;
    }
    if (current.priceCents === variant.baseline_price_cents) verified += 1;
    else {
      mismatched.push({
        variant_gid: variant.variant_gid,
        expected: variant.baseline_price_cents,
        found: current.priceCents,
      });
    }
  }

  return { verified, mismatched };
}

/** Merchant-facing summary of a write pass, for the event log (R25). */
export function describeApply(result: ApplyResult, currency = 'USD'): string {
  if (result.intended === 0) return 'No prices needed changing.';
  if (result.external_changes.length > 0) {
    const first = result.external_changes[0] as ExternalChange;
    return (
      `Paused: ${result.external_changes.length} product${result.external_changes.length === 1 ? "'s" : "s'"} price ` +
      `changed outside Priceflag (one was ${formatCents(first.expected_cents, currency)}, now ` +
      `${formatCents(first.found_cents, currency)}). Nothing was overwritten.`
    );
  }
  if (result.failed > 0) {
    return `Changed ${result.applied} price${result.applied === 1 ? '' : 's'}, but ${result.failed} could not be changed. We will retry automatically.`;
  }
  if (result.applied === 0) return `All ${result.skipped_noop} prices were already correct.`;
  return `Changed ${result.applied} price${result.applied === 1 ? '' : 's'}.`;
}
