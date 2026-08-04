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
import { getAppUrl, getShopifyApiVersion, hasShopifyConfig, requireEnv } from '@/lib/config';
import { encryptSecret } from '@/lib/crypto';
import { credentialsFromShop } from '@/lib/shopify/credentials';
import { verifyOAuthHmac } from '@/lib/shopify/hmac';
import { reconcileWebhooks } from '@/lib/shopify/webhooks';
import { runSync } from '@/lib/sync';
import type { SyncRun } from '@/lib/types';
import {
  exchangeCodeForToken,
  missingScopes,
  normalizeShopDomain,
  OAUTH_HOST_COOKIE,
  OAUTH_STATE_COOKIE,
  postInstallUrl,
  verifyOAuthState,
} from '@/lib/shopify/oauth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The `after()` work below (webhook registration + initial sync) shares this
// budget with the redirect itself.
export const maxDuration = 60;

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
  if (run.stage !== 'done') return true; // queued/catalog/history/aggregating — already running
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

  // Post-install work runs via `after()` — once the redirect below has been
  // sent — so a slow or failing Shopify call can never strand the merchant on
  // the callback URL. The install itself is already durable at this point.
  //
  // Vercel constraint: `after()` shares this function's `maxDuration` (60s). A
  // big store's history sync may not finish inside that budget, which is fine:
  // the connect panel re-triggers `POST /api/sync`, and re-running converges
  // (every sync write is an upsert).
  after(async () => {
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
      const latest = await adapter.getLatestSyncRun(installedShop.id);
      if (!hasFreshSync(latest, new Date())) {
        await runSync(adapter, installedShop);
      }
    } catch (cause) {
      console.error(
        `[install] initial sync kickoff failed for ${shop}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  });

  // Installs that started inside the Shopify admin land back inside it; the
  // stashed host cookie is the signal (set by `GET /api/auth`).
  const embeddedHost = request.cookies.get(OAUTH_HOST_COOKIE)?.value ?? null;
  const response = NextResponse.redirect(postInstallUrl(shop, embeddedHost));
  // The nonce is single-use, and so is the stashed host.
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_HOST_COOKIE);
  return response;
}
