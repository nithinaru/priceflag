/**
 * `GET /api/sync/status` — what onboarding polls.
 *
 * Returns `sync_progress.schema.json` exactly. Always 200 with a well-formed
 * body, including before any sync has ever run: a polling UI should never have to
 * branch on a 404 to decide what to render.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { getMode } from '@/lib/config';
import { CONTRACT_VERSION, DEFAULT_HISTORY_DAYS } from '@/lib/contracts';
import { staticShopDomain } from '@/lib/shopify/credentials';
import { resolveShopFromRequest } from '@/lib/shopify/session';
import { syncProgressFromRun } from '@/lib/sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adapter = getAdapter();

  let shopDomain: string | null = null;
  try {
    shopDomain = resolveShopFromRequest(request).shopDomain;
  } catch {
    shopDomain = staticShopDomain();
  }

  if (shopDomain === null && getMode() === 'demo') {
    const shops = await adapter.listShops();
    shopDomain = shops[0]?.shop_domain ?? null;
  }

  const shop = shopDomain === null ? null : await adapter.getShopByDomain(shopDomain);
  if (shop === null) {
    const nowIso = new Date().toISOString();
    return NextResponse.json({
      contract_version: CONTRACT_VERSION,
      stage: 'queued',
      message: 'No store is connected yet.',
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
    });
  }

  const run = await adapter.getLatestSyncRun(shop.id);
  return NextResponse.json(syncProgressFromRun(run));
}
