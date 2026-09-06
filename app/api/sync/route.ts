/**
 * `POST /api/sync` — start (or re-run) a sync.
 *
 * Returns as soon as Shopify credentials and webhook configuration are verified,
 * then runs the catalog/history work after the response. Progress and failures
 * are durable in `sync_runs`, which is what `/api/sync/status` polls; closing the
 * browser therefore does not turn a healthy sync into an abandoned HTTP request.
 */

import { after, NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { sessionOrigin } from '@/lib/auth/session-host';
import { getMode } from '@/lib/config';
import { resolveShopCredentials } from '@/lib/shopify/credentials';
import { reconcileWebhooks } from '@/lib/shopify/webhooks';
import { runSync, syncProgressFromRun } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
const ACTIVE_SYNC_GRACE_MS = 6 * 60 * 1_000;

function requestedHistoryDays(url: URL): number | undefined {
  if (!url.searchParams.has('days')) return undefined;
  const days = Number(url.searchParams.get('days'));
  if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
    throw new RangeError('History days must be a whole number between 1 and 3650.');
  }
  return days;
}

function fail(code: string, message: string, status: number, retryable = false): NextResponse {
  return NextResponse.json({ error: { code, message, retryable, details: null } }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);

    // Authenticate first: demo mode is a separate product experience, not an
    // unauthenticated escape hatch around merchant-route authorization.
    if (getMode() === 'demo') {
      return fail(
        'demo_mode',
        'The simulated store already has its catalog and history loaded — there is nothing to sync.',
        409,
      );
    }

    const url = new URL(request.url);
    let historyDays: number | undefined;
    try {
      historyDays = requestedHistoryDays(url);
    } catch {
      return fail('invalid_request', 'History days must be a whole number between 1 and 3650.', 400);
    }
    const options = {
      catalogOnly: url.searchParams.get('catalogOnly') === '1',
      historyDays,
    };

    const latest = await adapter.getLatestSyncRun(shop.id);
    if (latest !== null && latest.finished_at === null && latest.stage !== 'error') {
      const lastProgress = new Date(latest.updated_at).getTime();
      if (Number.isFinite(lastProgress) && Date.now() - lastProgress < ACTIVE_SYNC_GRACE_MS) {
        return NextResponse.json(
          { accepted: true, already_running: true, progress: syncProgressFromRun(latest) },
          { status: 202, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      await adapter.updateSyncRun(latest.id, {
        stage: 'error',
        error_code: 'internal',
        error_message: 'The previous sync stopped before it finished. Priceflag is starting it again.',
        error_retryable: true,
        finished_at: new Date().toISOString(),
        message: 'The previous sync stopped before it finished. Starting again…',
      });
    }

    // Resolve credentials before starting, so a bad token fails immediately
    // rather than halfway through writing a catalog.
    const credentials = await resolveShopCredentials(adapter, shop.shop_domain);

    // Reconcile on every merchant-triggered sync, not just the OAuth callback.
    // That gives an installed shop a visible retry path after a transient
    // registration failure or an app-domain move, and removes duplicate HTTP
    // subscriptions before they can double-count orders.
    await reconcileWebhooks(credentials, sessionOrigin());

    const initialRun = await adapter.createSyncRun(shop.id, options.catalogOnly ? 'catalog' : 'full');

    after(async () => {
      // `runSync` records its own terminal error state. Catch only an unexpected
      // failure outside that boundary so the background task never becomes an
      // unhandled rejection after the response has already reached the merchant.
      await runSync(adapter, shop, { ...options, initialRun }).catch(async () => {
        await adapter.updateSyncRun(initialRun.id, {
          stage: 'error',
          error_code: 'internal',
          error_message: 'The sync stopped unexpectedly. Try again and it will continue safely.',
          error_retryable: true,
          finished_at: new Date().toISOString(),
          message: 'The sync stopped unexpectedly. Try again.',
        }).catch(() => undefined);
      });
    });

    return NextResponse.json(
      {
        accepted: true,
        progress: syncProgressFromRun(initialRun),
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
