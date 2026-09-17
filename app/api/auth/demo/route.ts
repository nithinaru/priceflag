/**
 * `POST /api/auth/demo` — open the simulated store.
 *
 * Demo mode is first-class (see CLAUDE.md), which after this change means it
 * needs its own door: the real one is a Shopify install, and there is no Shopify
 * store to install into on a demo deployment. So this mints the same `pf_user`
 * session the OAuth callback does, against a fixed account id, and everything
 * downstream — middleware, the shell, the pages — behaves identically.
 *
 * It exists only where `PRICEFLAG_MODE=demo`. On a real deployment it is a 404,
 * not a 403: a route that says "you may not do that here" tells a stranger the
 * route is worth trying somewhere else.
 *
 * POST, not GET, and no body: a prefetch, a link scanner or an `<img>` on
 * somebody else's page must not be able to hand a browser a session.
 */

import { NextResponse } from 'next/server';

import { signUserCookie, USER_COOKIE, userCookieOptions } from '@/lib/auth/account';
import { sessionOrigin } from '@/lib/auth/session-host';
import { DEMO_ACCOUNT_EMAIL, DEMO_ACCOUNT_ID } from '@/lib/auth/demo-account';
import { isDemoMode } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  if (!isDemoMode()) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Not found.', retryable: false, details: null } },
      { status: 404 },
    );
  }

  const origin = sessionOrigin();
  const response = NextResponse.json({ ok: true, next: '/' }, { status: 200 });
  response.cookies.set(
    USER_COOKIE,
    signUserCookie({ userId: DEMO_ACCOUNT_ID, email: DEMO_ACCOUNT_EMAIL }),
    userCookieOptions(new URL(origin).protocol === 'https:'),
  );
  return response;
}
