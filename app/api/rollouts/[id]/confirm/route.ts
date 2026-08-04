import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, MerchantApiError, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { startRollout } from '@/lib/evaluator';
import { verifyFrozenBaselines } from '@/lib/pricing/writer';
import { AdminGraphqlClient } from '@/lib/shopify/client';
import { credentialsFromShop } from '@/lib/shopify/credentials';

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
    const existing = await adapter.getRollout(id);
    if (existing === null || existing.shop_id !== shop.id) {
      throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
    }

    const body = await readJson(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new MerchantApiError('invalid_confirmation', 'Send a valid rollout confirmation.', 400);
    }
    const input = body as { confirm?: unknown; scheduled_start_at?: unknown };
    if (input.confirm !== true) {
      throw new MerchantApiError(
        'rollout_confirmation_required',
        'Confirm the frozen old prices, new prices, affected variants, and guardrails before starting.',
        400,
      );
    }
    if (
      input.scheduled_start_at !== undefined &&
      input.scheduled_start_at !== null &&
      typeof input.scheduled_start_at !== 'string'
    ) {
      throw new MerchantApiError('invalid_schedule', 'scheduled_start_at must be an ISO timestamp or null.', 400);
    }
    if (typeof input.scheduled_start_at === 'string' && !Number.isFinite(Date.parse(input.scheduled_start_at))) {
      throw new MerchantApiError('invalid_schedule', 'scheduled_start_at must be a valid ISO timestamp.', 400);
    }

    const locked = await adapter.withRolloutLock(id, async () => {
      const rollout = await adapter.getRollout(id);
      if (rollout === null || rollout.shop_id !== shop.id) {
        throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
      }

      // Network retries after a committed confirmation are idempotent. A paused
      // result is returned honestly and is never restarted behind the merchant.
      if (rollout.status === 'scheduled' || rollout.status === 'running') {
        return { status: 200, body: { ok: true, rollout, applied: null, unverified: [] } };
      }
      if (rollout.status === 'paused') {
        return {
          status: 207,
          body: {
            ok: false,
            rollout,
            applied: null,
            unverified: [],
            message: rollout.paused_reason ?? 'This rollout is paused and was not started again.',
          },
        };
      }
      if (rollout.status !== 'draft') {
        throw new MerchantApiError(
          'confirmation_not_available',
          `A ${rollout.status} rollout cannot be confirmed.`,
          409,
        );
      }
      if (rollout.guardrails.auto_rollback) {
        throw new MerchantApiError(
          'automatic_rollback_disabled',
          'Automatic rollback is disabled during the public beta. Update the draft guardrails first.',
          422,
        );
      }
      if (shop.kill_switch_engaged_at !== null) {
        throw new MerchantApiError(
          'kill_switch_engaged',
          'Release the store-wide kill switch before confirming a price change.',
          409,
        );
      }

      const requestedSchedule =
        input.scheduled_start_at === undefined ? rollout.scheduled_start_at : input.scheduled_start_at;
      const scheduleMs = typeof requestedSchedule === 'string' ? Date.parse(requestedSchedule) : null;
      const now = new Date();
      if (typeof input.scheduled_start_at === 'string' && (scheduleMs as number) <= now.getTime()) {
        throw new MerchantApiError('invalid_schedule', 'Choose a future time, or send null to start now.', 400);
      }

      if (scheduleMs !== null && scheduleMs > now.getTime()) {
        const client = new AdminGraphqlClient(credentialsFromShop(shop));
        const baseline = await verifyFrozenBaselines({ adapter, client, shop }, rollout);
        if (baseline.mismatched.length > 0) {
          throw new MerchantApiError(
            'baseline_drift',
            'At least one Shopify price changed after this draft was created. Create a fresh draft before scheduling.',
            409,
            baseline.mismatched,
          );
        }

        const scheduledAt = new Date(scheduleMs).toISOString();
        const scheduled = await adapter.updateRollout(rollout.id, {
          status: 'scheduled',
          scheduled_start_at: scheduledAt,
          paused_reason: null,
        });
        await adapter.appendRolloutEvent({
          rollout_id: rollout.id,
          shop_id: shop.id,
          type: 'scheduled',
          actor: 'merchant',
          message: `Confirmed. The first stage is scheduled for ${scheduledAt}; no Shopify price changed yet.`,
          data: { scheduled_start_at: scheduledAt, baseline_verified: baseline.verified },
        });
        return { status: 200, body: { ok: true, rollout: scheduled, applied: null, unverified: [] } };
      }

      const applied = await startRollout(adapter, shop, rollout, { now, skipLock: true });
      const updated = await adapter.getRollout(rollout.id);
      if (updated === null) throw new Error(`rollout ${rollout.id} disappeared after start`);
      const ok = updated.status === 'running' && applied.fully_applied;
      return {
        status: ok ? 200 : 207,
        body: {
          ok,
          rollout: updated,
          applied,
          unverified: applied.failures,
          message: ok
            ? `The first stage is live and verified on ${applied.applied + applied.skipped_noop} product${applied.applied + applied.skipped_noop === 1 ? '' : 's'}.`
            : updated.paused_reason ?? 'The first stage is paused because not every price could be verified.',
        },
      };
    });

    if (!locked.acquired) {
      throw new MerchantApiError(
        'rollout_busy',
        'This rollout is being evaluated or changed. No start was reported; try again in a moment.',
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
