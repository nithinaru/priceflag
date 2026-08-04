/**
 * `GET /api/journal` — the price audit trail (R18).
 *
 * `?format=csv` returns the same rows as `text/csv`. Shopify keeps no price
 * history, so for most merchants this is the only record that a price ever
 * changed — which is also why the CSV escapes formula-leading characters rather
 * than handing a spreadsheet something executable.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { getMode, isProductionRuntime } from '@/lib/config';
import { journalToCsv, toJournalContract } from '@/lib/engine/journal';
import { staticShopDomain } from '@/lib/shopify/credentials';
import { resolveShopFromRequestOrCookie } from '@/lib/shopify/session';
import type { JournalSource } from '@/lib/contracts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SOURCES: JournalSource[] = ['rollout', 'rollback', 'external', 'kill_switch', 'manual', 'seed'];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adapter = getAdapter();
  const params = request.nextUrl.searchParams;

  let shopDomain: string | null;
  if (getMode() === 'demo') {
    // The demo adapter holds exactly one seeded shop — no tenancy to protect.
    const shops = await adapter.listShops();
    shopDomain = shops[0]?.shop_domain ?? null;
  } else {
    // Real mode: a session token or the signed pf_shop cookie names the shop.
    // (The cookie matters here — the CSV export is a plain link and cannot carry
    // an Authorization header.) No "first shop in the table" fallback, ever:
    // that would hand one merchant another merchant's price history.
    try {
      shopDomain = resolveShopFromRequestOrCookie(request).shopDomain;
    } catch {
      if (isProductionRuntime()) {
        return NextResponse.json(
          {
            error: {
              code: 'unauthenticated',
              message: 'Open Priceflag from your Shopify admin to view the price journal.',
              retryable: false,
              details: null,
            },
          },
          { status: 401 },
        );
      }
      shopDomain = staticShopDomain();
    }
  }

  const shop = shopDomain === null ? null : await adapter.getShopByDomain(shopDomain);
  if (shop === null) {
    return NextResponse.json(
      { error: { code: 'shop_not_connected', message: 'No connected store.', retryable: false, details: null } },
      { status: 404 },
    );
  }

  const requestedSources = params.getAll('source').filter((value): value is JournalSource =>
    SOURCES.includes(value as JournalSource),
  );

  const csv = params.get('format') === 'csv';
  const page = await adapter.listJournalEntries(shop.id, {
    variant_gids: params.getAll('variant_gid').length > 0 ? params.getAll('variant_gid') : undefined,
    rollout_id: params.get('rollout_id') ?? undefined,
    sources: requestedSources.length > 0 ? requestedSources : undefined,
    from_day: params.get('from') ?? undefined,
    to_day: params.get('to') ?? undefined,
    // An export has no page size: a partial audit trail is worse than none.
    limit: csv ? undefined : Number(params.get('limit') ?? 100),
    offset: csv ? undefined : Number(params.get('offset') ?? 0),
  });

  // Rollout names are denormalised here rather than in the table, so a renamed
  // rollout does not rewrite history.
  const names = new Map((await adapter.listRollouts(shop.id)).map((rollout) => [rollout.id, rollout.name]));
  const items = page.items.map((entry) =>
    toJournalContract(entry, entry.rollout_id === null ? null : (names.get(entry.rollout_id) ?? null)),
  );

  if (csv) {
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(journalToCsv(items), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="priceflag-journal-${shop.shop_domain}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json({ items, total: page.total });
}
