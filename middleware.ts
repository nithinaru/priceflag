/**
 * Who is allowed to see a Priceflag page.
 *
 * There is exactly one way to become somebody here: install the Shopify app.
 * `/api/auth` starts it, `/api/auth/callback` finishes it, and finishing it
 * mints the `pf_user` cookie this file checks. There is no sign-up step before
 * that, no emailed link, and — since the store *is* the account — no shared
 * preview secret standing in front of the whole deployment any more.
 *
 * ## What this is NOT
 *
 * This is not authorisation for anything that touches money. Admission here
 * decides whether a browser may render a page. Every price write independently
 * requires a Shopify session token in the route handler and derives its tenant
 * only from the signed `dest` claim. A `pf_user` cookie identifies a store; it
 * never authorises a write.
 *
 * ## Two ways in, checked in order
 *
 * 1. **Shopify-signed traffic.** A merchant in the admin iframe presents no
 *    cookie of ours at all, and a Shopify signature is a stronger claim than any
 *    cookie: a valid `pf_shop` cookie (minted by `POST /api/auth/session`), a
 *    valid App Bridge session token (`Authorization: Bearer` or the `id_token`
 *    launch parameter), or launch params signed with Shopify's query `hmac` and
 *    bounded to five minutes against replay. All verified with `crypto.subtle` —
 *    this is the edge runtime and `node:crypto` does not exist here.
 *
 * 2. **A valid `pf_user` cookie**, HMAC-signed by the OAuth callback over
 *    `{shops.id}.{email}.{expiry}`.
 *
 * Anything else is sent to `/signin`, which is one field and one button.
 *
 * ## The exemptions, and why each one is safe
 *
 * These paths are reachable unsigned because each authenticates itself, and each
 * would break if it could not be reached without a cookie:
 *
 *   - `/api/cron/evaluate` — `CRON_SECRET` bearer, constant-time. The GitHub
 *     Actions evaluator calls it.
 *   - `/api/webhooks/*` — Shopify HMAC over the raw body. Shopify cannot send a
 *     cookie, so gating this would silently kill order ingestion.
 *   - `/api/health` — reports capability booleans and no data. Deliberately open
 *     so uptime checks work without a credential.
 *   - `/api/auth` and `/api/auth/callback` — the OAuth round-trip, which is also
 *     the sign-up. Shopify's browser redirects arrive with no cookie and no way
 *     to get one; the callback authenticates itself with Shopify's query HMAC
 *     plus the single-use state nonce.
 *   - `/api/auth/demo` — mints a demo session, and only ever exists where
 *     `PRICEFLAG_MODE=demo`. It is a 404 on a real deployment.
 *   - `/signin` — the door. Gating the sign-in screen behind a credential was
 *     what produced the old "Priceflag demo" password dialog.
 *   - `/auth/*` — sign-out, which has to run for somebody whose session is
 *     already the thing being discarded.
 *   - `/api/ml/ingest` and `/api/ml/export` — `ML_INGEST_SECRET` bearer,
 *     constant-time. The nightly worker has no browser cookie.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canonicalSessionUrl, isAliasEntryHost, isBrandedEntryHost } from '@/lib/auth/session-host';

const EXEMPT_EXACT = new Set([
  '/api/health',
  '/api/cron/evaluate',
  '/api/ml/ingest',
  '/api/ml/export',
  // The OAuth round-trip, which is the whole sign-up. Both ends arrive from
  // Shopify's browser redirects with no cookie of ours.
  '/api/auth',
  '/api/auth/callback',
  // Demo mode's stand-in for an install. 404 unless PRICEFLAG_MODE=demo.
  '/api/auth/demo',
  '/signin',
]);
const EXEMPT_PREFIX = ['/api/webhooks/'];

function isExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  return EXEMPT_PREFIX.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Everything below `/auth/` runs for somebody who is being signed out, so it
 * cannot itself require a session.
 */
const ACCOUNT_EXEMPT_PREFIX = ['/auth/'];

