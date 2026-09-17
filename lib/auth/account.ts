/**
 * Account sessions — the `pf_user` cookie.
 *
 * Priceflag has two independent notions of "who is this": the shop (asserted by
 * Shopify, via a session token or the `pf_shop` cookie) and the *account* (the
 * owner of a store that has completed an install). They answer different
 * questions and must never be conflated:
 *
 *   - `pf_shop` says "Shopify vouches that this browser is acting for store X".
 *     It is the authority for reading and writing that store's prices.
 *   - `pf_user` says "this browser finished an install for store X". It is the
 *     authority for *reaching* the app outside the Shopify admin, and nothing
 *     more. Its `userId` is the `shops.id` uuid (see `store-account.ts`), so it
 *     resolves to a store by construction rather than by lookup.
 *
 * A merchant entering from the Shopify admin has the first and not the second; a
 * merchant opening dashboard.priceflag.org directly has the second and not the
 * first. Both are legitimate ways in, so `middleware.ts` accepts either.
 *
 * Why a self-signed cookie rather than an opaque session row: `middleware`
 * runs on the edge runtime, and this format can be verified there with Web
 * Crypto and no network call, exactly as `verifyShopCookie` already is. A
 * session table would put a database round-trip in front of every page.
 *
 * Format: `{userId}.{emailBase64Url}.{expiry}.{sig}` — the email is encoded so
 * that every segment is dot-free and the value parses by splitting on '.'.
 */

import { createHmac } from 'node:crypto';

import { env, requireEnv } from '../config';
import { safeEqual } from '../crypto';

export const USER_COOKIE = 'pf_user';

/**
 * Thirty days. Longer than `pf_shop` (ten minutes) on purpose: `pf_shop` is
 * refreshed by App Bridge on every embedded page load and only ever stands in
 * for a session token, whereas this is the "stay signed in" cookie a person
 * expects not to have to renew every time they open the tab.
 */
export const USER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AccountSession {
  userId: string;
  email: string;
}

/**
 * The signing key. Its own secret, and never shared with anything else: forging
 * this cookie is forging an identity, so it must not be possible for anyone
 * holding some other Priceflag credential to mint one.
 */
function signingSecret(): string {
  return requireEnv(
    'AUTH_SESSION_SECRET',
    'Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
}

function encodeEmail(email: string): string {
  return Buffer.from(email, 'utf8').toString('base64url');
}

function decodeEmail(encoded: string): string | null {
  try {
    const email = Buffer.from(encoded, 'base64url').toString('utf8');
    // Round-trip check: base64url decoding is lenient and will happily turn
    // near-anything into bytes, so confirm this is what we would have written.
    return encodeEmail(email) === encoded && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

export function signUserCookie(
  session: AccountSession,
  options: { secret?: string; now?: Date } = {},
): string {
  const secret = options.secret ?? signingSecret();
  const expiry =
    Math.floor((options.now ?? new Date()).getTime() / 1000) + USER_COOKIE_MAX_AGE_SECONDS;
  const payload = `${session.userId}.${encodeEmail(session.email)}.${expiry}`;
  const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * The account a cookie value authorises, or `null`. Never throws — a malformed
 * or expired cookie is an ordinary "not signed in", not an error condition.
 */
export function verifyUserCookie(
  value: string,
  options: { secret?: string; now?: Date } = {},
): AccountSession | null {
  const secret = options.secret ?? env('AUTH_SESSION_SECRET');
  if (secret === undefined) return null;

  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [userId, emailEncoded, expiryRaw, sig] = parts as [string, string, string, string];

  if (!/^\d+$/.test(expiryRaw)) return null;

  const payload = `${userId}.${emailEncoded}.${expiryRaw}`;
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  if (!safeEqual(expected, sig)) return null;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Number(expiryRaw) < nowSeconds) return null;

  // Shape check after the signature check, never before: only values we signed
  // get this far, so a failure here means our own writer changed, not an attack.
  if (!/^[0-9a-fA-F-]{36}$/.test(userId)) return null;
  const email = decodeEmail(emailEncoded);
  if (email === null) return null;

  return { userId, email };
}

/** Cookie options shared by the routes that mint and clear the session. */
export function userCookieOptions(isHttps: boolean): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax, not None: this cookie is for the first-party dashboard host only. The
    // embedded Shopify iframe is third-party context and uses `pf_shop`, which
    // is SameSite=None for exactly that reason.
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    // Always host-only. `AUTH_COOKIE_DOMAIN=.priceflag.org` would also send
    // `pf_user` to signin.priceflag.org and the marketing site; those hosts
    // must not hold the session (`lib/auth/session-host.ts`).
    maxAge: USER_COOKIE_MAX_AGE_SECONDS,
  };
}
