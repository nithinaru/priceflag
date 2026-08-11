/**
 * `GET /api/sync/status` — what onboarding polls.
 *
 * Returns `sync_progress.schema.json` exactly. Always 200 with a well-formed
 * body, including before any sync has ever run: a polling UI should never have to
 * branch on a 404 to decide what to render.
 */

import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { CONTRACT_VERSION, DEFAULT_HISTORY_DAYS } from '@/lib/contracts';
import { syncProgressFromRun } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);

    const run = await adapter.getLatestSyncRun(shop.id);
    if (run === null) {
      const nowIso = new Date().toISOString();
      return NextResponse.json({
        contract_version: CONTRACT_VERSION,
        stage: 'queued',
        message: 'No sync has started yet.',
        catalog: { ready: false, products_synced: 0, products_total: null, ready_at: null },
        history: {
          ready: false,
          days_synced: 0,
          days_target: DEFAULT_HISTORY_DAYS,
          orders_processed: 0,
          ready_at: null,
        },
        eta_seconds: null,
        error: null,
        started_at: nowIso,
        updated_at: nowIso,
        finished_at: null,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json(syncProgressFromRun(run), { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
