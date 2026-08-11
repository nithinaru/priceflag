/**
 * `POST /api/kill-switch` — undo everything Priceflag ever changed (R21).
 *
 * One action, store-wide. It engages the switch first and reverts second, so that
 * even if the reverting half fails partway, nothing can write a new price in the
 * meantime.
 *
 * `DELETE` releases it. Releasing does not re-apply anything: rollouts stay ended,
 * because a merchant who pulled this cord wants the prices back, not the change
 * resumed behind their back.
 */

import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import type { StoreAdapter } from '@/lib/adapters/types';
import {
  MerchantApiError,
  merchantErrorResponse,
  readJson,
  resolveAuthenticatedShop,
} from '@/lib/api/merchant';
import { rollbackInProgressReason } from '@/lib/engine/rollout';
import { rollbackRollout, verifyRollback } from '@/lib/pricing/writer';
import { AdminGraphqlClient } from '@/lib/shopify/client';
import { credentialsFromShop } from '@/lib/shopify/credentials';
import { readLivePrices } from '@/lib/shopify/prices';
import { notify } from '@/lib/notify';
import type { Rollout, RolloutVariant } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface KillSwitchIssue {
  rollout_id: string;
  code: 'rollout_busy' | 'rollback_failed' | 'rollback_incomplete';
  message: string;
  variant_gids: string[];
  unverified: { variant_gid: string; expected: number; found: number | null }[];
}

interface StorewideMismatch {
  variant_gid: string;
  expected: number;
  found: number | null;
  expected_compare_at: number | null;
  found_compare_at: number | null;
}

