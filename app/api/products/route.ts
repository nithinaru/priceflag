import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import type { ProductQuery } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SORTS = new Set<NonNullable<ProductQuery['sort']>>([
  'title',
  'price_asc',
  'price_desc',
  'units_desc',
]);

/** Paged catalog for the token tenant. Query parameters filter data, never identity. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const params = new URL(request.url).searchParams;
    const query: ProductQuery = {
      search: optionalText(params.get('search'), 'search', 200),
      product_types: nonEmpty(params.getAll('product_type')),
      vendors: nonEmpty(params.getAll('vendor')),
      only_repriceable: optionalBoolean(params.get('only_repriceable'), 'only_repriceable'),
      missing_cogs: optionalBoolean(params.get('missing_cogs'), 'missing_cogs'),
      sort: optionalSort(params.get('sort')),
      limit: boundedInteger(params.get('limit'), 'limit', 50, 1, 200),
      offset: boundedInteger(params.get('offset'), 'offset', 0, 0, 1_000_000),
    };
    const page = await adapter.listProducts(shop.id, query);
    return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

function optionalText(value: string | null, field: string, max: number): string | undefined {
  if (value === null || value.trim() === '') return undefined;
  const cleaned = value.trim();
  if (cleaned.length > max) {
    throw new MerchantApiError('invalid_catalog_query', `${field} is too long.`, 400);
  }
  return cleaned;
}

function nonEmpty(values: string[]): string[] | undefined {
  const cleaned = values.map((value) => value.trim()).filter((value) => value !== '');
  return cleaned.length === 0 ? undefined : cleaned;
}

function optionalBoolean(value: string | null, field: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new MerchantApiError('invalid_catalog_query', `${field} must be true or false.`, 400);
}

function optionalSort(value: string | null): ProductQuery['sort'] {
  if (value === null || value === '') return undefined;
  if (SORTS.has(value as NonNullable<ProductQuery['sort']>)) return value as ProductQuery['sort'];
  throw new MerchantApiError('invalid_catalog_query', 'That catalog sort is not supported.', 400);
}

function boundedInteger(
  value: string | null,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MerchantApiError(
      'invalid_catalog_query',
      `${field} must be a whole number from ${minimum} to ${maximum}.`,
      400,
    );
  }
  return parsed;
}
