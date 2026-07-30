/**
 * Embedded app session tokens.
 *
 * App Bridge sends a short-lived JWT (HS256, signed with the app's client secret)
 * on requests from the embedded admin. Verifying it is what turns "some browser
 * claims to be shop X" into "Shopify asserts this is shop X", and it is the only
 * thing standing between one merchant's request and another merchant's prices.
 *
 * Implemented directly on `node:crypto` rather than pulling in a JWT library: the
 * verification is forty lines, and the checks that matter here are the *claim*
 * checks below, which a library would not make for us anyway.
 */

import { createHmac } from 'node:crypto';

import { env, requireEnv } from '../config';
import { safeEqual } from '../crypto';
import { normalizeShopDomain, ShopifyAuthError } from './oauth';

/** Clock skew tolerance, in seconds. Shopify's own libraries allow 5s. */
const LEEWAY_SECONDS = 5;

export interface SessionTokenClaims {
  /** `https://{shop}/admin` — who issued it. */
  iss: string;
  /** `https://{shop}` — which shop it is for. This is the authority on the shop. */
  dest: string;
  /** Must equal our client id. */
  aud: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid?: string;
}

export interface VerifiedSession {
  shopDomain: string;
  claims: SessionTokenClaims;
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a session token and return the shop it authorises.
 *
 * Never trust a `shop` query parameter when a session token is present: the token
 * is signed and the query parameter is not.
 */
export function verifySessionToken(
  token: string,
  options: { clientId?: string; clientSecret?: string; now?: Date } = {},
): VerifiedSession {
  const clientId = options.clientId ?? requireEnv('SHOPIFY_API_KEY');
  const clientSecret = options.clientSecret ?? requireEnv('SHOPIFY_API_SECRET');
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new ShopifyAuthError('invalid_hmac', 'session token is not a three-part JWT');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  let claims: Partial<SessionTokenClaims>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg?: string };
    claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as Partial<SessionTokenClaims>;
  } catch {
    throw new ShopifyAuthError('invalid_hmac', 'session token header or payload is not JSON');
  }

  // Pin the algorithm. Accepting whatever `alg` the token asks for is the classic
  // JWT vulnerability — `none` would make every token valid.
  if (header.alg !== 'HS256') {
    throw new ShopifyAuthError('invalid_hmac', `unexpected session token algorithm ${String(header.alg)}`);
  }

  const expected = createHmac('sha256', clientSecret)
    .update(`${headerB64}.${payloadB64}`, 'utf8')
    .digest('base64url');
  if (!safeEqual(expected, signatureB64)) {
    throw new ShopifyAuthError('invalid_hmac', 'session token signature does not verify');
  }

  // --- claims ---
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < nowSeconds) {
    throw new ShopifyAuthError('invalid_hmac', 'session token has expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > nowSeconds) {
    throw new ShopifyAuthError('invalid_hmac', 'session token is not valid yet');
  }
  // `aud` must be us: a validly-signed token for a different app is not ours to
  // honour, and on a shared secret mistake it would otherwise pass.
  if (claims.aud !== clientId) {
    throw new ShopifyAuthError('invalid_hmac', 'session token was issued for a different app');
  }
  if (typeof claims.dest !== 'string' || typeof claims.iss !== 'string') {
    throw new ShopifyAuthError('invalid_hmac', 'session token is missing dest or iss');
  }
  // `iss` is `{dest}/admin`, so a token whose issuer is a different shop than its
  // destination is malformed or forged.
  if (!claims.iss.startsWith(claims.dest)) {
    throw new ShopifyAuthError('invalid_hmac', 'session token iss and dest disagree');
  }

  const shopDomain = normalizeShopDomain(claims.dest.replace(/^https?:\/\//, ''));

  return { shopDomain, claims: claims as SessionTokenClaims };
}

/** `Authorization: Bearer <token>` on requests from the embedded admin. */
export function sessionTokenFromRequest(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/**
 * Resolve which shop a request is allowed to act on.
 *
 * A session token wins whenever one is present. The `?shop=` fallback exists only
 * so the app is usable before B2's embedding is wired up and while running the
 * demo store, and it is **refused in production** — a shop taken from a query
 * parameter is an authorisation hole, not a convenience.
 */
export function resolveShopFromRequest(
  request: Request,
  options: { allowQueryParam?: boolean; now?: Date } = {},
): { shopDomain: string; source: 'session_token' | 'query' } {
  const token = sessionTokenFromRequest(request);
  if (token !== null) {
    return { shopDomain: verifySessionToken(token, { now: options.now }).shopDomain, source: 'session_token' };
  }

  const isProduction = env('VERCEL_ENV') === 'production' || env('NODE_ENV') === 'production';
  const allowQuery = options.allowQueryParam ?? !isProduction;
  if (!allowQuery) {
    throw new ShopifyAuthError('invalid_hmac', 'missing session token');
  }

  const shop = new URL(request.url).searchParams.get('shop');
  if (shop === null) {
    throw new ShopifyAuthError('invalid_shop_domain', 'no session token and no ?shop= parameter');
  }
  return { shopDomain: normalizeShopDomain(shop), source: 'query' };
}
