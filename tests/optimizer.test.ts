/**
 * Lattice optimizer tests — engine first, then the read-only /api/recommend
 * route over the demo adapter.
 *
 * Golden sanity check (also noted in lib/engine/optimize.ts): for constant
 * elasticity e < -1, the continuous maximizer of (P − c)·u0·(P/P0)^e is
 * P* = c·e/(1 + e). With e = −2.0 that is P* = 2c: COGS at 50% of the current
 * price means the current price is already optimal; COGS at 60% means the
 * optimum is a +20% move. The lattice argmax must land next to those points.
 *
 * Run: npx tsx tests/optimizer.test.ts
 */

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createHmac } from 'node:crypto';

import recommendationSchema from '../contracts/price_recommendation.schema.json';
import { DemoAdapter, setAdapter } from '../lib/adapters';
import { CONTRACT_VERSION } from '../lib/contracts';
import { addDays, today, type DayString } from '../lib/dates';
import { DEMO_SHOP_DOMAIN } from '../lib/demo/generator';
import {
  DEFAULT_MAX_CHANGE_PCT,
  OPTIMIZER_MODEL_VERSION,
  PARTIAL_CONFIDENCE_MAX_CHANGE_PCT,
  optimizePrices,
  type OptimizeInput,
} from '../lib/engine/optimize';
import { applyRounding } from '../lib/money';
import type { ElasticityFitRow, OrderDay, Product } from '../lib/types';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  await run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

// ---------------------------------------------------------------------------
// fixtures — deterministic, injected clock, UTC shop
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-10T12:00:00Z');
const SHOP = { shop_domain: 'optimizer-test.myshopify.com', currency: 'USD', timezone: 'UTC' };
const AS_OF = today(SHOP.timezone, NOW);

function product(overrides: Partial<Product>): Product {
  const iso = '2026-08-01T00:00:00Z';
  return {
    id: 'p-1',
    shop_id: 'shop-1',
    product_gid: 'gid://shopify/Product/1',
    variant_gid: 'gid://shopify/ProductVariant/1',
    inventory_item_gid: null,
    title: 'Test product',
    variant_title: null,
    sku: null,
    vendor: null,
    product_type: null,
    tags: [],
    image_url: null,
    status: 'ACTIVE',
    price_cents: 1000,
    compare_at_cents: null,
    currency: 'USD',
    cogs_cents: 600,
    cogs_source: 'manual',
    cogs_updated_at: iso,
    is_gift_card: false,
    requires_selling_plan: false,
    has_selling_plan: false,
    inventory_quantity: null,
    available_for_sale: true,
    first_synced_at: iso,
    last_synced_at: iso,
    deleted_at: null,
    created_at: iso,
    updated_at: iso,
    ...overrides,
  };
}

function fit(overrides: Partial<ElasticityFitRow>): ElasticityFitRow {
  return {
    id: 'fit-1',
    shop_id: 'shop-1',
    variant_gid: 'gid://shopify/ProductVariant/1',
    elasticity: -2,
    se: 0.2,
    low: -2,
    high: -2,
    interval_nominal: 0.8,
    n_obs: 120,
    price_variation_pct: 15,
    confidence: 'fitted',
    confidence_explanation: null,
    method: 'test',
    shrinkage_weight: 1,
    prior_elasticity: null,
    r2: 0.8,
    model_version: 'elasticity-test-1',
    model_run_id: null,
    window_start: null,
    window_end: null,
    fitted_at: '2026-08-09T00:00:00Z',
    ...overrides,
  };
}

/** 28 clean days ending "today": realization rate 1, constant demand. */
function history(variantGid: string, unitsPerDay: number, priceCents: number): OrderDay[] {
  const rows: OrderDay[] = [];
  for (let i = 0; i < 28; i += 1) {
    const day: DayString = addDays(AS_OF, -i);
    rows.push({
      shop_id: 'shop-1',
      variant_gid: variantGid,
      day,
      product_gid: null,
      units: unitsPerDay,
      orders: unitsPerDay,
      gross_revenue_cents: unitsPerDay * priceCents,
      discount_cents: 0,
      refund_units: 0,
      refund_cents: 0,
      net_revenue_cents: unitsPerDay * priceCents,
      realized_unit_price_cents: priceCents,
      list_price_cents: priceCents,
      had_stockout: false,
      on_promo: false,
      source: 'seed',
    });
  }
  return rows;
}

