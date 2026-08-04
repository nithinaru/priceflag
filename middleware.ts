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
 * Merchant routes independently require App Bridge session tokens and derive
 * their tenant only from the signed `dest` claim. This gate remains the
 * invite-only preview boundary; it is not merchant authentication.
 *
 * ## The exemptions, and why each one is safe
 *
 * These paths bypass the gate because each already authenticates itself, and each
 * would break if it could not be reached without a browser cookie:
 *
 *   - `/api/cron/evaluate` — `CRON_SECRET` bearer, constant-time. The GitHub
 *     Actions evaluator calls it; adding the gate secret there would just be a
 *     second shared secret guarding the same door.
 *   - `/api/webhooks/*` — Shopify HMAC over the raw body. Shopify cannot send a
 *     cookie, so gating this would silently kill order ingestion.
 *   - `/api/health` — reports capability booleans and no data. Deliberately open
 *     so uptime checks work without a credential.
 *   - `/api/auth` and `/api/auth/callback` — the OAuth round-trip. Shopify's
 *     browser redirects arrive with no cookie and no way to get one; the
 *     callback authenticates itself with Shopify's query HMAC + the state nonce.
 *
 *   - `/api/ml/ingest` — `ML_INGEST_SECRET` bearer, constant-time. The nightly
 *     worker has no browser cookie and this dedicated credential is its sole
 *     write authority.
 *
 * ## Embedded (Shopify admin) traffic
 *
 * The gate's `pf_access` cookie is SameSite=Lax, which a third-party iframe never
 * sends — so without more, embedding the app in the Shopify admin is structurally
 * impossible. A request is therefore ALSO admitted when it carries a credential
 * Shopify signed (all verified with `crypto.subtle` — this is the edge runtime,
 * `node:crypto` does not exist here):
 *
 *   - a valid `pf_shop` cookie (HMAC-signed by `POST /api/auth/session` after a
 *     session-token verification);
 *   - a valid App Bridge session token (`Authorization: Bearer` or the
 *     `id_token` launch parameter) — HS256, alg pinned, `aud`/`exp`/`dest`
 *     checked, mirroring `lib/shopify/session.ts`;
 *   - iframe launch params signed with Shopify's query `hmac` (same scheme as
 *     the OAuth callback), bounded to five minutes against replay.
 *
 * Admission here does NOT mint `pf_access` — shop-scoped identity is the page
 * session's job (`app/api/auth/session` mints `pf_shop`), and conflating the two
 * cookies would let a one-time launch URL mint the long-lived shared secret.
 */

import { NextResponse, type NextRequest } from 'next/server';

/** Cookie name. Deliberately not obviously guessable from the product name. */
const COOKIE = 'pf_access';

/**
 * Demo credentials for reviewers (YC and similar), separate from
 * `APP_ACCESS_SECRET` on purpose so they can be revoked the day the review ends
 * without breaking `cp4-chain.ts`, `smoke-browser.ts` or any `?access=` link.
 *
 * The cookie a demo login mints holds the **demo password**, not the access
 * secret. If it held the secret, clearing `DEMO_PASSWORD` would leave every
 * reviewer's 30-day cookie working — revocation that does not revoke. This way
 * unsetting the password invalidates their sessions on the next request.
 */
const DEMO_COOKIE_DAYS = 7;

/** Query parameter that mints the cookie: `?access=…` once, then it is stripped. */
const QUERY_PARAM = 'access';

const EXEMPT_EXACT = new Set([
  '/api/health',
  '/api/cron/evaluate',
  '/api/ml/ingest',
  '/api/auth',
  '/api/auth/callback',
]);
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

/** The `user:password` pair from a Basic header, unparsed. */
function basicPair(header: string | null): { user: string; password: string } | null {
  if (header === null) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = atob(match[1] as string);
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

/** Both fields compared in constant time — a username is a secret here too. */
function isDemoLogin(header: string | null): boolean {
  const user = process.env.DEMO_USERNAME;
  const password = process.env.DEMO_PASSWORD;
  if (!user || !password) return false;

  const pair = basicPair(header);
  if (pair === null) return false;

  // Deliberately not short-circuiting: `&&` on the first comparison would leak
  // whether the username was right via timing.
  const userOk = safeEqual(pair.user, user);
  const passwordOk = safeEqual(pair.password, password);
  return userOk && passwordOk;
}

// --- Shopify credential verification (edge runtime, crypto.subtle only) -----

/** Cookie minted by `POST /api/auth/session`: `{shop_domain}.{expiry}.{sig}`. */
const SHOP_COOKIE = 'pf_shop';

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
  // A reviewer reads this string in the browser's credential dialog, so it says
  // what the box is for rather than just the product name.
  response.headers.set('www-authenticate', 'Basic realm="Priceflag demo", charset="UTF-8"');
  // A 401 must never be cached and served to somebody who *is* authorised.
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, searchParams } = request.nextUrl;

  if (isExempt(pathname)) return NextResponse.next();

  // Shopify-signed credentials are stronger than the shared secret, and the
  // embedded admin can never present the SameSite=Lax gate cookie. No pf_access
  // is minted here — see the header comment.
  if (await isShopifyAuthenticated(request)) return NextResponse.next();

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

  // 1. The cookie, which is how every request after the first one arrives. It
  //    carries either the access secret or the demo password; the latter stops
  //    working the moment DEMO_PASSWORD is cleared.
  const cookie = request.cookies.get(COOKIE)?.value;
  if (cookie !== undefined) {
    if (safeEqual(cookie, secret)) return NextResponse.next();
    const demoPassword = process.env.DEMO_PASSWORD;
    if (demoPassword && safeEqual(cookie, demoPassword)) return NextResponse.next();
  }

  // 2. Demo credentials over Basic — what a reviewer types into the browser
  //    dialog. Mint the cookie so they authenticate once and then browse.
  if (isDemoLogin(request.headers.get('authorization'))) {
    const response = NextResponse.next();
    response.cookies.set(COOKIE, process.env.DEMO_PASSWORD as string, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: 60 * 60 * 24 * DEMO_COOKIE_DAYS,
    });
    return response;
  }

  // 3. The access secret over Basic, for curl and for scripts.
  const basic = secretFromBasicAuth(request.headers.get('authorization'));
  if (basic !== null && safeEqual(basic, secret)) return NextResponse.next();

  // 4. `?access=…` — the way a person gets in the first time. Mint the cookie and
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
