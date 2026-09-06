/**
 * Where the sign-in screen lives, and the cross-origin rules for talking to it.
 *
 * Exactly one family of outside origins is allowed to POST an email address to
 * us: the sign-in screen. The in-app `/signin` page is same-origin; the static
 * marketing page on signin.priceflag.org is not, and the browser will not make
 * that call without these headers.
 *
 * An allowlist rather than `*` because this endpoint sends email on request —
 * a wildcard would let any page on the internet use our Supabase quota to mail
 * arbitrary addresses a Priceflag link.
 */

import { env, getAppUrl } from '../config';
import { isAliasEntryHost, isBrandedEntryHost, sessionOrigin } from './session-host';

const MARKETING_ORIGIN = 'https://signin.priceflag.org';

function appOrigin(): string {
  try {
    return new URL(getAppUrl()).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    try {
      return new URL(value, getAppUrl()).origin;
    } catch {
      return null;
    }
  }
}

function allowlist(): string[] {
  const configured = env('SIGNIN_ORIGINS');
  const origins =
    configured === undefined
      ? [MARKETING_ORIGIN]
      : configured.split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');

  const extras = [MARKETING_ORIGIN, appOrigin()];
  const signInUrl = env('SIGNIN_URL');
  if (signInUrl !== undefined) {
    const extra = originOf(signInUrl);
    if (extra !== null) extras.push(extra);
  }

  const merged = [...new Set([...origins, ...extras])];

  // Local dev serves the sign-in page off the filesystem or a throwaway port,
  // and neither is worth an env var. Never in production.
  if (env('NODE_ENV') !== 'production') {
    return [...new Set([...merged, 'http://localhost:3000', 'http://localhost:4000', 'http://127.0.0.1:4000'])];
  }
  return merged;
}

/** The origin to echo back, or `null` if this caller is not on the list. */
export function allowedOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  return allowlist().includes(origin) ? origin : null;
}

/**
 * The sign-in screen itself.
 *
 * Defaults to this app's `/signin` on the session host. `SIGNIN_URL` still
 * overrides for a non-marketing origin; a value on signin.priceflag.org is
 * ignored so signed-out visitors are not sent to the static `/signin.html`.
 */
export function signInScreenUrl(params: Record<string, string> = {}): string {
  const configured = env('SIGNIN_URL');
  let url: URL | undefined;
  if (configured !== undefined) {
    try {
      url = new URL(configured);
      if (isBrandedEntryHost(url.hostname) || isAliasEntryHost(url.hostname)) {
        url = undefined;
      }
    } catch {
      url = new URL(configured, `${sessionOrigin()}/`);
    }
  }
  if (url === undefined) {
    url = new URL('/signin', `${sessionOrigin()}/`);
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    // Echoing the request origin, never `*`. That is required rather than
    // stylistic: `*` is illegal alongside allow-credentials, and the browser
    // would refuse the whole response.
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    // The send sets the link-binding cookie (`lib/auth/link-binding.ts`), and a
    // cross-origin fetch only stores a Set-Cookie when both sides opt in — this
    // header plus `credentials: 'include'` on the caller.
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '86400',
    // The response varies by request origin, so a cache must not serve one
    // origin's CORS headers to another.
    vary: 'Origin',
  };
}
