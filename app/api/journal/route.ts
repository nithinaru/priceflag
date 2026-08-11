/**
 * `GET /api/journal` — the price audit trail (R18).
 *
 * `?format=csv` returns the same rows as `text/csv`. Shopify keeps no price
 * history, so for most merchants this is the only record that a price ever
 * changed — which is also why the CSV escapes formula-leading characters rather
 * than handing a spreadsheet something executable.
 */

import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { journalToCsv, toJournalContract } from '@/lib/engine/journal';
import type { JournalSource } from '@/lib/contracts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SOURCES: JournalSource[] = ['rollout', 'rollback', 'external', 'kill_switch', 'manual', 'seed'];

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const params = new URL(request.url).searchParams;

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

    return NextResponse.json({ items, total: page.total }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
