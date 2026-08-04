/**
 * `POST /api/sync` — start (or re-run) a sync.
 *
 * Runs inline and returns the final progress. That is fine for the store sizes v1
 * targets (30–500 SKUs) and it keeps the failure visible; a fire-and-forget job
 * that dies silently is worse than a request that takes twenty seconds. If a
 * pilot store is large enough to hit the function timeout, this becomes a queued
 * job and the contract does not change — Lane A already polls `/api/sync/status`.
 */

import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { getMode } from '@/lib/config';
import { resolveShopCredentials } from '@/lib/shopify/credentials';
import { runSync, syncProgressFromRun } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

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

    // Resolve credentials before starting, so a bad token fails immediately
    // rather than halfway through writing a catalog.
    await resolveShopCredentials(adapter, shop.shop_domain);

    const url = new URL(request.url);
    const outcome = await runSync(adapter, shop, {
      catalogOnly: url.searchParams.get('catalogOnly') === '1',
      historyDays: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : undefined,
    });

    const run = await adapter.getLatestSyncRun(shop.id);

    return NextResponse.json(
      {
        progress: syncProgressFromRun(run),
        products: outcome.products,
        orders: outcome.orders,
      },
      { status: outcome.error === null ? 200 : 502, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
