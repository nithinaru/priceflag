/**
 * Binding a magic link to the browser that asked for it.
 *
 * ## The attack this exists to stop
 *
 * A magic link, on its own, authenticates *whoever opens it* — not whoever
 * requested it. That asymmetry is a session fixation primitive:
 *
 *   1. The attacker asks for a link to **their own** address. Anyone may do
 *      this; the endpoint is public by design so the sign-in screen works.
 *   2. They do not click it. They forward it to the victim as "your Priceflag
 *      dashboard link".
 *   3. The victim clicks, and their browser is now holding a 30-day session for
 *      the *attacker's* account. Everything the victim does lands in it, and any
 *      store they go on to connect is recorded as the attacker's.
 *
 * Nothing about that requires CSRF, XSS, or reading the victim's email.
 *
 * ## The fix
 *
 * A nonce, generated when the link is sent, stored two places: in an HttpOnly
 * cookie on this browser, and in the link itself. The callback requires them to
 * match. The attacker can produce a link, but they cannot put their nonce cookie
 * in the victim's browser, so a forwarded link fails.
 *
 * ## Why a plain cookie is enough here
 *
 * `signin.priceflag.org` and `dashboard.priceflag.org` are different *origins*
 * but the same *site*, so this is same-site and SameSite=Lax applies normally on
 * the email click, which is a top-level navigation. The send itself is a
 * cross-origin fetch, so it needs `credentials: 'include'` on the caller and
 * `Access-Control-Allow-Credentials` on the response for the browser to store
 * what we set — see `lib/auth/signin-origin.ts`.
 */

import { randomBytes } from 'node:crypto';

import { safeEqual } from '../crypto';

export const LINK_NONCE_COOKIE = 'pf_link';

/**
 * An hour, matching Supabase's own magic-link lifetime. A longer window would
 * only keep a nonce alive after the link it guards had already expired.
 */
export const LINK_NONCE_MAX_AGE_SECONDS = 60 * 60;

/** The query parameter carrying the nonce in the emailed link. */
export const LINK_NONCE_PARAM = 'bind';

export function createLinkNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function linkNonceCookieOptions(isHttps: boolean): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax: the cookie has to survive the top-level navigation from the email
    // client back to us, which is exactly the case Lax permits.
    sameSite: 'lax',
    secure: isHttps,
    // Scoped to the callback, not the whole app: nothing else has any use for it.
    path: '/auth',
    maxAge: LINK_NONCE_MAX_AGE_SECONDS,
  };
}

/**
 * Does the nonce in the link match the one in this browser?
 *
 * Constant-time, and false whenever either side is missing — an absent cookie is
 * the ordinary "this link was opened somewhere else" case, which is precisely
 * what we are refusing.
 */
export function linkNonceMatches(fromLink: string | null, fromCookie: string | undefined): boolean {
  if (fromLink === null || fromLink === '' || fromCookie === undefined || fromCookie === '') {
    return false;
  }
  return safeEqual(fromLink, fromCookie);
}

/**
 * Who started this Shopify install?
 *
 * Recorded when the OAuth round-trip *begins* rather than read from whatever
 * `pf_user` happens to be present when it ends. The difference is intent: the
 * end of the flow is reachable by sending somebody a link, whereas this cookie
 * only exists because a signed-in browser asked us to start an install.
 *
 * It is what turns "an account was signed in at the time" into "this account
 * asked to connect this store", which is the claim `account_shops` is actually
 * making. Ten minutes because an OAuth round-trip that takes longer than that
 * has already failed.
 */
export const INSTALL_INITIATOR_COOKIE = 'pf_installer';
export const INSTALL_INITIATOR_MAX_AGE_SECONDS = 10 * 60;

export function installInitiatorCookieOptions(isHttps: boolean): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // Lax so it survives Shopify's top-level redirect back to the callback.
    sameSite: 'lax',
    secure: isHttps,
    path: '/api/auth',
    maxAge: INSTALL_INITIATOR_MAX_AGE_SECONDS,
  };
}