/** Verify each chain's earliest frozen baseline using durable rollout chronology. */
async function verifyStorewideRestoration(
  client: AdminGraphqlClient,
  rollouts: readonly Rollout[],
  allVariants: readonly RolloutVariant[],
): Promise<{ verified: number; mismatched: StorewideMismatch[]; ambiguous: string[] }> {
  const rolloutById = new Map(rollouts.map((rollout) => [rollout.id, rollout]));
  const compareChronology = (a: Rollout, b: Rollout): number =>
    a.created_at.localeCompare(b.created_at) ||
    (a.creation_sequence !== undefined && b.creation_sequence !== undefined
      ? a.creation_sequence - b.creation_sequence
      : 0);
  const byVariant = new Map<string, RolloutVariant[]>();
  for (const variant of allVariants) {
    if (variant.excluded) continue;
    const rollout = rolloutById.get(variant.rollout_id);
    if (rollout === undefined || rollout.status === 'cancelled') continue;
    const rows = byVariant.get(variant.variant_gid) ?? [];
    rows.push(variant);
    byVariant.set(variant.variant_gid, rows);
  }

  const expected = new Map<
    string,
    { price: number; compareAt: number | null; compareAtManaged: boolean }
  >();
  const ambiguous: string[] = [];
  for (const [variantGid, rows] of byVariant) {
    const eligible = rows
      .filter((row) => {
        const rollout = rolloutById.get(row.rollout_id);
        return rollout !== undefined && rollout.status !== 'draft' && rollout.status !== 'cancelled';
      })
      .sort((a, b) => {
        const rolloutA = rolloutById.get(a.rollout_id) as Rollout;
        const rolloutB = rolloutById.get(b.rollout_id) as Rollout;
        return compareChronology(rolloutA, rolloutB);
      });
    const first = eligible[0];
    if (first === undefined) continue;
    const firstRollout = rolloutById.get(first.rollout_id) as Rollout;
    const tiedRoots = eligible.filter(
      (row) => compareChronology(rolloutById.get(row.rollout_id) as Rollout, firstRollout) === 0,
    );
    const rootPrices = new Set(tiedRoots.map((row) => row.baseline_price_cents));
    if (rootPrices.size !== 1) {
      ambiguous.push(variantGid);
      continue;
    }
    const rootPrice = first.baseline_price_cents;
    const managedRootRows = tiedRoots.filter((row) => row.compare_at_action !== 'none');
    const managedCompareValues = new Set(
      managedRootRows.map((row) => row.baseline_compare_at_cents),
    );
    if (managedCompareValues.size > 1) {
      ambiguous.push(variantGid);
      continue;
    }
    expected.set(variantGid, {
      price: rootPrice,
      compareAt: managedRootRows[0]?.baseline_compare_at_cents ?? null,
      compareAtManaged: managedRootRows.length > 0,
    });
  }

  const live = await readLivePrices(client, [...expected.keys()]);
  const mismatched: StorewideMismatch[] = [];
  let verified = 0;
  for (const [variantGid, root] of expected) {
    const current = live.get(variantGid);
    if (
      current?.priceCents === root.price &&
      (!root.compareAtManaged || current.compareAtCents === root.compareAt)
    ) {
      verified += 1;
      continue;
    }
    mismatched.push({
      variant_gid: variantGid,
      expected: root.price,
      found: current?.priceCents ?? null,
      expected_compare_at: root.compareAtManaged ? root.compareAt : null,
      found_compare_at: current?.compareAtCents ?? null,
    });
  }
  return { verified, mismatched, ambiguous };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const raw = await readJson(request);
    if (typeof raw !== 'object' || raw === null || (raw as { confirm?: unknown }).confirm !== true) {
      throw new MerchantApiError(
        'confirmation_required',
        'Confirm that you want to put every Priceflag price back.',
        400,
      );
    }
    const body = raw as { confirm: true; reason?: unknown };
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim().slice(0, 500)
        : 'Store-wide undo requested by the merchant.';

    // Engage FIRST. If the revert below fails halfway, no writer can add to the
    // problem while a human works out what happened.
    const engaged = await adapter.updateShop(shop.id, {
      kill_switch_engaged_at: new Date().toISOString(),
      kill_switch_reason: reason,
    });

    const client = new AdminGraphqlClient(credentialsFromShop(engaged));
    const context = { adapter, client, shop: engaged };

    let restored = 0;
    const initial = [...await adapter.listRollouts(shop.id)].sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) ||
        ((b.creation_sequence ?? Number.NEGATIVE_INFINITY) -
          (a.creation_sequence ?? Number.NEGATIVE_INFINITY)) ||
        b.id.localeCompare(a.id),
    );
    const allVariants = await adapter.listRolloutVariantsForShop(shop.id);
    const variantsByRollout = new Map<string, RolloutVariant[]>();
    for (const variant of allVariants) {
      const rows = variantsByRollout.get(variant.rollout_id) ?? [];
      rows.push(variant);
      variantsByRollout.set(variant.rollout_id, rows);
    }
    const pending = new Set(
      initial
        .filter((rollout) => rollout.status !== 'cancelled' && rollout.status !== 'rolled_back')
        .map((rollout) => rollout.id),
    );
    const issues = new Map<string, KillSwitchIssue>();
    const chainDepth = new Map<string, number>();
    const variantOwner = new Map<string, string>();
    for (const rollout of initial) {
      for (const variant of variantsByRollout.get(rollout.id) ?? []) {
        if (variant.excluded) continue;
        chainDepth.set(variant.variant_gid, (chainDepth.get(variant.variant_gid) ?? 0) + 1);
        if (!variantOwner.has(variant.variant_gid)) variantOwner.set(variant.variant_gid, rollout.id);
      }
    }
    const maxPasses = Math.max(1, ...chainDepth.values());
    let latestRootCheck = await verifyStorewideRestoration(client, initial, allVariants);
    const chronologyPreflight = latestRootCheck;
    if (chronologyPreflight.ambiguous.length > 0) {
      // Never guess between two different baselines captured at the same
      // durable timestamp. Keep writes disabled and require human verification.
      for (const variantGid of chronologyPreflight.ambiguous) {
        const owner = variantOwner.get(variantGid) ?? initial[0]?.id ?? 'storewide';
        issues.set(`storewide:${variantGid}`, {
          rollout_id: owner,
          code: 'rollback_incomplete',
          message: 'The original price chain has tied chronology and needs manual verification.',
          variant_gids: [variantGid],
          unverified: [],
        });
      }
      pending.clear();
    }

    const terminalizePendingAtRoot = async (): Promise<void> => {
      for (const rolloutId of [...pending]) {
        try {
          const locked = await adapter.withRolloutLock(rolloutId, async () => {
            const fresh = await adapter.getRollout(rolloutId);
            if (fresh === null || fresh.shop_id !== shop.id) return false;
            if (fresh.status === 'cancelled' || fresh.status === 'rolled_back') return true;
            const endedAt = new Date().toISOString();
            await adapter.updateRollout(fresh.id, fresh.status === 'draft'
              ? {
                  status: 'cancelled',
                  ended_at: endedAt,
                  ended_reason: 'kill_switch',
                  paused_reason: null,
                }
              : {
                  status: 'rolled_back',
                  ended_at: endedAt,
                  ended_reason: 'kill_switch',
                  paused_reason: null,
                });
            await adapter.appendRolloutEvent({
              rollout_id: fresh.id,
              shop_id: shop.id,
              type: 'kill_switch',
              actor: 'merchant',
              message: fresh.status === 'draft'
                ? 'Store-wide undo cancelled this draft before any Shopify price changed.'
                : 'Store-wide undo verified this chained price at its original pre-Priceflag root; no intermediate price was re-applied.',
              data: { superseded_chain_link: fresh.status !== 'draft', root_verified: true },
            });
            return true;
          });
          if (locked.acquired && locked.result === true) {
            pending.delete(rolloutId);
            issues.delete(rolloutId);
          } else if (!locked.acquired) {
            const variants = variantsByRollout.get(rolloutId) ?? [];
            issues.set(rolloutId, {
              rollout_id: rolloutId,
              code: 'rollout_busy',
              message: 'A writer still holds this rollout lease. The original price is verified; retry to finish the database record.',
              variant_gids: variants.filter((variant) => !variant.excluded).map((variant) => variant.variant_gid),
              unverified: [],
            });
          }
        } catch (cause) {
          const variants = variantsByRollout.get(rolloutId) ?? [];
          issues.set(rolloutId, {
            rollout_id: rolloutId,
            code: 'rollback_failed',
            message: cause instanceof Error ? cause.message : String(cause),
            variant_gids: variants.filter((variant) => !variant.excluded).map((variant) => variant.variant_gid),
            unverified: [],
          });
        }
      }
    };

    let rootReached =
      chronologyPreflight.ambiguous.length === 0 && chronologyPreflight.mismatched.length === 0;
    if (rootReached) await terminalizePendingAtRoot();

    // Order cannot be inferred when two historical rows share a timestamp. Walk
    // to a fixed point instead: in 1000 -> 1100 -> 1210, restoring either link
    // exposes the target needed by the next pass. Each successful pass removes at
    // least one rollout, so rollout-count passes are a strict upper bound.
    for (let pass = 0; !rootReached && pending.size > 0 && pass < maxPasses; pass += 1) {
      let passMayHaveChangedStorefront = false;
      for (const rolloutId of [...pending]) {
        try {
          const locked = await adapter.withRolloutLock(rolloutId, async () => {
            const fresh = await adapter.getRollout(rolloutId);
            if (fresh === null || fresh.shop_id !== shop.id) throw new Error('rollout disappeared while undoing');

            // A retry must not reinterpret an intermediate baseline after an
            // older chain link has already moved the store to the original root.
            if (fresh.status === 'cancelled' || fresh.status === 'rolled_back') {
              return { resolved: true, applied: 0, issue: null as KillSwitchIssue | null };
            }

            if (fresh.status === 'draft') {
              const stoppedAt = new Date().toISOString();
              await adapter.updateRollout(fresh.id, {
                status: 'cancelled',
                ended_at: stoppedAt,
                ended_reason: 'kill_switch',
                paused_reason: null,
              });
              await adapter.appendRolloutEvent({
                rollout_id: fresh.id,
                shop_id: shop.id,
                type: 'kill_switch',
                actor: 'merchant',
                message: 'Store-wide undo cancelled this draft before any Shopify price changed.',
                data: { previous_status: 'draft', restored: 0 },
                at: stoppedAt,
              });
              return { resolved: true, applied: 0, issue: null as KillSwitchIssue | null };
            }

            await adapter.updateRollout(fresh.id, {
              status: 'paused',
              paused_reason: rollbackInProgressReason('kill_switch'),
              ended_at: null,
              ended_reason: null,
            });

            const undo = await rollbackRollout(context, fresh, {
              reason: 'Store-wide undo (kill switch).',
              source: 'kill_switch',
              actor: 'merchant',
            });
            const check = await verifyRollback(context, fresh);
            const rolloutRestored =
              undo.intended === 0 ||
              (undo.fully_applied && undo.external_changes.length === 0 && check.mismatched.length === 0);

            await adapter.updateRollout(
              fresh.id,
              rolloutRestored
                ? {
                    status: 'rolled_back',
                    ended_at: new Date().toISOString(),
                    ended_reason: 'kill_switch',
                    paused_reason: null,
                  }
                : {
                    status: 'paused',
                    ended_at: null,
                    ended_reason: null,
                    paused_reason: 'The store-wide undo needs attention: one or more live prices were not restored.',
                  },
            );
            await adapter.appendRolloutEvent({
              rollout_id: fresh.id,
              shop_id: shop.id,
              type: 'kill_switch',
              actor: 'merchant',
              message: rolloutRestored
                ? 'Store-wide undo: every price this rollout changed was verified at its frozen baseline.'
                : 'Store-wide undo is still working through chained prices or needs attention.',
              data: {
                pass: pass + 1,
                restored: check.verified,
                failed: undo.failed,
                external_changes: undo.external_changes,
                unverified: check.mismatched,
              },
            });

            const variantGids = new Set([
              ...undo.failures.map((failure) => failure.variant_gid),
              ...undo.external_changes.map((change) => change.variant_gid),
              ...check.mismatched.map((mismatch) => mismatch.variant_gid),
            ]);
            return {
              resolved: rolloutRestored,
              applied: undo.applied,
              issue: rolloutRestored
                ? null
                : {
                    rollout_id: fresh.id,
                    code: 'rollback_incomplete' as const,
                    message: 'One or more live Shopify prices are not yet at this rollout baseline.',
                    variant_gids: [...variantGids],
                    unverified: check.mismatched,
                  },
            };
          });

          if (!locked.acquired) {
            const variants = variantsByRollout.get(rolloutId) ?? [];
            issues.set(rolloutId, {
              rollout_id: rolloutId,
              code: 'rollout_busy',
              message: 'An evaluator or price write still holds this rollout lease. The kill switch remains engaged; retry.',
              variant_gids: variants.filter((variant) => !variant.excluded).map((variant) => variant.variant_gid),
              unverified: [],
            });
            continue;
          }

          const outcome = locked.result as { resolved: boolean; applied: number; issue: KillSwitchIssue | null };
          restored += outcome.applied;
          if (outcome.applied > 0) passMayHaveChangedStorefront = true;
          if (outcome.resolved) {
            pending.delete(rolloutId);
            issues.delete(rolloutId);
          } else if (outcome.issue !== null) {
            issues.set(rolloutId, outcome.issue);
          }
        } catch (cause) {
          // The error may be a database failure after Shopify accepted a write.
          // Permit another chain-depth-bounded pass to observe that state.
          passMayHaveChangedStorefront = true;
          await adapter.updateRollout(rolloutId, {
            status: 'paused',
            ended_at: null,
            ended_reason: null,
            paused_reason: 'The store-wide undo needs attention after an unexpected verification error.',
          }).catch(() => undefined);
          const variants = variantsByRollout.get(rolloutId) ?? [];
          issues.set(rolloutId, {
            rollout_id: rolloutId,
            code: 'rollback_failed',
            message: cause instanceof Error ? cause.message : String(cause),
            variant_gids: variants.filter((variant) => !variant.excluded).map((variant) => variant.variant_gid),
            unverified: [],
          });
        }
      }

      // Do not stop merely because no database row reached a terminal state.
      // Shopify may have accepted a restoration just before the process or the
      // database acknowledgement failed. The next bounded pass is what exposes
      // and unwinds the preceding link in a chained price history.
      const passRootCheck = await verifyStorewideRestoration(client, initial, allVariants);
      latestRootCheck = passRootCheck;
      if (passRootCheck.ambiguous.length === 0 && passRootCheck.mismatched.length === 0) {
        rootReached = true;
        await terminalizePendingAtRoot();
        break;
      }
      if (!passMayHaveChangedStorefront) break;
    }

    const hasBusyRollout = [...issues.values()].some((issue) => issue.code === 'rollout_busy');

    // HTTP 200 is impossible until Shopify itself is verified at every
    // earliest pre-Priceflag baseline. This final check also catches legitimate
    // price cycles such as 1000 -> 1100 -> 1000, where set subtraction cannot
    // identify the historical root.
    if (!hasBusyRollout) {
      const finalRootCheck = latestRootCheck;
      for (const variantGid of finalRootCheck.ambiguous) {
        const owner = variantOwner.get(variantGid) ?? initial[0]?.id ?? 'storewide';
        issues.set(`storewide:${variantGid}`, {
          rollout_id: owner,
          code: 'rollback_incomplete',
          message: 'The original price chain has tied chronology and needs manual verification.',
          variant_gids: [variantGid],
          unverified: [],
        });
      }
      for (const mismatch of finalRootCheck.mismatched) {
        const owner = variantOwner.get(mismatch.variant_gid) ?? initial[0]?.id ?? 'storewide';
        issues.set(`storewide:${mismatch.variant_gid}`, {
          rollout_id: owner,
          code: 'rollback_incomplete',
          message: 'Shopify is not at this product\'s original pre-Priceflag price.',
          variant_gids: [mismatch.variant_gid],
          unverified: [mismatch],
        });
      }
    }

    await notify({ kind: 'kill_switch', shop: engaged, detail: restored });

    const failures = [...issues.values()].map(({ rollout_id, code, message }) => ({ rollout_id, code, message }));
    const failedVariants = new Set([...issues.values()].flatMap((issue) => issue.variant_gids));
    const mismatched = [...issues.values()].flatMap((issue) => issue.unverified);
    const failed = failedVariants.size;
    const ok = pending.size === 0 && failed === 0 && failures.length === 0;
    const issueCount = Math.max(failed, failures.length);
    return NextResponse.json(
      {
        ok,
        affected_skus: restored,
        message: ok
          ? `Every price Priceflag changed is back to what it was (${restored} product${restored === 1 ? '' : 's'}).`
          : `Restored ${restored} price${restored === 1 ? '' : 's'}, but ${issueCount} issue${issueCount === 1 ? '' : 's'} still need attention. The kill switch remains engaged.`,
        restored,
        failed,
        failures,
        unverified: mismatched,
        kill_switch_engaged_at: engaged.kill_switch_engaged_at,
      },
      { status: ok ? 200 : 207, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

/** Release the switch. Deliberately does not resume anything. */
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const raw = await readJson(request);
    if (typeof raw !== 'object' || raw === null || (raw as { confirm?: unknown }).confirm !== true) {
      throw new MerchantApiError(
        'release_confirmation_required',
        'Confirm that every unresolved restoration has been reviewed before re-enabling price writes.',
        400,
      );
    }
    if (shop.kill_switch_engaged_at === null) {
      throw new MerchantApiError('kill_switch_not_engaged', 'The store-wide kill switch is not engaged.', 409);
    }

    const rollouts = await adapter.listRollouts(shop.id);
    const now = Date.now();
    const held = rollouts.filter(
      (rollout) => rollout.eval_locked_until !== null && Date.parse(rollout.eval_locked_until) > now,
    );
    const unresolved = rollouts.filter(
      (rollout) => rollout.status !== 'cancelled' && rollout.status !== 'rolled_back',
    );
    if (held.length > 0 || unresolved.length > 0) {
      throw new MerchantApiError(
        'kill_switch_release_blocked',
        'Price writes stay disabled until every rollback is finished and no evaluator or writer holds a rollout lease.',
        409,
        {
          held_rollout_ids: held.map((rollout) => rollout.id),
          unresolved: unresolved.map((rollout) => ({ id: rollout.id, status: rollout.status })),
        },
        true,
      );
    }

    const client = new AdminGraphqlClient(credentialsFromShop(shop));
    const allVariants = await adapter.listRolloutVariantsForShop(shop.id);
    const verification = await verifyStorewideRestoration(client, rollouts, allVariants);
    if (verification.ambiguous.length > 0 || verification.mismatched.length > 0) {
      throw new MerchantApiError(
        'kill_switch_release_unverified',
        'Price writes stay disabled because Shopify could not be verified at every original pre-Priceflag price.',
        409,
        verification,
        true,
      );
    }

    await adapter.updateShop(shop.id, { kill_switch_engaged_at: null, kill_switch_reason: null });
    return NextResponse.json(
      {
        ok: true,
        affected_skus: 0,
        verified_skus: verification.verified,
        message: 'Priceflag can change prices again. Nothing was resumed — start a new rollout when you are ready.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