function run(overrides: Partial<OptimizeInput> & { products: Product[] }): ReturnType<typeof optimizePrices> {
  return optimizePrices({
    shop: SHOP,
    orderDays: overrides.products.flatMap((item) => history(item.variant_gid, 10, item.price_cents)),
    fits: new Map([[overrides.products[0]!.variant_gid, fit({})]]),
    rounding: 'none',
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

async function engineTests(): Promise<void> {
  await test('golden: e=-2, COGS 60% → lattice argmax lands at ~+20% (P* = 2c)', () => {
    const result = run({ products: [product({ price_cents: 1000, cogs_cents: 600 })] });
    assert(result.recommendations.length === 1, `expected 1 recommendation, got ${JSON.stringify(result.skipped)}`);
    const row = result.recommendations[0]!;
    // Continuous optimum is exactly 1200; the ~200-point grid must land within a step.
    assert(Math.abs(row.recommended_price_cents - 1200) <= 3, `argmax ${row.recommended_price_cents} not near 1200`);
    assert(row.robust_price_cents === row.recommended_price_cents, 'equal bounds must make robust == nominal');
    assert(row.expected.nominal_profit_delta_cents_per_day > 0, 'profit delta should be positive');
    assert(
      row.expected.robust_profit_delta_cents_per_day === row.expected.nominal_profit_delta_cents_per_day,
      'equal bounds must make robust delta == nominal delta',
    );
    assert(row.constraints.binding.length === 1 && row.constraints.binding[0] === 'none', 'optimum should be interior');
    assert(row.model_version === OPTIMIZER_MODEL_VERSION, 'model_version mismatch');
    assert(row.candidates_evaluated >= 190, 'the none-rounding grid should have ~200 candidates');
  });

  await test('golden: e=-2, COGS 50% → current price is already optimal, honest skip', () => {
    const result = run({ products: [product({ price_cents: 1000, cogs_cents: 500 })] });
    assert(result.recommendations.length === 0, 'no row expected');
    assert(result.skipped[0]?.reason === 'current_price_optimal', `got ${JSON.stringify(result.skipped)}`);
  });

  await test('a non-lattice current price beats every money-losing lattice move', () => {
    const result = run({
      products: [product({ price_cents: 3200, cogs_cents: 1600, inventory_quantity: null })],
      rounding: 'end_99',
    });
    assert(result.recommendations.length === 0, `money-losing suggestion: ${JSON.stringify(result.recommendations)}`);
    assert(result.skipped[0]?.reason === 'current_price_optimal', `got ${JSON.stringify(result.skipped)}`);
  });

  await test('max-change cap binds when the unconstrained optimum is far above', () => {
    // COGS 90% → P* = 1800, window tops out at +25% = 1250.
    const result = run({ products: [product({ price_cents: 1000, cogs_cents: 900 })] });
    const row = result.recommendations[0]!;
    assert(row.recommended_price_cents === 1250, `expected the cap 1250, got ${row.recommended_price_cents}`);
    assert(row.constraints.binding.includes('max_change'), `binding ${JSON.stringify(row.constraints.binding)}`);
    assert(row.constraints.max_change_pct === DEFAULT_MAX_CHANGE_PCT, 'max_change_pct should echo the constraint');
    assert(row.rationale.includes('25% change limit'), 'rationale must mention the binding constraint');
  });

  await test('partial-confidence suggestions are capped more tightly than fitted ones', () => {
    const item = product({ price_cents: 1000, cogs_cents: 100 });
    const result = run({
      products: [item],
      fits: new Map([
        [item.variant_gid, fit({ confidence: 'partial', elasticity: -0.5, low: -0.9, high: -0.2 })],
      ]),
    });
    const row = result.recommendations[0]!;
    assert(row.recommended_price_cents === 1070, `partial fit escaped its cap: ${row.recommended_price_cents}`);
    assert(row.constraints.max_change_pct === PARTIAL_CONFIDENCE_MAX_CHANGE_PCT, 'effective cap was not reported');
    assert(row.constraints.binding.includes('max_change'), 'partial safety cap was not marked binding');
    assert(row.rationale.includes('7% change limit'), 'merchant rationale hid the partial-fit cap');
  });

  await test('margin floor binds a deep cut', () => {
    // e=-12 → P* ≈ 872.7; floor = 800 × 1.10 = 880 sits above it (and above the -25% edge at 750).
    const result = run({
      products: [product({ price_cents: 1000, cogs_cents: 800 })],
      fits: new Map([[product({}).variant_gid, fit({ elasticity: -12, low: -12, high: -12 })]]),
    });
    const row = result.recommendations[0]!;
    assert(row.recommended_price_cents === 880, `expected the floor 880, got ${row.recommended_price_cents}`);
    assert(row.constraints.binding.includes('margin_floor'), `binding ${JSON.stringify(row.constraints.binding)}`);
    assert(row.rationale.includes('minimum margin'), 'rationale must mention the margin floor');
  });

  await test('a margin floor never forces a model-predicted loss', () => {
    // The current $10 price is below the requested 20%-over-cost floor of
    // $10.80. With very elastic demand, raising to the floor loses expected
    // profit. Staying put is an evaluation benchmark even though it is not a
    // legal candidate move, so the optimizer must skip instead of prescribing
    // the least-bad loss.
    const item = product({ price_cents: 1000, cogs_cents: 900 });
    const result = run({
      products: [item],
      fits: new Map([[item.variant_gid, fit({ elasticity: -8, low: -9, high: -7 })]]),
      constraints: { marginFloorPct: 20, maxChangePct: 15, inventoryAware: false },
    });
    assert(result.recommendations.length === 0, `losing floor repair escaped: ${JSON.stringify(result)}`);
    assert(result.skipped[0]?.reason === 'current_price_optimal', `got ${JSON.stringify(result.skipped)}`);
  });

  await test('robust argmax is the cautious one when the interval is wide', () => {
    const result = run({
      products: [product({ price_cents: 1000, cogs_cents: 600 })],
      fits: new Map([[product({}).variant_gid, fit({ elasticity: -2, low: -3, high: -1 })]]),
    });
    const row = result.recommendations[0]!;
    assert(Math.abs(row.recommended_price_cents - 1200) <= 3, 'nominal argmax should be unchanged');
    // For an increase the pessimistic bound is the most-elastic edge (-3),
    // under which the +20% move loses money — the robust argmax stays home.
    assert(row.robust_price_cents < row.recommended_price_cents, 'robust argmax should be more cautious');
    assert(
      row.expected.robust_profit_delta_cents_per_day < row.expected.nominal_profit_delta_cents_per_day,
      'worst-case delta must not exceed nominal',
    );
    assert(row.expected.robust_profit_delta_cents_per_day < 0, 'this wide interval makes the move loss-making at the bound');
    assert(row.elasticity_low === -3 && row.elasticity_high === -1, 'bounds must be reported');
  });

  await test('asymmetric rule blocks cuts the cautious bound rejects', () => {
    // Point estimate -3 wants a deep cut, but the cautious end (-0.4, near
    // inelastic) says cuts give away margin; raises also lose at the point
    // estimate. Mirrors ml/priceflag_ml/optimize.py's asymmetric selection:
    // with no move left to suggest, the SKU is skipped as already optimal.
    const base = product({ price_cents: 2000, cogs_cents: 1000 });
    const result = run({
      products: [base],
      fits: new Map([[base.variant_gid, fit({ elasticity: -3, low: -3.5, high: -0.4 })]]),
    });
    assert(result.recommendations.length === 0, 'no cut should survive the cautious bound');
    assert(
      result.skipped.some((s) => s.variant_gid === base.variant_gid && s.reason === 'current_price_optimal'),
      `expected current_price_optimal skip, got ${JSON.stringify(result.skipped)}`,
    );
  });

  await test('asymmetric rule still cuts when the cautious bound agrees', () => {
    const base = product({ price_cents: 2000, cogs_cents: 1000 });
    const result = run({
      products: [base],
      fits: new Map([[base.variant_gid, fit({ elasticity: -3, low: -3.5, high: -2.5 })]]),
    });
    const row = result.recommendations[0]!;
    assert(row.recommended_price_cents < 2000, 'the cautious bound agrees, so the cut goes through');
    assert(row.expected.robust_profit_delta_cents_per_day >= 0, 'a surviving cut must not lose at the bound');
  });

  await test('inventory cap changes the answer and is recorded', () => {
    // Cheap COGS + elastic demand → the uncapped answer is the deepest allowed
    // cut; 450 units of stock (15/day over 30 days vs baseline 10/day) cannot
    // serve that surge, so the capped answer is a shallower cut.
    const base = product({ price_cents: 1000, cogs_cents: 100, inventory_quantity: 450 });
    const fits = new Map([[base.variant_gid, fit({ elasticity: -3, low: -3, high: -3 })]]);
    const uncapped = run({ products: [base], fits, constraints: { inventoryAware: false } });
    const capped = run({ products: [base], fits, constraints: { inventoryAware: true } });
    assert(uncapped.recommendations[0]!.recommended_price_cents === 750, 'uncapped answer should hit the -25% edge');
    assert(uncapped.recommendations[0]!.constraints.inventory_cap_applied === false, 'cap flag must be off when unaware');
    const row = capped.recommendations[0]!;
    assert(row.recommended_price_cents > 750, `capped answer should be shallower, got ${row.recommended_price_cents}`);
    assert(row.recommended_price_cents < 1000, 'a cut should still win under the cap');
    assert(row.constraints.inventory_cap_applied === true, 'inventory_cap_applied must be recorded');
    assert(row.constraints.binding.includes('inventory'), `binding ${JSON.stringify(row.constraints.binding)}`);
  });

  await test('skips carry honest reasons', () => {
    const gid = (n: number): string => `gid://shopify/ProductVariant/${n}`;
    const products = [
      product({ id: 'a', variant_gid: gid(1), is_gift_card: true }),
      product({ id: 'b', variant_gid: gid(2), cogs_cents: null }),
      product({ id: 'c', variant_gid: gid(3) }), // no fit at all
      product({ id: 'd', variant_gid: gid(4) }), // stale fit → demoted → unusable
      product({ id: 'e', variant_gid: gid(5) }), // assumption-tier fit
      product({ id: 'f', variant_gid: gid(6) }), // no sales history
      product({ id: 'g', variant_gid: gid(7) }), // wrong-sign fit is confounded
    ];
    const result = optimizePrices({
      shop: SHOP,
      products,
      orderDays: products.slice(0, 5).flatMap((item) => history(item.variant_gid, 10, item.price_cents)),
      fits: new Map([
        [gid(2), fit({ variant_gid: gid(2) })],
        [gid(4), fit({ variant_gid: gid(4), fitted_at: '2026-06-01T00:00:00Z' })],
        [gid(5), fit({ variant_gid: gid(5), confidence: 'assumption' })],
        [gid(6), fit({ variant_gid: gid(6) })],
        [gid(7), fit({ variant_gid: gid(7), elasticity: 0.4, low: 0.1, high: 0.8 })],
      ]),
      rounding: 'none',
      now: NOW,
    });
    const reasons = new Map(result.skipped.map((item) => [item.variant_gid, item.reason]));
    assert(reasons.get(gid(1)) === 'gift_card', `gid 1: ${reasons.get(gid(1))}`);
    assert(reasons.get(gid(2)) === 'missing_cogs', `gid 2: ${reasons.get(gid(2))}`);
    assert(reasons.get(gid(3)) === 'no_usable_fit', `gid 3: ${reasons.get(gid(3))}`);
    assert(reasons.get(gid(4)) === 'no_usable_fit', `gid 4 (stale): ${reasons.get(gid(4))}`);
    assert(reasons.get(gid(5)) === 'no_usable_fit', `gid 5 (assumption): ${reasons.get(gid(5))}`);
    assert(reasons.get(gid(6)) === 'no_demand', `gid 6: ${reasons.get(gid(6))}`);
    assert(reasons.get(gid(7)) === 'positive_elasticity', `gid 7 (positive): ${reasons.get(gid(7))}`);
    assert(result.recommendations.length === 0, 'nothing should be recommended');
  });

  await test('end_99 candidates are exactly the lattice, and the argmax stays on it', () => {
    // COGS 1200, e=-2 → P* = 2400; window [1500, 2498] holds 1599..2399.
    const result = run({
      products: [product({ price_cents: 1999, cogs_cents: 1200 })],
      rounding: 'end_99',
    });
    const row = result.recommendations[0]!;
    assert(row.rounding === 'end_99', 'rounding must be echoed');
    assert(row.recommended_price_cents === 2399, `expected 2399, got ${row.recommended_price_cents}`);
    assert(row.recommended_price_cents % 100 === 99, 'recommended price must end in .99');
    assert(
      applyRounding(row.recommended_price_cents, 'end_99') === row.recommended_price_cents,
      'recommended price must be a fixed point of applyRounding',
    );
    assert(row.candidates_evaluated === 9, `expected 9 lattice points, got ${row.candidates_evaluated}`);
  });

  await test('rows validate against contracts/price_recommendation.schema.json', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(recommendationSchema);
    const result = run({ products: [product({ price_cents: 1000, cogs_cents: 600 })] });
    const row = result.recommendations[0]!;
    assert(validate(row), `contract violation: ${JSON.stringify(validate.errors)}`);
  });

  await test('the search is deterministic for a fixed injected now', () => {
    const input = { products: [product({ price_cents: 1000, cogs_cents: 600, inventory_quantity: 500 })] };
    const a = run(input);
    const b = run(input);
    assert(JSON.stringify(a) === JSON.stringify(b), 'identical inputs must produce identical output');
  });

  await test('randomized feasible inputs never emit a losing or out-of-bounds move', () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const roundings = ['none', 'end_99', 'end_95', 'end_00'] as const;

    for (let index = 0; index < 300; index += 1) {
      const price = 500 + Math.floor(random() * 49_500);
      // Keep today's price above the default 10% floor so "stay" is a legal
      // benchmark and every emitted move must beat doing nothing.
      const cogs = Math.max(1, Math.floor(price * (0.05 + random() * 0.75)));
      const elasticity = -(0.1 + random() * 7.9);
      const uncertainty = 0.05 + random() * 1.5;
      const rounding = roundings[Math.floor(random() * roundings.length)]!;
      const item = product({
        id: `fuzz-${index}`,
        variant_gid: `gid://shopify/ProductVariant/${10_000 + index}`,
        price_cents: price,
        cogs_cents: cogs,
        inventory_quantity: random() < 0.7 ? Math.floor(random() * 2_000) : null,
      });
      const result = run({
        products: [item],
        fits: new Map([
          [
            item.variant_gid,
            fit({
              variant_gid: item.variant_gid,
              elasticity,
              low: Math.max(-12, elasticity - uncertainty),
              high: Math.min(2, elasticity + uncertainty),
            }),
          ],
        ]),
        rounding,
      });
      for (const row of result.recommendations) {
        assert(
          row.expected.nominal_profit_delta_cents_per_day > 0,
          `case ${index} emitted a non-profitable move: ${JSON.stringify(row)}`,
        );
        if (row.recommended_price_cents < row.current_price_cents) {
          assert(
            row.expected.robust_profit_delta_cents_per_day >= 0,
            `case ${index} emitted a cut rejected by the cautious bound: ${JSON.stringify(row)}`,
          );
        }
        const changePct = Math.abs(row.recommended_price_cents / row.current_price_cents - 1) * 100;
        assert(changePct <= DEFAULT_MAX_CHANGE_PCT + 1e-9, `case ${index} escaped the max-change cap`);
        assert(
          rounding === 'none' || applyRounding(row.recommended_price_cents, rounding) === row.recommended_price_cents,
          `case ${index} escaped the ${rounding} lattice`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// route — modeled on tests/merchant-api.test.ts's harness
// ---------------------------------------------------------------------------

const API_KEY = 'optimizer-test-key';
const API_SECRET = 'optimizer-test-secret';

function token(shop: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: API_KEY,
      sub: 'merchant-user-1',
      exp: now + 60,
      nbf: now - 5,
      iat: now,
      jti: `jti-${shop}`,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', API_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function request(body: unknown, bearer?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request('https://priceflag.test/api/recommend', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function routeTests(): Promise<void> {
  process.env.SHOPIFY_API_KEY = API_KEY;
  process.env.SHOPIFY_API_SECRET = API_SECRET;
  process.env.VERCEL_ENV = 'production';
  process.env.PRICEFLAG_MODE = 'demo';

  const { POST: recommend } = await import('../app/api/recommend/route');

  const adapter = DemoAdapter.ephemeral(20260810);
  setAdapter(adapter);
  const shops = await adapter.listShops();
  const shop = shops[0]!;
  const products = await adapter.listProducts(shop.id, { only_repriceable: true, limit: 3 });
  const gids = products.items.map((item) => item.variant_gid);
  assert(gids.length > 0, 'demo store has no repriceable products');

  await test('route rejects a missing bearer token', async () => {
    const response = await recommend(request({ contract_version: CONTRACT_VERSION, variant_gids: gids }));
    assert(response.status === 401, `expected 401, got ${response.status}`);
  });

  await test('route rejects an invalid body with field problems', async () => {
    const response = await recommend(
      request({ contract_version: CONTRACT_VERSION, variant_gids: [], rounding: 'end_49' }, token(DEMO_SHOP_DOMAIN)),
    );
    const body = (await response.json()) as { error?: { code?: string } };
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assert(body.error?.code === 'invalid_recommend_request', `got ${body.error?.code}`);
  });

  await test('route 404s unknown variants like the forecast does', async () => {
    const response = await recommend(
      request(
        { contract_version: CONTRACT_VERSION, variant_gids: ['gid://shopify/ProductVariant/999999999'] },
        token(DEMO_SHOP_DOMAIN),
      ),
    );
    const body = (await response.json()) as { error?: { code?: string } };
    assert(response.status === 404, `expected 404, got ${response.status}`);
    assert(body.error?.code === 'variant_not_found', `got ${body.error?.code}`);
  });

  await test('route returns suggestions read-only, every variant accounted for', async () => {
    const rolloutsBefore = await adapter.listRollouts(shop.id);
    const response = await recommend(
      request({ contract_version: CONTRACT_VERSION, variant_gids: gids }, token(DEMO_SHOP_DOMAIN)),
    );
    const body = (await response.json()) as {
      contract_version?: string;
      model_version?: string;
      suggestions?: Record<string, unknown>[];
      skipped?: { variant_gid: string; reason: string }[];
    };
    assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
    assert(body.contract_version === CONTRACT_VERSION, 'missing contract_version');
    assert(body.model_version === OPTIMIZER_MODEL_VERSION, 'missing model_version');
    assert(Array.isArray(body.suggestions) && Array.isArray(body.skipped), 'suggestions/skipped must be arrays');
    const accounted = new Set([
      ...body.suggestions!.map((item) => item.variant_gid as string),
      ...body.skipped!.map((item) => item.variant_gid),
    ]);
    for (const gid of gids) assert(accounted.has(gid), `variant ${gid} is unaccounted for`);
    for (const suggestion of body.suggestions!) {
      const proposal = suggestion.proposal as {
        contract_version: string;
        variant_gids: string[];
        change: { type: string; absolute_cents: number; rounding: string };
      };
      assert(proposal.contract_version === CONTRACT_VERSION, 'prefill contract_version');
      assert(proposal.variant_gids.length === 1 && proposal.variant_gids[0] === suggestion.variant_gid, 'prefill gid');
      assert(proposal.change.type === 'absolute' && proposal.change.rounding === 'none', 'prefill change shape');
      assert(
        proposal.change.absolute_cents ===
          (suggestion.recommended_price_cents as number) - (suggestion.current_price_cents as number),
        'prefill delta must reproduce the recommended price exactly',
      );
      assert(proposal.change.absolute_cents !== 0, 'a zero-delta prefill would be an invalid proposal');
    }
    const rolloutsAfter = await adapter.listRollouts(shop.id);
    assert(rolloutsAfter.length === rolloutsBefore.length, 'the recommend route must not create rollouts');
  });

  await test('route is disabled while the kill switch is engaged', async () => {
    await adapter.updateShop(shop.id, {
      kill_switch_engaged_at: new Date().toISOString(),
      kill_switch_reason: 'test',
    });
    try {
      const response = await recommend(
        request({ contract_version: CONTRACT_VERSION, variant_gids: gids }, token(DEMO_SHOP_DOMAIN)),
      );
      const body = (await response.json()) as { error?: { code?: string } };
      assert(response.status === 409, `expected 409, got ${response.status}`);
      assert(body.error?.code === 'kill_switch_engaged', `got ${body.error?.code}`);
    } finally {
      await adapter.updateShop(shop.id, { kill_switch_engaged_at: null, kill_switch_reason: null });
    }
  });

  setAdapter(null);
}

async function main(): Promise<void> {
  await engineTests();
  await routeTests();
  process.stdout.write(`${passed} optimizer tests passed\n`);
}

void main().catch((cause) => {
  process.stderr.write(`FAIL: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
