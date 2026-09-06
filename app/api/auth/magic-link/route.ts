/**
 * `POST /api/auth/magic-link` — email somebody a sign-in link.
 *
 * Prefer same-origin from `$APP_URL/signin` (dashboard.priceflag.org). A branded
 * door on signin.priceflag.org should bounce there rather than mint cookies on a
 * different host. CORS still allows that marketing origin to POST here so an
 * old static form keeps working: the emailed link and the bind cookie always
 * belong to the session origin, not the form's host.
 *
 * This route is deliberately reachable without the `pf_access` preview gate (see
 * `middleware.ts`) — the sign-in screen is public, so the form has to work for
 * anyone. Requesting a link is not entry. Completing `/auth/callback` mints
 * `pf_user`, and that session is enough to view the app. Price writes still
 * require a Shopify session token in the route handler.
 *
 * The response is the same whether or not the address belongs to a known
 * account. That is not decoration: a differing response here turns the endpoint
 * into an "is this person a Priceflag customer" oracle for anyone who asks.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { callbackUrl, createAuthClient, hasAuthConfig } from '@/lib/auth/supabase-auth';
import { sessionOrigin } from '@/lib/auth/session-host';
import { allowedOrigin, corsHeaders } from '@/lib/auth/signin-origin';
import {
  createLinkNonce,
  LINK_NONCE_COOKIE,
  LINK_NONCE_PARAM,
  linkNonceCookieOptions,
} from '@/lib/auth/link-binding';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Deliberately loose. The authority on whether an address is real is whether the
 * email arrives, and over-clever local-part rules reject valid addresses.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  const origin = allowedOrigin(request.headers.get('origin'));
  if (origin === null) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = allowedOrigin(request.headers.get('origin'));
  // A same-origin POST (no Origin header) is fine; a POST from a host we do not
  // publish the sign-in screen on is not.
  if (origin === null && request.headers.get('origin') !== null) {
    return NextResponse.json(
      { error: { code: 'origin_not_allowed', message: 'Not allowed from this origin.', retryable: false, details: null } },
      { status: 403 },
    );
  }
  const headers = origin === null ? {} : corsHeaders(origin);

  if (!hasAuthConfig()) {
    return NextResponse.json(
      {
        error: {
          code: 'auth_not_configured',
          message:
            'This deployment has no Supabase auth credentials. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.',
          retryable: false,
          details: null,
        },
      },
      { status: 503, headers },
    );
  }

  let email: unknown;
  let next: string | null = null;
  try {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null) {
      email = (body as { email?: unknown }).email;
      const raw = (body as { next?: unknown }).next;
      // A path, never a URL. This ends up inside the link we email, so anything
      // absolute here would let a stranger use our domain and our email
      // reputation to send somebody a link to a site of their choosing.
      if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) next = raw;
    }
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Send a JSON body with an email field.', retryable: false, details: null } },
      { status: 400, headers },
    );
  }

  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim()) || email.length > 320) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_email',
          message: 'That does not look like an email address.',
          retryable: false,
          details: null,
        },
      },
      { status: 400, headers },
    );
  }

  // Bind this link to this browser. Without it, a link is authentication for
  // whoever opens it, and forwarding one to somebody else signs them into your
  // account — see `lib/auth/link-binding.ts`.
  const nonce = createLinkNonce();

  const session = sessionOrigin();
  const redirectTo = new URL(callbackUrl(session));
  redirectTo.searchParams.set(LINK_NONCE_PARAM, nonce);
  if (next !== null) redirectTo.searchParams.set('next', next);

  const client = createAuthClient();
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: {
      emailRedirectTo: redirectTo.toString(),
      // Priceflag has no separate sign-up: proving you control the address is
      // what creates the account. Connecting a Shopify store comes after.
      shouldCreateUser: true,
    },
  });

  if (error !== null) {
    // Supabase returns 429 for its own per-address and per-hour send limits.
    // That one is worth passing through honestly — "check your email" when no
    // email is coming is the more confusing failure.
    const rateLimited = error.status === 429;
    if (!rateLimited) {
      console.error('magic link send failed', { message: error.message, status: error.status });
    }
    return NextResponse.json(
      {
        error: {
          code: rateLimited ? 'rate_limited' : 'send_failed',
          message: rateLimited
            ? 'We have sent a few links to that address already. Wait a minute and try again.'
            : 'We could not send that link. Try again in a moment.',
          retryable: true,
          details: null,
        },
      },
      { status: rateLimited ? 429 : 502, headers },
    );
  }

  const response = NextResponse.json({ sent: true }, { status: 200, headers });
  response.cookies.set(
    LINK_NONCE_COOKIE,
    nonce,
    linkNonceCookieOptions(new URL(session).protocol === 'https:'),
  );
  return response;
}
