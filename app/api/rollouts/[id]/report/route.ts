import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Return the newest validated ML report for a rollout owned by the token tenant. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const { id } = await context.params;
    const rollout = await adapter.getRollout(id);
    if (rollout === null || rollout.shop_id !== shop.id) {
      throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
    }
    const [report] = await adapter.listRolloutReports(shop.id, rollout.id);
    if (report === undefined) {
      throw new MerchantApiError(
        'report_not_ready',
        'The report is not ready yet. It appears after enough rollout data has been processed.',
        404,
      );
    }
    // Database ownership and row metadata are not part of the frozen report
    // schema. Returning them would make an otherwise valid report fail its own
    // additionalProperties:false contract.
    const { id: _id, shop_id: _shopId, created_at: _createdAt, ...contract } = report;
    return NextResponse.json(contract, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
