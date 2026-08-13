/**
 * `GET /api/auth/callback` — finish the OAuth install.
 *
 * Order of operations matters, and it is: verify the HMAC, verify the nonce, only
 * then talk to Shopify. Exchanging a code we have not authenticated would let an
 * attacker drive our client secret at a shop of their choosing.
 *
 * The offline token is encrypted before it is stored and is never returned by any
 * route (R1, R23).
 */

import { after, NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { linkAccountToShop } from '@/lib/auth/account-shops';
import {
  INSTALL_INITIATOR_COOKIE,
  installInitiatorCookieOptions,
} from '@/lib/auth/link-binding';
import { getAppUrl, getShopifyApiVersion, hasShopifyConfig, requireEnv } from '@/lib/config';
import { encryptSecret } from '@/lib/crypto';
import { credentialsFromShop } from '@/lib/shopify/credentials';
import { verifyOAuthHmac } from '@/lib/shopify/hmac';
import { schedulePostResponse } from '@/lib/shopify/post-response';
import { reconcileWebhooks } from '@/lib/shopify/webhooks';
import { stopRolloutsForUninstall, UninstallCleanupBusyError } from '@/lib/shopify/uninstall';
import { runSync } from '@/lib/sync';
import type { SyncRun } from '@/lib/types';
import {
  exchangeCodeForToken,
  missingScopes,
  normalizeShopDomain,
  OAUTH_STATE_COOKIE,
  postInstallUrl,
  verifyOAuthState,
} from '@/lib/shopify/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The `after()` work below (webhook registration + initial sync) shares this
// budget with the redirect itself.
export const maxDuration = 300;

/**
 * Does the latest run make an automatic post-install sync redundant?
 *
 * A reinstall with fresh data should not re-download the catalog: skip when a
 * run is already going, or completed within the last ten minutes. An errored
 * run never counts as fresh — a reinstall is exactly when a retry should happen.
 */
const RECENT_SYNC_MS = 10 * 60 * 1000;

function hasFreshSync(run: SyncRun | null, now: Date): boolean {
  if (run === null) return false;
  if (run.stage === 'error') return false;
  if (run.stage !== 'done') {
    const updatedAt = new Date(run.updated_at).getTime();
    return Number.isFinite(updatedAt) && now.getTime() - updatedAt < RECENT_SYNC_MS;
  }
  const finishedAt = run.finished_at ?? run.updated_at;
  return now.getTime() - new Date(finishedAt).getTime() < RECENT_SYNC_MS;
}

function fail(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message, retryable: false, details: null } }, { status });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!hasShopifyConfig()) {
    return fail('shopify_not_configured', 'This deployment has no Shopify credentials.', 503);
  }

  const params = request.nextUrl.searchParams;
  const clientSecret = requireEnv('SHOPIFY_API_SECRET');

  // 1. Is this actually from Shopify?
  if (!verifyOAuthHmac(params, clientSecret)) {
    return fail('invalid_hmac', 'That install link could not be verified. Start the install again.', 401);
  }

  // 2. Is it the install *we* started? Single-use nonce from an HttpOnly cookie.
  if (!verifyOAuthState(params.get('state'), request.cookies.get(OAUTH_STATE_COOKIE)?.value)) {
    return fail('state_mismatch', 'That install link has expired. Start the install again.', 401);
  }

  const shopParam = params.get('shop');
  const code = params.get('code');
  if (shopParam === null || code === null) {
    return fail('invalid_request', 'The install link is missing information. Start the install again.', 400);
  }

  let shop: string;
  try {
    shop = normalizeShopDomain(shopParam);
  } catch {
    return fail('invalid_shop_domain', 'That does not look like a Shopify store address.', 400);
  }

  // 3. Only now exchange the code.
  let token;
  try {
    token = await exchangeCodeForToken({ shop, code, clientSecret });
  } catch (cause) {
    return fail(
      'token_exchange_failed',
      'Shopify would not complete the connection. Check the app credentials and try again.',
      502,
    );
  }

  // `read_all_orders` is the one that matters: without it the Admin API silently
  // caps order history at 60 days, and every forecast would be built on two months
  // of data while the UI claimed 180. Failing the install is the honest outcome.
  const missing = missingScopes(token.scope);
  if (missing.length > 0) {
    return fail(
      'scope_mismatch',
      `The app is missing permissions it needs: ${missing.join(', ')}. ` +
        'Grant them on the app configuration in your Shopify admin, then install again.',
      403,
    );
  }

  const adapter = getAdapter();
  const existing = await adapter.getShopByDomain(shop);

  // A reinstall must never clear the uninstall stop flag while an earlier
  // webhook is still waiting for a rollout lease. Finish the same idempotent
  // cleanup first; on contention, fail closed and ask for a fresh install flow.
  if (existing?.uninstalled_at !== null && existing?.uninstalled_at !== undefined) {
    try {
      await stopRolloutsForUninstall(adapter, existing, existing.uninstalled_at);
    } catch (cause) {
      if (cause instanceof UninstallCleanupBusyError) {
        return fail(
          'uninstall_cleanup_pending',
          'Priceflag is still stopping an earlier price change. Wait a moment, then start the install again.',
          409,
        );
      }
      return fail(
        'uninstall_cleanup_failed',
        'Priceflag could not safely finish the previous uninstall. Try the install again.',
        503,
      );
    }
  }

  const installedShop = await adapter.upsertShop({
    shop_domain: shop,
    access_token_enc: encryptSecret(token.access_token),
    scopes: token.scope,
    api_version: getShopifyApiVersion(),
    mode: 'real',
    installed_at: new Date().toISOString(),
    // A reinstall clears the uninstalled stamp but keeps the shop row, and with it
    // the price journal — a merchant who reinstalls keeps their history.
    uninstalled_at: null,
    ...(existing === null ? {} : { name: existing.name ?? undefined }),
  });

  // If a signed-in account *started* this install, remember that this is their
  // store, so a later visit from signin.priceflag.org lands on their data
  // instead of asking them to connect a store they have already connected.
  //
  // The account id comes from the initiator cookie set by `GET /api/auth`, not
  // from the `pf_user` session on this request. That distinction is the point:
  // the end of an OAuth round-trip is reachable by sending somebody a link, so a
  // cookie read here would record "whoever was signed in when the redirect
  // landed" rather than "whoever asked to connect this store".
  //
  // Before `after()` rather than inside it: it is one cheap insert, and a
  // merchant who installs and is immediately redirected should find the link
  // already there. Non-fatal all the same — a missing link costs one extra trip
  // through the connect screen, whereas throwing here would lose an install that
  // Shopify already considers complete.
  const initiator = request.cookies.get(INSTALL_INITIATOR_COOKIE)?.value;
  if (initiator !== undefined && initiator !== '') {
    try {
      await linkAccountToShop(initiator, installedShop.id);
    } catch (cause) {
      console.error(
        `[install] account link failed for ${shop}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  // Post-install work runs via `after()` — once the redirect below has been
  // sent — so a slow or failing Shopify call can never strand the merchant on
  // the callback URL. The install itself is already durable at this point.
  //
  // `after()` shares this function's duration budget. The queued run is created
  // before the redirect, so the connect page can poll it immediately and a
  // merchant closing the tab does not own the lifetime of the sync.
  const latestSync = await adapter.getLatestSyncRun(installedShop.id);
  const initialRun = hasFreshSync(latestSync, new Date())
    ? null
    : await adapter.createSyncRun(installedShop.id, 'full');
  schedulePostResponse(async () => {
    // (a) Webhook subscriptions. Non-fatal: a shop without webhooks degrades to
    // sync-time freshness, which the merchant can live with; a failed install
    // is the thing they cannot.
    try {
      await reconcileWebhooks(credentialsFromShop(installedShop), getAppUrl());
    } catch (cause) {
      console.error(
        `[install] webhook registration failed for ${shop}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    }

    // (b) Initial sync, unless fresh data already exists (reinstall case). A
    // failure inside runSync is recorded on the sync_runs row itself, so the
    // connect panel can show it; this catch is only for failures before the
    // run row exists.
    try {
      if (initialRun !== null) {
        await runSync(adapter, installedShop, { initialRun });
      }
    } catch (cause) {
      if (initialRun !== null) {
        await adapter.updateSyncRun(initialRun.id, {
          stage: 'error',
          error_code: 'internal',
          error_message: 'The initial sync stopped unexpectedly. Open Priceflag to try again.',
          error_retryable: true,
          finished_at: new Date().toISOString(),
          message: 'The initial sync stopped unexpectedly. Open Priceflag to try again.',
        }).catch(() => undefined);
      }
      console.error(
        `[install] initial sync kickoff failed for ${shop}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }, after);

  const response = NextResponse.redirect(postInstallUrl(shop));
  // Both are single-use: the state nonce, and the record of who started this.
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.set(INSTALL_INITIATOR_COOKIE, '', {
    ...installInitiatorCookieOptions(request.nextUrl.protocol === 'https:'),
    maxAge: 0,
  });
  return response;
}
