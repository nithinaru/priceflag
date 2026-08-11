/**
 * `POST /api/auth/session` — trade a session token for the `pf_shop` cookie.
 *
 * App Bridge session tokens live about a minute and only travel on fetches that
 * attach a header. Server-rendered navigations and plain download links carry
 * neither — so after verifying one real token, this route mints the signed
 * `pf_shop` cookie (10 minutes, HttpOnly, SameSite=None so it survives the admin
 * iframe). `components/lib/app-bridge-boot.tsx` calls this on every embedded
 * page load; `refreshed` tells it whether SSR ran without shop identity and a
 * one-time reload is worth it.
 *
 * No body is trusted: the only input is the Authorization header, and the only
 * secret output is a cookie the browser holds. The token itself is never echoed.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { getMode, hasShopifyConfig } from '@/lib/config';
import {
  SHOP_COOKIE,
  SHOP_COOKIE_MAX_AGE_SECONDS,
  sessionTokenFromRequest,
  signShopCookie,
  verifySessionToken,
  verifyShopCookie,
} from '@/lib/shopify/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function unauthenticated(message: string): NextResponse {
  return NextResponse.json(
    { error: { code: 'unauthenticated', message, retryable: false, details: null } },
    { status: 401 },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasShopifyConfig()) {
    return NextResponse.json(
      {
        error: {
          code: 'shopify_not_configured',
          message: 'This deployment has no Shopify credentials.',
          retryable: false,
          details: null,
        },
      },
      { status: 503 },
    );
  }

  if (getMode() === 'demo') {
    // The demo store has no shop identity to persist; a no-op keeps the boot
    // component unconditional.
    return NextResponse.json({ shop: null, connected: false, refreshed: false });
  }

  const token = sessionTokenFromRequest(request);
  if (token === null) return unauthenticated('Missing App Bridge session token.');

  let shopDomain: string;
  try {
    shopDomain = verifySessionToken(token).shopDomain;
  } catch {
    return unauthenticated('That session token could not be verified.');
  }

  const existing = request.cookies.get(SHOP_COOKIE)?.value;
  const alreadyCurrent = existing !== undefined && verifyShopCookie(existing) === shopDomain;

  const shop = await getAdapter().getShopByDomain(shopDomain);
  if (shop === null || shop.uninstalled_at !== null) {
    return NextResponse.json(
      {
        error: {
          code: 'shop_not_connected',
          message: 'Install or reinstall Priceflag for this store before continuing.',
          retryable: false,
          details: null,
        },
      },
      { status: 404 },
    );
  }

  const response = NextResponse.json({
    shop: shopDomain,
    connected: true,
    refreshed: !alreadyCurrent,
  });
  response.cookies.set(SHOP_COOKIE, signShopCookie(shopDomain), {
    httpOnly: true,
    // None + Secure is the only combination a third-party iframe ever sends.
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: SHOP_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
