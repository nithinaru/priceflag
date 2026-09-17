/** Authenticated repair endpoint for this shop's operational webhooks. */

import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { sessionOrigin } from '@/lib/auth/session-host';
import { getMode } from '@/lib/config';
import { credentialsFromShop } from '@/lib/shopify/credentials';
import { reconcileWebhooks } from '@/lib/shopify/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    if (getMode() === 'demo') {
      return NextResponse.json(
        { error: { code: 'demo_mode', message: 'The demo has no Shopify webhooks.', retryable: false, details: null } },
        { status: 409 },
      );
    }
    const result = await reconcileWebhooks(credentialsFromShop(shop), sessionOrigin());
    return NextResponse.json(
      {
        reconciled: true,
        required: result.ok.length + result.created.length + result.updated.length,
        result,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
