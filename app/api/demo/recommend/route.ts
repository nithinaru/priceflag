/**
 * Read-only suggestions endpoint for the visibly labelled public demo store.
 *
 * Modeled on app/api/demo/forecast/route.ts: same demo-mode gate, same light
 * validation, same `{ ok, ... }` reply envelope. The work itself mirrors
 * POST /api/recommend over the demo adapter — same loads, same optimizer, same
 * kill-switch rule — minus the Shopify session auth the public demo cannot
 * have. Strictly read-only: no price writes, no journal entries, no rollouts.
 */

import { NextResponse } from 'next/server';

import type { RecommendResponse, RecommendSuggestion } from '@/app/api/recommend/route';
import { getAdapter } from '@/lib/adapters';
import { isDemoMode } from '@/lib/config';
import { CONTRACT_VERSION } from '@/lib/contracts';
import { nowIso } from '@/lib/dates';
import { DEMO_SHOP_DOMAIN } from '@/lib/demo/generator';
import { OPTIMIZER_MODEL_VERSION, optimizePrices, type PriceRecommendationRow } from '@/lib/engine/optimize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Same prefill rule as /api/recommend: absolute delta, `rounding: 'none'`, so
 *  the prefilled forecast lands byte-identical on the suggested price. */
function toSuggestion(row: PriceRecommendationRow): RecommendSuggestion {
  return {
    ...row,
    proposal: {
      contract_version: CONTRACT_VERSION,
      variant_gids: [row.variant_gid],
      change: {
        type: 'absolute',
        absolute_cents: row.recommended_price_cents - row.current_price_cents,
        rounding: 'none',
      },
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isDemoMode()) {
    return NextResponse.json(
      { ok: false, code: 'not_found', message: 'Demo suggestions are not available here.' },
      { status: 404 },
    );
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_json', message: 'Send a valid suggestions request.' },
      { status: 400 },
    );
  }
  const gids = (input as { variant_gids?: unknown } | null)?.variant_gids;
  if (
    !Array.isArray(gids) ||
    gids.length === 0 ||
    gids.length > 100 ||
    !gids.every((gid): gid is string => typeof gid === 'string')
  ) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request', message: 'Choose valid products first.' },
      { status: 400 },
    );
  }

  const adapter = getAdapter();
  const shop = await adapter.getShopByDomain(DEMO_SHOP_DOMAIN);
  if (shop === null) {
    return NextResponse.json(
      { ok: false, code: 'not_found', message: 'The demo store is not seeded yet.' },
      { status: 404 },
    );
  }

  // Same rule as POST /api/recommend: while the store-wide kill switch is
  // engaged, machine-made suggestions are disabled rather than served.
  if (shop.kill_switch_engaged_at !== null) {
    return NextResponse.json(
      {
        ok: false,
        code: 'kill_switch_engaged',
        message:
          'Price suggestions are paused. Finish the store-wide undo and explicitly re-enable price changes first.',
      },
      { status: 409 },
    );
  }

  const products = await adapter.getProductsByVariantGids(shop.id, gids);
  if (products.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_found',
        message: 'We could not find those products. They may have been removed from your store.',
      },
      { status: 404 },
    );
  }

  const [orderDays, fits] = await Promise.all([
    adapter.getOrderDays(shop.id, { variant_gids: gids }),
    adapter.getLatestFits(shop.id, gids),
  ]);

  const now = new Date();
  const result = optimizePrices({
    shop: { shop_domain: shop.shop_domain, currency: shop.currency, timezone: shop.timezone },
    products,
    orderDays,
    fits,
    rounding: 'end_99',
    now,
  });

  const response: RecommendResponse = {
    contract_version: CONTRACT_VERSION,
    model_version: OPTIMIZER_MODEL_VERSION,
    computed_at: nowIso(now),
    suggestions: result.recommendations.map(toSuggestion),
    skipped: result.skipped,
  };

  return NextResponse.json(
    { ok: true, response },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
