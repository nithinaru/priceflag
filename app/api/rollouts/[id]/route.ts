import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, MerchantApiError, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { buildRolloutView } from '@/lib/api/rollout-view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const { id } = await context.params;
    const rollout = await adapter.getRollout(id);

    // A rollout belonging to another shop is deliberately indistinguishable
    // from an unknown id. Never load its child rows before this ownership check.
    if (rollout === null || rollout.shop_id !== shop.id) {
      throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
    }

    return NextResponse.json(
      await buildRolloutView(adapter, rollout),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
