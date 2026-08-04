import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Cancel only a draft/scheduled rollout, both of which are guaranteed to have no live writes. */
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
    if (!isRecord(body) || body.confirm !== true) {
      throw new MerchantApiError(
        'cancel_confirmation_required',
        'Confirm that you want to cancel this rollout.',
        400,
      );
    }

    const locked = await adapter.withRolloutLock(id, async () => {
      const rollout = await adapter.getRollout(id);
      if (rollout === null || rollout.shop_id !== shop.id) {
        throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
      }
      if (rollout.status === 'cancelled') return rollout;
      if (rollout.status !== 'draft' && rollout.status !== 'scheduled') {
        throw new MerchantApiError(
          'cancel_not_available',
          `A ${rollout.status} rollout cannot be cancelled. Pause or roll it back instead.`,
          409,
        );
      }
      const variants = await adapter.getRolloutVariants(rollout.id);
      if (variants.some((variant) => variant.applied_at !== null || variant.reverted_at !== null)) {
        throw new MerchantApiError(
          'cancel_not_safe',
          'This rollout has price-write history, so it cannot be cancelled. Use verified rollback instead.',
          409,
        );
      }

      const cancelled = await adapter.updateRollout(rollout.id, {
        status: 'cancelled',
        scheduled_start_at: null,
        ended_at: new Date().toISOString(),
        ended_reason: 'cancelled',
        paused_reason: null,
      });
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'cancelled',
        actor: 'merchant',
        message: 'Cancelled by the merchant before any price went live.',
        data: { previous_status: rollout.status },
      });
      return cancelled;
    });

    if (!locked.acquired) {
      throw new MerchantApiError(
        'rollout_busy',
        'This rollout is being changed. It was not reported cancelled; try again in a moment.',
        409,
        null,
        true,
      );
    }
    return NextResponse.json(
      { ok: true, rollout: locked.result, message: 'The rollout was cancelled before any price went live.' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
