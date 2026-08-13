/**
 * `POST /auth/sign-out` — end the account session.
 *
 * Clears `pf_user` and sends the person back to the sign-in screen. It does not
 * touch `pf_shop`: that cookie is Shopify's assertion about the embedded admin
 * session, it expires on its own in ten minutes, and clearing it here would sign
 * somebody out of the Shopify iframe as a side effect of leaving the dashboard.
 *
 * POST rather than GET so that a prefetch, a link scanner, or an <img> tag on
 * another site cannot sign somebody out by being loaded. GET is accepted too,
 * but only for the explicit `?confirm=1` form used by the plain-link fallback.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { USER_COOKIE, userCookieOptions } from '@/lib/auth/account';
import { signInScreenUrl } from '@/lib/auth/signin-origin';
import { getAppUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clearedResponse(): NextResponse {
  const response = NextResponse.redirect(signInScreenUrl({ signed_out: '1' }), { status: 303 });
  // Same attributes as when it was set — a cookie only clears if the domain and
  // path match what minted it, and a mismatch here leaves people signed in.
  response.cookies.set(USER_COOKIE, '', {
    ...userCookieOptions(new URL(getAppUrl()).protocol === 'https:'),
    maxAge: 0,
  });
  return response;
}

export async function POST(): Promise<NextResponse> {
  return clearedResponse();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.searchParams.get('confirm') !== '1') {
    return NextResponse.redirect(new URL('/', getAppUrl()), { status: 303 });
  }
  return clearedResponse();
}
