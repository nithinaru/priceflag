/**
 * `GET /auth/callback` — the other end of the magic link.
 *
 * Supabase can deliver a clicked link in two shapes, and which one you get
 * depends on the email template, so this handles both:
 *
 *   1. `?token_hash=…&type=magiclink` — the server-side shape. We verify it with
 *      Supabase and mint the session here, with no JavaScript involved. This is
 *      what the template in `docs/auth-setup.md` produces, and it is preferred:
 *      nothing sensitive is ever exposed to the page.
 *   2. `#access_token=…` in the URL fragment — what the stock Supabase template
 *      produces. A fragment never reaches the server, so the page below hands it
 *      back to us as a POST. Supported so that a deployment still works if the
 *      email template has not been customised yet.
 *
 * Either way the outcome is the same: verify with Supabase, then mint our own
 * `pf_user` cookie (`lib/auth/account.ts`) and send the person into the app.
 * The Supabase tokens themselves are not kept — the account session is a
 * question we can answer ourselves from that point on.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAppUrl } from '@/lib/config';
import { createAuthClient, hasAuthConfig } from '@/lib/auth/supabase-auth';
import { signInScreenUrl } from '@/lib/auth/signin-origin';
import { safeDestination } from '@/lib/auth/redirect';
import {
  LINK_NONCE_COOKIE,
  LINK_NONCE_PARAM,
  linkNonceCookieOptions,
  linkNonceMatches,
} from '@/lib/auth/link-binding';
import { signUserCookie, USER_COOKIE, userCookieOptions } from '@/lib/auth/account';
import { rememberAccount } from '@/lib/auth/account-shops';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Where to land after a successful sign-in. Overridable with `?next=`. */
const DEFAULT_DESTINATION = '/';

/** Resolve-and-compare, not a prefix test. See `lib/auth/redirect.ts`. */
function destinationFrom(raw: string | null): string {
  return safeDestination(raw, getAppUrl());
}

/**
 * Send a failed sign-in back to the screen that can do something about it, with
 * a reason it knows how to phrase. An expired link is the common case by a wide
 * margin, and the useful response to it is a fresh one.
 */
function failure(reason: string, next?: string): NextResponse {
  const params: Record<string, string> = { error: reason };
  // Carry the destination through the retry: the screen forwards `next` when it
  // mints a fresh link, so an expired link re-request keeps where it was going.
  // Already sanitized by `destinationFrom`; the default is noise, so drop it.
  if (next !== undefined && next !== DEFAULT_DESTINATION) params.next = next;
  return NextResponse.redirect(signInScreenUrl(params), { status: 303 });
}

async function establishSession(
  userId: string,
  email: string,
  destination: string,
): Promise<NextResponse> {
  // Record the account so the connect step has a row to attach a shop to, and so
  // there is a list of who has signed up. Best-effort on purpose: a database
  // hiccup here must not cost somebody their sign-in, and the only thing lost is
  // a row we can write again on the next visit.
  await rememberAccount(userId, email).catch((cause: unknown) => {
    console.error('account upsert failed', cause);
  });

  const response = NextResponse.redirect(new URL(destination, getAppUrl()), { status: 303 });
  const isHttps = new URL(getAppUrl()).protocol === 'https:';
  response.cookies.set(USER_COOKIE, signUserCookie({ userId, email }), userCookieOptions(isHttps));
  // The nonce is single-use: it has done its job, and leaving it would let a
  // second link minted in this browser be opened anywhere.
  response.cookies.set(LINK_NONCE_COOKIE, '', { ...linkNonceCookieOptions(isHttps), maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const destination = destinationFrom(params.get('next'));

  if (!hasAuthConfig()) return failure('auth_not_configured', destination);

  // Supabase sends `error_description` when a link has already been used or has
  // expired. Both are ordinary and deserve a real message, not a generic one.
  const supabaseError = params.get('error') ?? params.get('error_code');
  if (supabaseError !== null) {
    return failure(supabaseError === 'otp_expired' ? 'link_expired' : 'link_invalid', destination);
  }

  // Was this link opened in the browser that asked for it? A link is otherwise
  // authentication for whoever holds it, and a forwarded one signs the recipient
  // into the sender's account (lib/auth/link-binding.ts).
  //
  // Checked ahead of BOTH link shapes, and before `verifyOtp` consumes anything:
  // an unbound link is refused without being spent, so the person who genuinely
  // requested it can still use it.
  if (!linkNonceMatches(params.get(LINK_NONCE_PARAM), request.cookies.get(LINK_NONCE_COOKIE)?.value)) {
    return failure('link_unbound', destination);
  }

  const tokenHash = params.get('token_hash');
  if (tokenHash === null) {
    // Shape 2: the token is in the fragment. Bounce it back to us as a POST.
    return new NextResponse(fragmentBridgeHtml(destination), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // This page handles a credential in the URL fragment; nothing else may
        // run on it and nothing may frame it.
        // `form-action` and `base-uri` are listed explicitly: neither falls back
        // to `default-src`, so omitting them would leave a payload free to
        // submit a form off-site or repoint every relative URL on the page.
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
          "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none';",
        'referrer-policy': 'no-referrer',
      },
    });
  }

  const type = params.get('type') === 'signup' ? 'signup' : 'magiclink';
  const client = createAuthClient();
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });

  if (error !== null || data.user === null || typeof data.user.email !== 'string') {
    return failure(error?.code === 'otp_expired' ? 'link_expired' : 'link_invalid', destination);
  }

  return establishSession(data.user.id, data.user.email, destination);
}