function needsAccount(pathname: string): boolean {
  return !ACCOUNT_EXEMPT_PREFIX.some((prefix) => pathname.startsWith(prefix));
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

/** Cookie minted by `POST /api/auth/session`: `{shop_domain}.{expiry}.{sig}`. */
const SHOP_COOKIE = 'pf_shop';

/** Cookie minted by `/api/auth/callback` when an install completes. See `lib/auth/account.ts`. */
const USER_COOKIE = 'pf_user';

/** Optional override so the static marketing sign-in page still works if set. */
const SIGNIN_URL = process.env.SIGNIN_URL;

/** Clock skew tolerance for session tokens, matching `lib/shopify/session.ts`. */
const JWT_LEEWAY_SECONDS = 5;

/** Tight replay bound for hmac-signed launch params. */
const LAUNCH_MAX_AGE_SECONDS = 5 * 60;

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url segment → UTF-8 string, or null on malformed input. */
function decodeBase64UrlUtf8(segment: string): string | null {
  try {
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * `pf_shop` cookie check. Signature over `{shop_domain}.{expiry}`, parsed from
 * the right because the domain itself contains dots. Mirrors `verifyShopCookie`
 * in `lib/shopify/session.ts`, which cannot be imported here (node:crypto).
 */
async function isValidShopCookie(value: string, clientSecret: string): Promise<boolean> {
  const sigIndex = value.lastIndexOf('.');
  if (sigIndex === -1) return false;
  const sig = value.slice(sigIndex + 1);
  const payload = value.slice(0, sigIndex);
  const expIndex = payload.lastIndexOf('.');
  if (expIndex === -1) return false;
  const expiryRaw = payload.slice(expIndex + 1);
  if (!/^\d+$/.test(expiryRaw)) return false;

  const expected = toBase64Url(await hmacSha256(clientSecret, payload));
  if (!safeEqual(expected, sig)) return false;
  return Number(expiryRaw) >= Math.floor(Date.now() / 1000);
}

/**
 * `pf_user` account session: `{userId}.{emailBase64Url}.{expiry}.{sig}`.
 *
 * The edge-runtime twin of `verifyUserCookie` in `lib/auth/account.ts` — same
 * reason as `isValidShopCookie` above, that module needs node:crypto.
 *
 * The two must accept **exactly** the same set of values. A cookie this admits
 * but `verifyUserCookie` then rejects is not a security hole (both need the
 * signing secret) but it is a trap: middleware waves the request through, the
 * route handler sees no session, and the person is bounced back to a sign-in
 * they have already completed with no way out. `tests/auth-account.test.ts`
 * pins the agreement, including the shape checks below.
 */
async function isValidUserCookie(value: string): Promise<boolean> {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) return false;

  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const [userId, emailEncoded, expiryRaw, sig] = parts as [string, string, string, string];
  if (!/^\d+$/.test(expiryRaw)) return false;

  const expected = toBase64Url(await hmacSha256(secret, `${userId}.${emailEncoded}.${expiryRaw}`));
  if (!safeEqual(expected, sig)) return false;
  if (Number(expiryRaw) < Math.floor(Date.now() / 1000)) return false;

  // Shape checks after the signature, mirroring `verifyUserCookie` exactly:
  // a UUID user id, and an email segment that round-trips through base64url.
  if (!/^[0-9a-fA-F-]{36}$/.test(userId)) return false;
  const email = decodeBase64UrlUtf8(emailEncoded);
  if (email === null || !email.includes('@')) return false;
  return toBase64Url(new TextEncoder().encode(email)) === emailEncoded;
}

async function hasAccountSession(request: NextRequest): Promise<boolean> {
  const cookie = request.cookies.get(USER_COOKIE)?.value;
  return cookie !== undefined && (await isValidUserCookie(cookie));
}

/**
 * App Bridge session token (JWT, HS256). A reimplementation of
 * `verifySessionToken` in `lib/shopify/session.ts` for the edge runtime — keep
 * the claim checks in lockstep with that file.
 */
async function isValidSessionToken(token: string, clientId: string, clientSecret: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const headerJson = decodeBase64UrlUtf8(headerB64);
  const payloadJson = decodeBase64UrlUtf8(payloadB64);
  if (headerJson === null || payloadJson === null) return false;

  let header: { alg?: string };
  let claims: { exp?: number; nbf?: number; aud?: string; dest?: string; iss?: string };
  try {
    header = JSON.parse(headerJson) as { alg?: string };
    claims = JSON.parse(payloadJson) as typeof claims;
  } catch {
    return false;
  }

  // Pin the algorithm — accepting the token's own `alg` is the classic JWT hole.
  if (header.alg !== 'HS256') return false;

  const expected = toBase64Url(await hmacSha256(clientSecret, `${headerB64}.${payloadB64}`));
  if (!safeEqual(expected, signatureB64)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + JWT_LEEWAY_SECONDS < now) return false;
  if (typeof claims.nbf === 'number' && claims.nbf - JWT_LEEWAY_SECONDS > now) return false;
  if (claims.aud !== clientId) return false;
  if (typeof claims.dest !== 'string' || typeof claims.iss !== 'string') return false;
  const expectedIssuer = `${claims.dest.replace(/\/$/, '')}/admin`;
  return claims.iss === expectedIssuer;
}

/**
 * Shopify iframe launch params: HMAC-SHA256 hex over the sorted `key=value`
 * pairs, `hmac` itself excluded — the same scheme as the OAuth callback
 * (`lib/shopify/hmac.ts`, ported here because node:crypto is unavailable).
 */
async function isValidLaunchRequest(searchParams: URLSearchParams, clientSecret: string): Promise<boolean> {
  const hmac = searchParams.get('hmac');
  const shop = searchParams.get('shop');
  const timestamp = searchParams.get('timestamp');
  if (!hmac || !shop || !timestamp) return false;

  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() / 1000 - issuedAt) > LAUNCH_MAX_AGE_SECONDS) {
    return false;
  }

  const pairs: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === 'hmac') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const digest = toHex(await hmacSha256(clientSecret, pairs.join('&')));
  return safeEqual(digest, hmac);
}

