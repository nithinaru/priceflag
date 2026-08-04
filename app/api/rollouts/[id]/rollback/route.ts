import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, MerchantApiError, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { AdminGraphqlClient } from '@/lib/shopify/client';
import { credentialsFromShop } from '@/lib/shopify/credentials';
import { rollbackInProgressReason } from '@/lib/engine/rollout';
import { rollbackRollout, verifyRollback } from '@/lib/pricing/writer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const { id } = await context.params;
    const rollout = await adapter.getRollout(id);
    if (rollout === null || rollout.shop_id !== shop.id) {
      throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
    }

    const body = await readJson(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new MerchantApiError('invalid_rollback', 'Send a valid rollback request.', 400);
    }
    const confirmation = (body as { confirm?: unknown }).confirm;
    if (confirmation !== true) {
      throw new MerchantApiError(
        'rollback_confirmation_required',
        'Confirm that you want to restore the original Shopify prices.',
        400,
      );
    }
    const reasonValue = (body as { reason?: unknown }).reason;
    if (reasonValue !== undefined && (typeof reasonValue !== 'string' || reasonValue.length > 500)) {
      throw new MerchantApiError(
        'invalid_rollback_reason',
        'The rollback note must be plain text no longer than 500 characters.',
        400,
      );
    }
    const reason =
      typeof reasonValue === 'string' && reasonValue.trim() !== ''
        ? reasonValue.trim()
        : 'The merchant requested a manual rollback.';

    const locked = await adapter.withRolloutLock(rollout.id, async () => {
      // Reload after acquiring the lease. The ownership/status checked before the
      // lease may have changed while another evaluator held it.
      const fresh = await adapter.getRollout(rollout.id);
      if (fresh === null || fresh.shop_id !== shop.id) {
        throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
      }
      if (!['running', 'paused', 'completed', 'rolled_back'].includes(fresh.status)) {
        throw new MerchantApiError(
          'rollback_not_available',
          `A ${fresh.status} rollout has no live Priceflag price to restore.`,
          409,
        );
      }
      if (shop.kill_switch_engaged_at !== null) {
        throw new MerchantApiError(
          'kill_switch_engaged',
          'The store-wide kill switch is already engaged. Retry that store-wide undo instead.',
          409,
        );
      }

      // Persist intent before the Shopify mutation. A completed rollout must be
      // made nonterminal while restoration is in progress, so a failed rollback
      // remains visible and retryable instead of falling back to "completed".
      await adapter.updateRollout(fresh.id, {
        status: 'paused',
        paused_reason: rollbackInProgressReason('manual'),
        ended_at: null,
        ended_reason: null,
      });

      try {
        const client = new AdminGraphqlClient(credentialsFromShop(shop));
        const writerContext = { adapter, client, shop };
        const undo = await rollbackRollout(writerContext, fresh, {
          reason,
          source: 'rollback',
          actor: 'merchant',
        });
        const verification = await verifyRollback(writerContext, fresh);
      const failedVariants = new Set([
        ...undo.failures.map((failure) => failure.variant_gid),
        ...verification.mismatched.map((mismatch) => mismatch.variant_gid),
      ]);
      const ok =
        failedVariants.size === 0 &&
        undo.fully_applied &&
        undo.external_changes.length === 0;
      const now = new Date().toISOString();
      const updated = await adapter.updateRollout(
        fresh.id,
        ok
          ? {
              status: 'rolled_back',
              ended_at: now,
              ended_reason: 'manual_rollback',
              paused_reason: null,
            }
          : {
              status: 'paused',
              ended_at: null,
              ended_reason: null,
              paused_reason: 'Manual rollback needs attention: one or more Shopify prices could not be verified.',
            },
      );

      const remaining = failedVariants.size;
      const message = ok
        ? `Restored the original price on ${verification.verified} product${verification.verified === 1 ? '' : 's'}. Nothing from this rollout is live any more.`
        : `Restored ${verification.verified} price${verification.verified === 1 ? '' : 's'}, but ${remaining} still need attention. The rollout is paused and remains retryable.`;

      await adapter.appendRolloutEvent({
        rollout_id: fresh.id,
        shop_id: shop.id,
        type: 'manual_rollback',
        actor: 'merchant',
        message,
        data: {
          restored: verification.verified,
          failed: remaining,
          skipped_noop: undo.skipped_noop,
          failures: undo.failures,
          external_changes: undo.external_changes,
          unverified: verification.mismatched,
          reason,
        },
      });

        return {
          status: ok ? 200 : 207,
          body: {
            ok,
            affected_skus: undo.intended,
            message,
            rollout: updated,
            restored: verification.verified,
            skipped_noop: undo.skipped_noop,
            failed: remaining,
            failures: undo.failures,
            unverified: verification.mismatched,
          },
        };
      } catch (cause) {
        await adapter.updateRollout(fresh.id, {
          status: 'paused',
          ended_at: null,
          ended_reason: null,
          paused_reason: 'Manual rollback needs attention after an unexpected Shopify write or verification error.',
        }).catch(() => undefined);
        await adapter.appendRolloutEvent({
          rollout_id: fresh.id,
          shop_id: shop.id,
          type: 'manual_rollback',
          actor: 'merchant',
          message: 'Manual rollback stopped after an unexpected Shopify write or verification error. It remains retryable.',
          data: { verified: false, error: cause instanceof Error ? cause.message : String(cause), reason },
        }).catch(() => undefined);
        throw cause;
      }
    });

    if (!locked.acquired) {
      throw new MerchantApiError(
        'rollout_busy',
        'This rollout is being evaluated or changed. Nothing was reported restored; try again in a moment.',
        409,
        null,
        true,
      );
    }
    const result = locked.result as { status: number; body: Record<string, unknown> };
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
