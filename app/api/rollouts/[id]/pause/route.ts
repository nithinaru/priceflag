import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, MerchantApiError, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
      throw new MerchantApiError('invalid_pause', 'Send a valid pause request.', 400);
    }
    const input = body as { confirm?: unknown; reason?: unknown };
    if (input.confirm !== true) {
      throw new MerchantApiError('pause_confirmation_required', 'Confirm that you want to pause this rollout.', 400);
    }
    if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 500)) {
      throw new MerchantApiError('invalid_pause_reason', 'The pause note must be plain text no longer than 500 characters.', 400);
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim() !== ''
        ? input.reason.trim()
        : 'Paused manually by the merchant.';

    const locked = await adapter.withRolloutLock(id, async () => {
      const rollout = await adapter.getRollout(id);
      if (rollout === null || rollout.shop_id !== shop.id) {
        throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
      }
      if (rollout.status === 'paused') {
        return rollout;
      }
      if (rollout.status !== 'running' && rollout.status !== 'scheduled') {
        throw new MerchantApiError('pause_not_available', `A ${rollout.status} rollout cannot be paused.`, 409);
      }

      const paused = await adapter.updateRollout(rollout.id, {
        status: 'paused',
        paused_reason: reason,
      });
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'note',
        actor: 'merchant',
        message: reason,
        data: { action: 'manual_pause', previous_status: rollout.status },
      });
      return paused;
    });

    if (!locked.acquired) {
      throw new MerchantApiError(
        'rollout_busy',
        'This rollout is being evaluated or changed. It was not reported paused; try again in a moment.',
        409,
        null,
        true,
      );
    }
    return NextResponse.json(
      {
        ok: true,
        rollout: locked.result,
        message: (locked.result as { paused_reason?: string | null }).paused_reason ?? reason,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