/** `Authorization: Bearer <token>`, or null. */
function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/**
 * Is this request carrying any credential Shopify signed? Checked cheapest
 * first, and only when the corresponding material is actually present — the
 * common non-embedded request pays for nothing.
 */
async function isShopifyAuthenticated(request: NextRequest): Promise<boolean> {
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  const clientId = process.env.SHOPIFY_API_KEY;
  if (!clientSecret || !clientId) return false;

  const shopCookie = request.cookies.get(SHOP_COOKIE)?.value;
  if (shopCookie !== undefined && (await isValidShopCookie(shopCookie, clientSecret))) return true;

  const bearer = bearerToken(request.headers.get('authorization'));
  if (bearer !== null && (await isValidSessionToken(bearer, clientId, clientSecret))) return true;

  const { searchParams } = request.nextUrl;
  const idToken = searchParams.get('id_token');
  if (idToken !== null && (await isValidSessionToken(idToken, clientId, clientSecret))) return true;

  if (searchParams.get('hmac') !== null && (await isValidLaunchRequest(searchParams, clientSecret))) {
    return true;
  }

  return false;
}

/** In-app `/signin`. Ignore SIGNIN_URL when it points at a marketing/alias host. */
function signInScreenTarget(request: NextRequest): URL {
  if (SIGNIN_URL !== undefined && SIGNIN_URL !== '') {
    try {
      const configured = new URL(SIGNIN_URL);
      if (!isBrandedEntryHost(configured.hostname) && !isAliasEntryHost(configured.hostname)) {
        return configured;
      }
    } catch {
      // Fall through to the in-app screen rather than 500 a signed-out visitor.
    }
  }
  const target = request.nextUrl.clone();
  target.pathname = '/signin';
  target.search = '';
  target.hash = '';
  return target;
}

/**
 * Not signed in. An API caller gets a JSON 401 it can act on; a browser gets the
 * sign-in screen, with the path it was reaching for so it can be returned there
 * afterwards.
 */
function signInRequired(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith('/api/')) {
    return new NextResponse(
      JSON.stringify({
        error: {
          code: 'sign_in_required',
          message: 'Sign in to continue, or open Priceflag from your Shopify admin.',
          retryable: false,
          details: null,
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }

  const target = signInScreenTarget(request);
  // The screen distinguishes "arrived cold" from "was bounced here"; this code
  // is what lets it say why the app sent the visitor back.
  target.searchParams.set('error', 'sign_in_required');
  // No `?next=`. Sign-in now leaves through Shopify's authorize screen and comes
  // back to a redirect_uri Shopify has allow-listed, so a destination carried
  // from here could not survive the round trip anyway — and a `next` parameter
  // that goes nowhere is just an open-redirect sink waiting to be found.

  const response = NextResponse.redirect(target, { status: 303 });
  response.headers.set('cache-control', 'no-store');
  return response;
}


export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Alias hosts (signin./product.) are not session hosts: cookies are host-only,
  // so anything minted there would be invisible to the dashboard. Move first,
  // before any cookie is read, and keep OAuth callbacks' query intact.
  const sessionUrl = canonicalSessionUrl(request.nextUrl.hostname, pathname, request.nextUrl.search);
  if (sessionUrl !== null) {
    return NextResponse.redirect(sessionUrl, 308);
  }

  if (isExempt(pathname)) return NextResponse.next();

  // A Shopify signature beats a cookie, and a merchant in the admin iframe has
  // no cookie of ours to present.
  if (await isShopifyAuthenticated(request)) return NextResponse.next();

  if (await hasAccountSession(request)) return NextResponse.next();

  // Sign-out and anything else under `/auth/` has to run without a session.
  if (!needsAccount(pathname)) return NextResponse.next();

  return signInRequired(request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
