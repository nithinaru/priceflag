/**
 * `POST /api/sync` — start (or re-run) a sync.
 *
 * Runs inline and returns the final progress. That is fine for the store sizes v1
 * targets (30–500 SKUs) and it keeps the failure visible; a fire-and-forget job
 * that dies silently is worse than a request that takes twenty seconds. If a
 * pilot store is large enough to hit the function timeout, this becomes a queued
 * job and the contract does not change — Lane A already polls `/api/sync/status`.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { getAppUrl, getMode, isProductionRuntime } from '@/lib/config';
import { ensureStaticShop, resolveShopCredentials, CredentialError } from '@/lib/shopify/credentials';
import { reconcileWebhooks } from '@/lib/shopify/webhooks';
import { runSync, syncProgressFromRun } from '@/lib/sync';
import { resolveShopFromRequestOrCookie } from '@/lib/shopify/session';
import { ShopifyAuthError } from '@/lib/shopify/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function fail(code: string, message: string, status: number, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable, details: null } }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (getMode() === 'demo') {
    return fail(
      'demo_mode',
      'The simulated store already has its catalog and history loaded — there is nothing to sync.',
      409,
    );
  }

  const adapter = getAdapter();

  // The static-token path has no install flow, so nothing else would ever create
  // the shop row that every other table points at.
  await ensureStaticShop(adapter);

  let shopDomain: string;
  try {
    shopDomain = resolveShopFromRequestOrCookie(request).shopDomain;
  } catch (cause) {
    if (cause instanceof ShopifyAuthError) {
      // Production refuses to guess: a sync writes a catalog into whichever shop
      // this resolves to. The static-token fallback is a dev/staging convenience.
      if (isProductionRuntime()) {
        return fail('unauthenticated', 'Open Priceflag from your Shopify admin to start a sync.', 401);
      }
      const { staticShopDomain } = await import('@/lib/shopify/credentials');
      const fallback = staticShopDomain();
      if (fallback === null) return fail(cause.code, 'Could not work out which store this request is for.', 401);
      shopDomain = fallback;
    } else {
      throw cause;
    }
  }

  const shop = await adapter.getShopByDomain(shopDomain);
  if (shop === null) return fail('shop_not_connected', `${shopDomain} is not connected to Priceflag.`, 404);

  let credentials;
  try {
    // Resolve credentials before starting, so a bad token fails immediately
    // rather than halfway through writing a catalog.
    credentials = await resolveShopCredentials(adapter, shopDomain);
  } catch (cause) {
    if (cause instanceof CredentialError) return fail(cause.code, cause.message, 401);
    throw cause;
  }

  // Every manual sync is also a chance to converge webhook subscriptions — this
  // is what heals a preview→production domain move without a reinstall.
  // Non-fatal: a sync with stale webhooks is still a sync worth running.
  let webhooks: 'ok' | 'error' = 'ok';
  try {
    await reconcileWebhooks(credentials, getAppUrl());
  } catch (cause) {
    webhooks = 'error';
    console.error(
      `[sync] webhook reconcile failed for ${shopDomain}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }

  const url = new URL(request.url);
  const outcome = await runSync(adapter, shop, {
    catalogOnly: url.searchParams.get('catalogOnly') === '1',
    historyDays: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : undefined,
  });

  const run = await adapter.getLatestSyncRun(shop.id);

  return NextResponse.json(
    {
      progress: syncProgressFromRun(run),
      products: outcome.products,
      orders: outcome.orders,
      webhooks,
    },
    { status: outcome.error === null ? 200 : 502 },
  );
}
