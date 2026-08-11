/**
 * Which shop is this *page render* for?
 *
 * API routes get an `Authorization` header from `authenticatedFetch`; a
 * server-rendered page gets no header at all. What a page render does have, in
 * priority order:
 *
 *   1. `id_token` — a session token Shopify puts on the initial iframe load.
 *      Strongest claim: a JWT signed by Shopify for this app.
 *   2. Embedded launch params — `shop`/`host`/`timestamp` signed with `hmac`
 *      (same scheme as the OAuth callback), bounded to five minutes against replay.
 *   3. The short-lived `pf_shop` cookie — minted by `POST /api/auth/session`
 *      after a prior token verification and refreshed by App Bridge on each
 *      embedded page load. This is page-render identity only; API writes still
 *      require a fresh bearer token.
 *   4. Non-production only: `?shop=` or `SHOPIFY_SHOP_DOMAIN`, so local dev
 *      works without an admin iframe.
 *
 * Server Components cannot *set* cookies in Next 15, so verifying 1/2 here does
 * not mint anything — `components/lib/app-bridge-boot.tsx` calls the session
 * route for that. This module only decides, it never writes.
 */

import { cookies } from 'next/headers';

import { getAdapter } from '@/lib/adapters';
import { env, getMode, hasShopifyConfig, isProductionRuntime, requireEnv } from '@/lib/config';
import { verifyOAuthHmac } from '@/lib/shopify/hmac';
import { normalizeShopDomain } from '@/lib/shopify/oauth';
import { SHOP_COOKIE, verifySessionToken, verifyShopCookie } from '@/lib/shopify/session';
import type { Shop } from '@/lib/types';

export type PageSearchParams = Record<string, string | string[] | undefined>;

export type PageShopContext =
  | { mode: 'demo'; shop: null }
  /** `shop: null` in real mode means "we do not know who you are" — the caller
   * renders the open-from-Shopify-admin / connect state, never a guess. */
  | { mode: 'real'; shop: Shop | null };

/** Tight replay bound for hmac-signed launch params. Session tokens carry their own `exp`. */
const LAUNCH_MAX_AGE_SECONDS = 5 * 60;

async function connectedShop(domain: string): Promise<Shop | null> {
  const shop = await getAdapter().getShopByDomain(domain);
  return shop !== null && shop.uninstalled_at === null ? shop : null;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function shopFromIdToken(searchParams: PageSearchParams): string | null {
  const idToken = firstValue(searchParams['id_token']);
  if (idToken === undefined) return null;
  try {
    return verifySessionToken(idToken).shopDomain;
  } catch {
    return null;
  }
}

function shopFromLaunchParams(searchParams: PageSearchParams): string | null {
  const hmac = firstValue(searchParams['hmac']);
  const shop = firstValue(searchParams['shop']);
  const timestamp = firstValue(searchParams['timestamp']);
  if (hmac === undefined || shop === undefined || timestamp === undefined) return null;

  const issuedAt = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(issuedAt) || Math.abs(nowSeconds - issuedAt) > LAUNCH_MAX_AGE_SECONDS) {
    return null;
  }

  // Rebuild the full query exactly as received — the digest covers every
  // parameter except `hmac`, so a partial reconstruction would always fail.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  if (!verifyOAuthHmac(params, requireEnv('SHOPIFY_API_SECRET'))) return null;

  try {
    return normalizeShopDomain(shop);
  } catch {
    return null;
  }
}

export async function resolveShopForPage(searchParams: PageSearchParams): Promise<PageShopContext> {
  if (getMode() === 'demo') return { mode: 'demo', shop: null };

  if (hasShopifyConfig()) {
    const fromToken = shopFromIdToken(searchParams);
    if (fromToken !== null) return { mode: 'real', shop: await connectedShop(fromToken) };

    const fromLaunch = shopFromLaunchParams(searchParams);
    if (fromLaunch !== null) return { mode: 'real', shop: await connectedShop(fromLaunch) };

    const cookieValue = (await cookies()).get(SHOP_COOKIE)?.value;
    if (cookieValue !== undefined) {
      const fromCookie = verifyShopCookie(cookieValue);
      if (fromCookie !== null) return { mode: 'real', shop: await connectedShop(fromCookie) };
    }
  }

  if (!isProductionRuntime()) {
    const raw = firstValue(searchParams['shop']) ?? env('SHOPIFY_SHOP_DOMAIN');
    if (raw !== undefined) {
      try {
        return { mode: 'real', shop: await connectedShop(normalizeShopDomain(raw)) };
      } catch {
        // Not a shop domain — fall through to the unknown state.
      }
    }
  }

  return { mode: 'real', shop: null };
}

/**
 * Cookie-only resolution, for the renders that have no `searchParams` at all:
 * layout chrome (the nav's store card and live-status) and server actions.
 * Equivalent to `resolveShopForPage` with an empty query — the `pf_shop`
 * cookie minted by the embedded boot is the normal case, with the non-prod
 * `SHOPIFY_SHOP_DOMAIN` fallback so local dev works. A server action must use
 * this rather than any client-supplied shop domain, which would let one
 * merchant's browser write another merchant's data.
 */
export async function resolveShopForSession(): Promise<PageShopContext> {
  return resolveShopForPage({});
}