/**
 * Did this POST come from our own page?
 *
 * `Sec-Fetch-Site` is the primary signal and is sent by every current browser on
 * every request; `Origin` is the fallback for anything that predates it. A
 * request carrying neither is not a browser, and the bridge page is the only
 * legitimate caller, so the safe answer is no.
 */
function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';

  const origin = request.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin === new URL(getAppUrl()).origin;
  } catch {
    return false;
  }
}

/**
 * Shape 2, step two: the bridge page posts the access token back here.
 *
 * The token is verified against Supabase rather than merely decoded — a JWT the
 * page hands us is a claim, and `getUser` is what turns it into a fact.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasAuthConfig()) return failure('auth_not_configured');

  // Login CSRF. `request.json()` will happily parse a body sent as `text/plain`,
  // which is the shape a cross-site <form> can produce with no preflight — so
  // without this check another site could plant its own access token here and
  // therefore its own session in this browser. The preview gate happens to block
  // it today (a Lax `pf_access` is not sent cross-site), but that gate is
  // documented as temporary, and this must not become exploitable the day it is
  // removed.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: { code: 'cross_origin' } }, { status: 403 });
  }

  let accessToken: unknown;
  let destination = DEFAULT_DESTINATION;
  try {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null) {
      accessToken = (body as { access_token?: unknown }).access_token;
      const next = (body as { next?: unknown }).next;
      destination = destinationFrom(typeof next === 'string' ? next : null);
    }
  } catch {
    return NextResponse.json({ error: { code: 'invalid_body' } }, { status: 400 });
  }

  if (typeof accessToken !== 'string' || accessToken === '') {
    return NextResponse.json({ error: { code: 'invalid_token' } }, { status: 400 });
  }

  const client = createAuthClient();
  const { data, error } = await client.auth.getUser(accessToken);
  if (error !== null || data.user === null || typeof data.user.email !== 'string') {
    return NextResponse.json({ error: { code: 'invalid_token' } }, { status: 401 });
  }

  const response = await establishSession(data.user.id, data.user.email, destination);
  // The caller is fetch(), not a navigation, so answer with the destination
  // rather than a redirect the script would have to unpick.
  return NextResponse.json(
    { ok: true, next: destination },
    { status: 200, headers: { 'set-cookie': response.headers.get('set-cookie') ?? '' } },
  );
}

/**
 * A string safe to drop into inline `<script>` source.
 *
 * `JSON.stringify` alone is *not* safe here, which is the trap: it escapes
 * quotes and backslashes but leaves `<` untouched, so a value containing
 * `</script>` closes the element during HTML parsing and everything after it is
 * markup. Escaping `<` as `\u003c` keeps the value a string to the JS parser
 * while making it invisible to the HTML tokeniser.
 *
 * Both values that reach this are already constrained — `destination` has been
 * through `safeDestination`, which percent-encodes `<` as a side effect of
 * rebuilding the URL, and `signInScreenUrl()` comes from `URL.toString()`. This
 * is the belt to those braces: a guarantee that lives here, next to the sink,
 * rather than depending on what two other functions happen to do.
 */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * The fragment bridge. Deliberately tiny and deliberately inline: it reads the
 * fragment, posts it back, and replaces the URL so the token does not survive in
 * history. It renders nothing a person would notice on a working connection.
 */
function fragmentBridgeHtml(destination: string): string {
  const next = jsLiteral(destination);
  const signIn = jsLiteral(signInScreenUrl());
  return `<!doctype html>
<meta charset="utf-8">
<title>Signing you in…</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030818;
       color:#f3ecde;font:400 16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  a{color:#d8f24b}
</style>
<p id="s">Signing you in…</p>
<script>
(function () {
  var hash = new URLSearchParams(location.hash.slice(1));
  var token = hash.get('access_token');
  var failed = hash.get('error_description') || hash.get('error');
  var say = function (message) { document.getElementById('s').textContent = message; };

  if (!token) {
    location.replace(${signIn} + '?error=' + encodeURIComponent(failed ? 'link_invalid' : 'link_missing'));
    return;
  }

  // Drop the token out of the address bar before the round-trip, so a back
  // button or a shared URL cannot replay it.
  history.replaceState(null, '', location.pathname);

  fetch('/auth/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ access_token: token, next: ${next} })
  }).then(function (response) {
    if (!response.ok) throw new Error('rejected');
    return response.json();
  }).then(function (result) {
    location.replace(result.next || '/');
  }).catch(function () {
    say('That sign-in link did not work. Ask for a new one.');
  });
})();
</script>
<noscript>This sign-in link needs JavaScript. Open it in a different browser, or ask for a new link.</noscript>`;
}
