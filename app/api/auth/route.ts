/**
 * `GET /api/auth?shop=<domain>` — start the OAuth install.
 *
 * Validates the shop domain, mints a single-use nonce into an HttpOnly cookie, and
 * redirects to Shopify's authorize screen. The nonce is what makes the callback
 * unforgeable: without it, anyone could replay a callback URL at us.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { sessionOrigin } from '@/lib/auth/session-host';
import { getMode, hasShopifyConfig } from '@/lib/config';
import { USER_COOKIE, verifyUserCookie } from '@/lib/auth/account';
import {
  INSTALL_INITIATOR_COOKIE,
  installInitiatorCookieOptions,
} from '@/lib/auth/link-binding';
import {
  buildAuthorizeUrl,
  canonicalOAuthStartUrl,
  createOAuthState,
  normalizeShopDomain,
  OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
  ShopifyAuthError,
  shouldCanonicalizeOAuthStart,
} from '@/lib/shopify/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!hasShopifyConfig()) {
    return NextResponse.json(
      {
        error: {
          code: 'shopify_not_configured',
          message:
            'This deployment has no Shopify credentials. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET, or use demo mode.',
          retryable: false,
          details: null,
        },
      },
      { status: 503 },
    );
  }

  if (getMode() === 'demo') {
    return NextResponse.json(
      {
        error: {
          code: 'demo_mode',
          message:
            'Priceflag is running against the simulated store, so there is nothing to install. Set PRICEFLAG_MODE=real to connect a Shopify store.',
          retryable: false,
          details: null,
        },
      },
      { status: 409 },
    );
  }

  const shopParam = request.nextUrl.searchParams.get('shop');
  if (shopParam === null) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_shop_domain',
          message: 'Add ?shop=your-store.myshopify.com to install.',
          retryable: false,
          details: null,
        },
      },
      { status: 400 },
    );
  }

  let shop: string;
  try {
    shop = normalizeShopDomain(shopParam);
  } catch (cause) {
    return NextResponse.json(
      {
        error: {
          code: cause instanceof ShopifyAuthError ? cause.code : 'invalid_shop_domain',
          message: "That does not look like a Shopify store address. It should end in '.myshopify.com'.",
          retryable: false,
          details: null,
        },
      },
      { status: 400 },
    );
  }

  // Cookies are host-only. If this request landed on the Vercel project host
  // (or any host other than APP_URL), Shopify's redirect_uri would come back
  // to dashboard.priceflag.org without the nonce cookie → state_mismatch.
  if (shouldCanonicalizeOAuthStart(request.nextUrl)) {
    return NextResponse.redirect(canonicalOAuthStartUrl(request.nextUrl));
  }

  const state = createOAuthState();
  const secure = new URL(sessionOrigin()).protocol === 'https:';
  const response = NextResponse.redirect(buildAuthorizeUrl({ shop, state }));

  response.cookies.set(OAUTH_STATE_COOKIE, state, oauthStateCookieOptions(secure));

  // If a signed-in account is starting this install, record it here — at the
  // start, where the intent is. The callback links the store to this value
  // rather than to whatever session cookie happens to be present when Shopify
  // redirects back, so the ownership row reflects somebody having *asked* to
  // connect a store rather than merely having been signed in at the time.
  const accountCookie = request.cookies.get(USER_COOKIE)?.value;
  const account = accountCookie === undefined ? null : verifyUserCookie(accountCookie);
  if (account !== null) {
    response.cookies.set(
      INSTALL_INITIATOR_COOKIE,
      account.userId,
      installInitiatorCookieOptions(secure),
    );
  }

  return response;
}
