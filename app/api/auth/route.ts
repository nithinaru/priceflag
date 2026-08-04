/**
 * `GET /api/auth?shop=<domain>` — start the OAuth install.
 *
 * Validates the shop domain, mints a single-use nonce into an HttpOnly cookie, and
 * redirects to Shopify's authorize screen. The nonce is what makes the callback
 * unforgeable: without it, anyone could replay a callback URL at us.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getMode, hasShopifyConfig } from '@/lib/config';
import {
  buildAuthorizeUrl,
  createOAuthState,
  normalizeShopDomain,
  OAUTH_HOST_COOKIE,
  OAUTH_STATE_COOKIE,
  ShopifyAuthError,
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

  const state = createOAuthState();
  const response = NextResponse.redirect(buildAuthorizeUrl({ shop, state }));

  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    // Lax, not Strict: the cookie has to survive Shopify's top-level redirect back.
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 600,
  });

  // Preserve the embedded context through the round-trip: `host` is present only
  // when the install started inside the Shopify admin, and the callback uses it
  // to send the merchant back there. A separate cookie, not folded into `state`,
  // so the nonce check stays exactly what it is.
  const host = request.nextUrl.searchParams.get('host');
  if (host !== null && host !== '') {
    response.cookies.set(OAUTH_HOST_COOKIE, host, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: 600,
    });
  } else {
    response.cookies.delete(OAUTH_HOST_COOKIE);
  }

  return response;
}
