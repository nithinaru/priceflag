import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { parseProposal, prepareForecast } from '@/lib/api/proposals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const proposal = parseProposal(await readJson(request));
    if (proposal.guardrails !== undefined) {
      throw new MerchantApiError(
        'guardrails_not_allowed',
        'A forecast is a dry run. Add guardrails only when you create the rollout.',
        400,
      );
    }

    const { forecast } = await prepareForecast(adapter, shop, proposal);
    return NextResponse.json(forecast, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
