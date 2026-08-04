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
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { rollbackInProgressReason } from '@/lib/engine/rollout';
import { rollbackRollout, verifyRollback } from '@/lib/pricing/writer';
import { AdminGraphqlClient } from '@/lib/shopify/client';
import { credentialsFromShop } from '@/lib/shopify/credentials';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const body = (await request.json().catch(() => ({}))) as { reason?: string };

    // Engage FIRST. If the revert below fails halfway, no writer can add to the
    // problem while a human works out what happened.
    const engaged = await adapter.updateShop(shop.id, {
      kill_switch_engaged_at: new Date().toISOString(),
      kill_switch_reason: body.reason ?? 'Store-wide undo requested by the merchant.',
    });

    const client = new AdminGraphqlClient(credentialsFromShop(engaged));
    const context = { adapter, client, shop: engaged };

    let restored = 0;
    const failedVariants = new Set<string>();
    const mismatched: { variant_gid: string; expected: number; found: number | null }[] = [];
    const failures: { rollout_id: string; code: string; message: string }[] = [];

    // Newest first is load-bearing for chained changes: 1210 -> 1100 -> 1000.
    // StoreAdapter.listRollouts guarantees this order, including timestamp ties.
    for (const rollout of await adapter.listRollouts(shop.id)) {
      // A never-started draft cannot have changed Shopify. Scheduled rows are
      // included so the kill switch also prevents a future first write.
      if (rollout.status === 'draft' || rollout.status === 'cancelled') continue;

      try {
        const locked = await adapter.withRolloutLock(rollout.id, async () => {
          const fresh = await adapter.getRollout(rollout.id);
          if (fresh === null || fresh.shop_id !== shop.id) throw new Error('rollout disappeared while undoing');

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
          restored += undo.applied;
          for (const failure of undo.failures) failedVariants.add(failure.variant_gid);

          // Verify even when no write was acknowledged. That is exactly when an
          // external edit or timeout-after-write could otherwise be reported clean.
          const check = await verifyRollback(context, fresh);
          mismatched.push(...check.mismatched);
          for (const mismatch of check.mismatched) failedVariants.add(mismatch.variant_gid);
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
              : 'Store-wide undo needs attention: at least one live Shopify price could not be confirmed at its baseline.',
            data: {
              restored: check.verified,
              failed: undo.failed,
              external_changes: undo.external_changes,
              unverified: check.mismatched,
            },
          });
        });

        if (!locked.acquired) {
          const variants = await adapter.getRolloutVariants(rollout.id);
          for (const variant of variants) if (!variant.excluded) failedVariants.add(variant.variant_gid);
          failures.push({
            rollout_id: rollout.id,
            code: 'rollout_busy',
            message: 'An evaluator or price write still holds this rollout lease. The kill switch remains engaged; retry.',
          });
        }
      } catch (cause) {
        await adapter.updateRollout(rollout.id, {
          status: 'paused',
          ended_at: null,
          ended_reason: null,
          paused_reason: 'The store-wide undo needs attention after an unexpected verification error.',
        }).catch(() => undefined);
        const variants = await adapter.getRolloutVariants(rollout.id).catch(() => []);
        for (const variant of variants) if (!variant.excluded) failedVariants.add(variant.variant_gid);
        failures.push({
          rollout_id: rollout.id,
          code: 'rollback_failed',
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    await notify({ kind: 'kill_switch', shop: engaged, detail: restored });

    const failed = failedVariants.size;
    const ok = failed === 0 && failures.length === 0;
    const issues = Math.max(failed, failures.length);
    return NextResponse.json(
      {
        ok,
        affected_skus: restored,
        message: ok
          ? `Every price Priceflag changed is back to what it was (${restored} product${restored === 1 ? '' : 's'}).`
          : `Restored ${restored} price${restored === 1 ? '' : 's'}, but ${issues} issue${issues === 1 ? '' : 's'} still need attention. The kill switch remains engaged.`,
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
    await adapter.updateShop(shop.id, { kill_switch_engaged_at: null, kill_switch_reason: null });
    return NextResponse.json(
      {
        ok: true,
        affected_skus: 0,
        message: 'Priceflag can change prices again. Nothing was resumed — start a new rollout when you are ready.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
