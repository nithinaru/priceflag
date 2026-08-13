/**
 * Where the sign-in screen lives, and the cross-origin rules for talking to it.
 *
 * Exactly one outside origin is allowed to POST an email address to us: the sign-in
 * screen. It is a static page on its own host, so the browser treats the call as
 * cross-origin and will not make it without these headers.
 *
 * An allowlist rather than `*` because this endpoint sends email on request —
 * a wildcard would let any page on the internet use our Supabase quota to mail
 * arbitrary addresses a Priceflag link.
 */

import { env } from '../config';

const DEFAULT_ORIGINS = ['https://signin.priceflag.org'];

function allowlist(): string[] {
  const configured = env('SIGNIN_ORIGINS');
  const origins =
    configured === undefined
      ? DEFAULT_ORIGINS
      : configured.split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');

  // Local dev serves the sign-in page off the filesystem or a throwaway port,
  // and neither is worth an env var. Never in production.
  if (env('NODE_ENV') !== 'production') {
    return [...origins, 'http://localhost:3000', 'http://localhost:4000', 'http://127.0.0.1:4000'];
  }
  return origins;
}

/** The origin to echo back, or `null` if this caller is not on the list. */
export function allowedOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  return allowlist().includes(origin) ? origin : null;
}

/**
 * The sign-in screen itself — the first entry in the allowlist.
 *
 * Every "you are not signed in" path in the app ends here rather than at a
 * signed-out page of its own. There is one screen that knows how to ask for an
 * email address, it lives on its own host with the hero image, and a lesser
 * copy of it inside the app shell would only be a second thing to keep in step.
 */
export function signInScreenUrl(params: Record<string, string> = {}): string {
  const url = new URL(allowlist()[0] ?? (DEFAULT_ORIGINS[0] as string));
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
