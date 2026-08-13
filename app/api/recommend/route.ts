/**
 * POST /api/recommend — read-only, constrained per-SKU price suggestions.
 *
 * Modeled line by line on POST /api/forecast: same authentication, same
 * adapter loads (products, order days, latest fits), same demo-mode handling
 * (the adapter is the demo simulator when PRICEFLAG_MODE=demo — nothing here
 * knows the difference). Unlike the forecast dry run, this endpoint hands out
 * machine-made suggestions, so it also honors the store-wide kill switch the
 * way the rollout-creating routes do: with the switch engaged, suggestions are
 * disabled rather than served.
 *
 * Strictly read-only: no price writes, no journal entries, no rollouts.
 * Suggestions never auto-apply — each row ships with a ProposalRequest-shaped
 * prefill the merchant must still take through the forecast → rollout flow.
 */

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { CONTRACT_VERSION, type ProposalRequest } from '@/lib/contracts';
import { nowIso } from '@/lib/dates';
import {
  DEFAULT_MARGIN_FLOOR_PCT,
  DEFAULT_MAX_CHANGE_PCT,
  OPTIMIZER_MODEL_VERSION,
  optimizePrices,
  type OptimizeResult,
  type PriceRecommendationRow,
  type SkippedVariant,
} from '@/lib/engine/optimize';
import type { Rounding } from '@/lib/money';
import type { Product } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// request validation — same mechanism as parseProposal (Ajv over a 2020-12
// schema), inline because this request shape is route-local, not a cross-lane
// contract like contracts/*.schema.json.
// ---------------------------------------------------------------------------

export interface RecommendRequest {
  contract_version: typeof CONTRACT_VERSION;
  variant_gids: string[];
  constraints?: {
    margin_floor_pct?: number;
    max_change_pct?: number;
    inventory_aware?: boolean;
  };
  rounding?: Rounding;
}

const recommendRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['contract_version', 'variant_gids'],
  properties: {
    contract_version: { const: CONTRACT_VERSION },
    variant_gids: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: { type: 'string', pattern: '^gid://shopify/ProductVariant/[0-9]+$' },
    },
    constraints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        margin_floor_pct: { type: 'number', minimum: 0, maximum: 95 },
        max_change_pct: { type: 'number', exclusiveMinimum: 0, maximum: 400 },
        inventory_aware: { type: 'boolean' },
      },
    },
    rounding: { enum: ['none', 'end_99', 'end_95', 'end_00'] },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateRecommendRequest = ajv.compile(recommendRequestSchema);

function problems(errors: ErrorObject[] | null | undefined): { path: string; message: string }[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath === '' ? '(root)' : error.instancePath,
    message: error.message ?? 'failed validation',
  }));
}

// Not exported: Next.js restricts a route module's value exports to handlers
// and route-segment config. Types above are erased and therefore fine.
function parseRecommendRequest(body: unknown): RecommendRequest {
  if (!validateRecommendRequest(body)) {
    throw new MerchantApiError(
      'invalid_recommend_request',
      'Check the highlighted request fields and try again.',
      400,
      problems(validateRecommendRequest.errors),
    );
  }
  return body as unknown as RecommendRequest;
}

// ---------------------------------------------------------------------------
// response shape
// ---------------------------------------------------------------------------

/**
 * Each suggestion is the contract row plus a ProposalRequest-shaped prefill
 * for that single SKU. The prefill uses an `absolute` change with
 * `rounding: 'none'` on purpose: the recommended price is already on the
 * requested lattice, so re-rounding could move it, and the absolute delta
 * keeps the prefilled forecast byte-identical to the suggestion.
 */
export interface RecommendSuggestion extends PriceRecommendationRow {
  proposal: ProposalRequest;
}

export interface RecommendResponse {
  contract_version: typeof CONTRACT_VERSION;
  model_version: string;
  computed_at: string;
  suggestions: RecommendSuggestion[];
  skipped: SkippedVariant[];
}

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

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);

    // Same rule as rollout creation (app/api/rollouts/route.ts): while the
    // store-wide kill switch is engaged, the suggestions endpoint is disabled.
    if (shop.kill_switch_engaged_at !== null) {
      throw new MerchantApiError(
        'kill_switch_engaged',
        'Price suggestions are paused. Finish the store-wide undo and explicitly re-enable price changes first.',
        409,
      );
    }

    const body = parseRecommendRequest(await readJson(request));

    // Same load pattern as prepareForecast, including the not-found rule:
    // unknown variants are a 404, not a silent skip.
    const found = await adapter.getProductsByVariantGids(shop.id, body.variant_gids);
    const byGid = new Map(found.map((product) => [product.variant_gid, product]));
    const products = body.variant_gids
      .map((variantGid) => byGid.get(variantGid))
      .filter((product): product is Product => product !== undefined);
    if (products.length !== body.variant_gids.length) {
      throw new MerchantApiError(
        'variant_not_found',
        'One or more selected variants no longer exist in this store.',
        404,
      );
    }

    const [orderDays, fits] = await Promise.all([
      adapter.getOrderDays(shop.id, { variant_gids: body.variant_gids }),
      adapter.getLatestFits(shop.id, body.variant_gids),
    ]);

    const now = new Date();
    const result: OptimizeResult = optimizePrices({
      shop: { shop_domain: shop.shop_domain, currency: shop.currency, timezone: shop.timezone },
      products,
      orderDays,
      fits,
      constraints: {
        marginFloorPct: body.constraints?.margin_floor_pct ?? DEFAULT_MARGIN_FLOOR_PCT,
        maxChangePct: body.constraints?.max_change_pct ?? DEFAULT_MAX_CHANGE_PCT,
        inventoryAware: body.constraints?.inventory_aware ?? true,
      },
      rounding: body.rounding ?? 'end_99',
      now,
    });

    const response: RecommendResponse = {
      contract_version: CONTRACT_VERSION,
      model_version: OPTIMIZER_MODEL_VERSION,
      computed_at: nowIso(now),
      suggestions: result.recommendations.map(toSuggestion),
      skipped: result.skipped,
    };

    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
