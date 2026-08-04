import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import {
  MerchantApiError,
  merchantErrorResponse,
  readJson,
  resolveAuthenticatedShop,
} from '@/lib/api/merchant';
import { isCents } from '@/lib/money';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ variantId: string }>;
}

/** Set or clear a manually supplied unit cost for one variant in the token tenant. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const { variantId } = await context.params;
    const body = await readJson(request);
    if (!isRecord(body) || !Object.hasOwn(body, 'cogs_cents')) {
      throw new MerchantApiError(
        'cogs_required',
        'Send the unit cost in whole cents, or null to clear it.',
        400,
      );
    }
    if (Object.keys(body).some((key) => key !== 'cogs_cents')) {
      throw new MerchantApiError('unsupported_cogs_update', 'Only the unit cost can be changed here.', 400);
    }

    const cogs = body.cogs_cents;
    if (cogs !== null && (!isCents(cogs) || cogs < 0)) {
      throw new MerchantApiError(
        'invalid_cogs',
        'A unit cost must be a non-negative whole number of cents, or null.',
        400,
      );
    }

    const [existing] = await adapter.getProductsByVariantGids(shop.id, [variantId]);
    if (existing === undefined) {
      throw new MerchantApiError('variant_not_found', 'That product variant was not found.', 404);
    }

    const product = await adapter.setCogs(shop.id, variantId, cogs, 'manual');
    return NextResponse.json(
      {
        product,
        message: cogs === null ? 'The unit cost was cleared.' : 'The unit cost was saved.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
