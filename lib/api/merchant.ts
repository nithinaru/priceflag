import { NextResponse } from 'next/server';

import type { StoreAdapter } from '../adapters/types';
import { ForecastError } from '../engine/forecast';
import { RolloutError } from '../engine/rollout';
import { ShopifyApiError } from '../shopify/client';
import { CredentialError } from '../shopify/credentials';
import { resolveShopFromRequest } from '../shopify/session';
import type { Shop } from '../types';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: unknown;
  };
}

export class MerchantApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MerchantApiError';
  }
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details: unknown = null,
  retryable = false,
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: { code, message, retryable, details } }, { status });
}

/** Resolve the tenant only from Shopify's signed bearer token. */
export async function resolveAuthenticatedShop(
  request: Request,
  adapter: StoreAdapter,
): Promise<{ shop: Shop }> {
  let shopDomain: string;
  try {
    shopDomain = resolveShopFromRequest(request, { allowQueryParam: false }).shopDomain;
  } catch {
    throw new MerchantApiError(
      'session_unauthorized',
      'Open Priceflag from Shopify admin and try again.',
      401,
    );
  }

  const shop = await adapter.getShopByDomain(shopDomain);
  if (shop === null || shop.uninstalled_at !== null) {
    // Unknown and uninstalled are intentionally indistinguishable at this
    // boundary. Neither should confirm that a tenant exists.
    throw new MerchantApiError('shop_not_connected', 'This store is not connected to Priceflag.', 404);
  }
  return { shop };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MerchantApiError('invalid_json', 'Send a valid JSON request body.', 400);
  }
}

export function merchantErrorResponse(cause: unknown): NextResponse<ApiErrorBody> {
  if (cause instanceof MerchantApiError) {
    return apiError(cause.code, cause.message, cause.status, cause.details, cause.retryable);
  }
  if (cause instanceof ForecastError) {
    return apiError(cause.code, cause.message, 422);
  }
  if (cause instanceof RolloutError) {
    const status = cause.code === 'illegal_transition' ? 409 : 422;
    return apiError(cause.code, cause.message, status);
  }
  if (cause instanceof CredentialError) {
    return apiError(cause.code, 'Shopify credentials are unavailable. Reinstall Priceflag and try again.', 401);
  }
  if (cause instanceof ShopifyApiError) {
    if (cause.code === 'throttled' || cause.status === 429) {
      return apiError('shopify_rate_limited', 'Shopify is busy. Try again in a moment.', 429, null, true);
    }
    return apiError('shopify_unavailable', 'Shopify could not confirm the price change.', 503, null, true);
  }
  return apiError('service_unavailable', 'Priceflag could not complete that request. Try again.', 503, null, true);
}
