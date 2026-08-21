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
import { MerchantApiError, merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { isDayString, type DayString } from '@/lib/dates';
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

    const rawSources = params.getAll('source');
    const invalidSource = rawSources.find((value) => !SOURCES.includes(value as JournalSource));
    if (invalidSource !== undefined) {
      throw new MerchantApiError(
        'invalid_journal_query',
        `source must be one of: ${SOURCES.join(', ')}.`,
        400,
      );
    }
    const requestedSources = rawSources as JournalSource[];

    const csv = params.get('format') === 'csv';
    const fromDay = optionalDay(params.get('from'), 'from');
    const toDay = optionalDay(params.get('to'), 'to');
    if (fromDay !== undefined && toDay !== undefined && fromDay > toDay) {
      throw new MerchantApiError('invalid_journal_query', 'from must be on or before to.', 400);
    }
    const page = await adapter.listJournalEntries(shop.id, {
      variant_gids: params.getAll('variant_gid').length > 0 ? params.getAll('variant_gid') : undefined,
      rollout_id: params.get('rollout_id') ?? undefined,
      sources: requestedSources.length > 0 ? requestedSources : undefined,
      from_day: fromDay,
      to_day: toDay,
      // An export has no page size: a partial audit trail is worse than none.
      limit: csv ? undefined : boundedInteger(params.get('limit'), 'limit', 100, 1, 500),
      offset: csv ? undefined : boundedInteger(params.get('offset'), 'offset', 0, 0, 1_000_000),
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

function boundedInteger(
  value: string | null,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MerchantApiError(
      'invalid_journal_query',
      `${field} must be a whole number from ${minimum} to ${maximum}.`,
      400,
    );
  }
  return parsed;
}

function optionalDay(value: string | null, field: string): DayString | undefined {
  if (value === null || value === '') return undefined;
  // isDayString pins the transport shape; the round trip rejects impossible
  // calendar dates such as 2026-02-31 that Date would otherwise normalize.
  const parsed = isDayString(value) ? new Date(`${value}T12:00:00Z`) : null;
  if (parsed === null || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MerchantApiError('invalid_journal_query', `${field} must be a real calendar day in YYYY-MM-DD form.`, 400);
  }
  return value;
}
