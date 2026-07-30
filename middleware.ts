/**
 * Application access gate — INTERIM MEASURE, not the real thing.
 *
 * ## Why this exists
 *
 * Vercel's Standard Deployment Protection **exempts the production domain**, so
 * `priceflag.vercel.app` was serving the whole dashboard — and every mutating
 * route — to anyone who typed the URL. Verified: an unauthenticated `GET
 * /api/journal` returned a real merchant's price history. Priceflag writes prices
 * to a live Shopify store, so that is as bad as it sounds.
 *
 * Protecting all deployments is a paid Vercel feature, and Vercel Authentication
 * requires *team membership* — so it could never let a pilot merchant in anyway.
 * An application-level gate is the only thing that both closes the hole now and
 * survives contact with a real pilot.
 *
 * ## What this is NOT
 *
 * This is a shared secret, not authentication. It does not identify a merchant,
 * it does not scope a request to a shop, and everyone who has it has all of it.
 * **R33 — App Bridge session-token verification — is still required before any
 * merchant is onboarded.** `lib/shopify/session.ts` already verifies those tokens
 * (HS256 pinned, `aud`/`iss`/`dest` checked); what is missing is that no route
 * requires one. This gate buys time; it does not replace that work.
 *
 * ## The exemptions, and why each one is safe
 *
 * Three paths bypass the gate because each already authenticates itself, and each
 * would break if it could not be reached without a browser cookie:
 *
 *   - `/api/cron/evaluate` — `CRON_SECRET` bearer, constant-time. The GitHub
 *     Actions evaluator calls it; adding the gate secret there would just be a
 *     second shared secret guarding the same door.
 *   - `/api/webhooks/*` — Shopify HMAC over the raw body. Shopify cannot send a
 *     cookie, so gating this would silently kill order ingestion.
 *   - `/api/health` — reports capability booleans and no data. Deliberately open
 *     so uptime checks work without a credential.
 *
 * `/api/ml/ingest` is NOT exempt at the gate level even though it has its own
 * secret — defence in depth on the path that writes the numbers driving
 * auto-rollback. Lane C's workflow sends both.
 */

import { NextResponse, type NextRequest } from 'next/server';

/** Cookie name. Deliberately not obviously guessable from the product name. */
const COOKIE = 'pf_access';

/** Query parameter that mints the cookie: `?access=…` once, then it is stripped. */
const QUERY_PARAM = 'access';

const EXEMPT_EXACT = new Set(['/api/health', '/api/cron/evaluate']);
const EXEMPT_PREFIX = ['/api/webhooks/'];

function isExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  return EXEMPT_PREFIX.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Constant-time string comparison.
 *
 * Hand-rolled because middleware runs on the edge runtime, where `node:crypto`'s
 * `timingSafeEqual` is not available. Compares every character regardless of
 * where the first difference is, so the time taken does not leak the prefix.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `Authorization: Basic …`, accepting the secret as either the user or the password. */
function secretFromBasicAuth(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = atob(match[1] as string);
    const separator = decoded.indexOf(':');
    if (separator === -1) return decoded;
    // Either half may carry it: `curl -u priceflag:SECRET` and `curl -u SECRET:`
    // are both things a person will reasonably try.
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return password === '' ? user : password;
  } catch {
    return null;
  }
}

function unauthorized(): NextResponse {
  const response = new NextResponse(
    JSON.stringify({
      error: {
        code: 'unauthorized',
        message: 'Priceflag is not publicly accessible. An access key is required.',
        retryable: false,
        details: null,
      },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
  // Prompts a browser for credentials instead of showing a bare JSON error.
  response.headers.set('www-authenticate', 'Basic realm="Priceflag", charset="UTF-8"');
  // A 401 must never be cached and served to somebody who *is* authorised.
  response.headers.set('cache-control', 'no-store');
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, searchParams } = request.nextUrl;

  if (isExempt(pathname)) return NextResponse.next();

  const secret = process.env.APP_ACCESS_SECRET;

  if (secret === undefined || secret === '') {
    // Fail CLOSED in production. A misconfigured deploy taking the app offline is
    // recoverable; a misconfigured deploy silently serving a price-writing tool to
    // the internet is what got us here.
    const isProduction = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
    if (isProduction) return unauthorized();
    // Locally, an unset secret means "developer has not configured it", and
    // blocking would just make people disable the middleware.
    return NextResponse.next();
  }

  // 1. The cookie, which is how every request after the first one arrives.
  const cookie = request.cookies.get(COOKIE)?.value;
  if (cookie !== undefined && safeEqual(cookie, secret)) return NextResponse.next();

  // 2. Basic auth, for curl and for scripts.
  const basic = secretFromBasicAuth(request.headers.get('authorization'));
  if (basic !== null && safeEqual(basic, secret)) return NextResponse.next();

  // 3. `?access=…` — the way a person gets in the first time. Mint the cookie and
  //    redirect to the same URL without the parameter, so the secret does not sit
  //    in the address bar, the browser history, or a `Referer` header on the next
  //    outbound link.
  const provided = searchParams.get(QUERY_PARAM);
  if (provided !== null && safeEqual(provided, secret)) {
    const target = request.nextUrl.clone();
    target.searchParams.delete(QUERY_PARAM);

    const response = NextResponse.redirect(target);
    response.cookies.set(COOKIE, secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  return unauthorized();
}

export const config = {
  /**
   * Everything except Next's own static output. Pages *and* API routes — the hole
   * was that `/api/journal` served real data, so an app-shell-only gate would have
   * missed the part that mattered.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
