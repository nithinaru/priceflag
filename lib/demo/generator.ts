/**
 * The demo store.
 *
 * This is not filler data. It is the permanent sales demo, the smoke-test
 * fixture, and — because it is generated from *known* elasticities — the ground
 * truth Lane C's eval harness scores against (C1 ports and extends it). So it has
 * to contain the awkward cases a real store contains:
 *
 *   - products whose price has never changed (no price variation, so honest
 *     elasticity estimation is impossible and the answer must be `assumption`)
 *   - products with one or two historical price changes (estimable)
 *   - products with no COGS at all (the "profit unknown — add cost" state)
 *   - a gift card and a subscription product (never repriceable, R22)
 *   - weekly seasonality, a slow trend, promo days, and multi-day stockouts
 *   - low-volume SKUs where a zero-unit day means nothing
 *
 * Everything is deterministic from `seed`, so two runs produce byte-identical
 * data and a failing test can be reproduced.
 */

import { addDays, today, type DayString } from '../dates';
import { applyPercent, parseMoneyToCents, roundCents, type Cents } from '../money';
import { toGid } from '../shopify/gid';
import { DEFAULT_HISTORY_DAYS } from '../contracts';
import type { OrderDayUpsert, ProductUpsert, ShopUpsert } from '../types';

export const DEMO_SHOP_DOMAIN = 'priceflag-demo.myshopify.com';
export const DEMO_TIMEZONE = 'America/New_York';
export const DEMO_CURRENCY = 'USD';

/** Mulberry32 — small, fast, and identical across runtimes. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng: () => number): number {
  // Box-Muller. u1 is floored off zero because log(0) is -Infinity.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Knuth's method. Only sane for small lambda, which daily retail units are. */
function poisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * standardNormal(rng)));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  let product = rng();
  while (product > limit) {
    k += 1;
    product *= rng();
  }
  return k;
}

/** Marsaglia–Tsang gamma, shape > 0, unit scale. */
function gamma(rng: () => number, shape: number): number {
  if (shape < 1) {
    // Boost to shape+1 and scale back down, which is exact.
    return gamma(rng, shape + 1) * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;

    const u = Math.max(rng(), 1e-12);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Negative binomial by Gamma–Poisson mixture: `var = mu + mu²/k`.
 *
 * Real daily retail counts are overdispersed relative to Poisson — a bulk order,
 * an influencer mention, a quiet Tuesday. Generating Poisson data would make the
 * monitoring bands look better calibrated than they will ever be on a real store,
 * and band calibration is a safety property here because it drives auto-rollback.
 * Requested by Lane C (request 7) so the TypeScript and Python fixtures agree.
 *
 * Lower `k` = more overdispersion. k → ∞ converges to Poisson.
 */
function negativeBinomial(rng: () => number, mean: number, k: number): number {
  if (mean <= 0) return 0;
  if (!Number.isFinite(k) || k <= 0) return poisson(rng, mean);
  return poisson(rng, gamma(rng, k) * (mean / k));
}

interface DemoProductSpec {
  handle: string;
  title: string;
  variantTitle: string | null;
  productType: string;
  vendor: string;
  price: string;
  compareAt: string | null;
  /** null models a merchant who never entered a cost (R3). */
  cost: string | null;
  baseUnitsPerDay: number;
  /** Ground truth for Lane C. More negative = more price sensitive. */
  trueElasticity: number;
  /** Price changes in this product's history, as day offsets from the window start. */
  priceChanges: { atDayOffset: number; pct: number }[];
  isGiftCard?: boolean;
  hasSellingPlan?: boolean;
}

/**
 * 14 products. Chosen so the catalog covers every state the UI has to render,
 * not to look impressive.
 */
const CATALOG: DemoProductSpec[] = [
  {
    handle: 'everyday-tee',
    title: 'Everyday Tee',
    variantTitle: 'Medium / Black',
    productType: 'Apparel',
    vendor: 'Northline',
    price: '32.00',
    compareAt: null,
    cost: '11.50',
    baseUnitsPerDay: 14,
    trueElasticity: -1.8,
    // Two price levels and plenty of volume: this is the product that should
    // reach `fitted` confidence.
    priceChanges: [
      { atDayOffset: 46, pct: 9 },
      { atDayOffset: 118, pct: -6 },
    ],
  },
  {
    handle: 'everyday-tee-large',
    title: 'Everyday Tee',
    variantTitle: 'Large / Black',
    productType: 'Apparel',
    vendor: 'Northline',
    price: '32.00',
    compareAt: null,
    cost: '11.50',
    baseUnitsPerDay: 9,
    trueElasticity: -1.65,
    priceChanges: [{ atDayOffset: 46, pct: 9 }],
  },
  {
    handle: 'merino-crew',
    title: 'Merino Crew Sweater',
    variantTitle: 'Medium / Oat',
    productType: 'Apparel',
    vendor: 'Northline',
    price: '148.00',
    compareAt: '178.00',
    cost: '61.00',
    baseUnitsPerDay: 3.2,
    trueElasticity: -1.15,
    priceChanges: [{ atDayOffset: 92, pct: -12 }],
  },
  {
    handle: 'canvas-tote',
    title: 'Canvas Tote',
    variantTitle: null,
    productType: 'Accessories',
    vendor: 'Northline',
    price: '58.00',
    compareAt: null,
    cost: '19.75',
    baseUnitsPerDay: 6.5,
    trueElasticity: -2.4,
    priceChanges: [{ atDayOffset: 70, pct: 12 }],
  },
  {
    handle: 'leather-belt',
    title: 'Bridle Leather Belt',
    variantTitle: '34',
    productType: 'Accessories',
    vendor: 'Fenwick',
    price: '89.00',
    compareAt: null,
    // A real store always has a few of these.
    cost: null,
    baseUnitsPerDay: 2.1,
    trueElasticity: -1.35,
    priceChanges: [],
  },
  {
    handle: 'wool-socks',
    title: 'Wool Socks',
    variantTitle: '3-pack',
    productType: 'Accessories',
    vendor: 'Fenwick',
    price: '24.00',
    compareAt: null,
    cost: '8.20',
    baseUnitsPerDay: 11,
    trueElasticity: -2.9,
    priceChanges: [{ atDayOffset: 130, pct: 8 }],
  },
  {
    handle: 'ceramic-mug',
    title: 'Ceramic Mug',
    variantTitle: 'Sand',
    productType: 'Home',
    vendor: 'Kilnworks',
    price: '28.00',
    compareAt: null,
    cost: '9.40',
    baseUnitsPerDay: 7.8,
    trueElasticity: -1.55,
    // Never repriced: the honest answer for this one is `assumption`, forever,
    // until the merchant actually moves the price.
    priceChanges: [],
  },
  {
    handle: 'linen-throw',
    title: 'Linen Throw',
    variantTitle: 'Indigo',
    productType: 'Home',
    vendor: 'Kilnworks',
    price: '124.00',
    compareAt: '149.00',
    cost: '52.00',
    baseUnitsPerDay: 1.4,
    trueElasticity: -0.85,
    priceChanges: [],
  },
  {
    handle: 'pour-over-kettle',
    title: 'Pour-Over Kettle',
    variantTitle: null,
    productType: 'Kitchen',
    vendor: 'Kilnworks',
    price: '96.00',
    compareAt: null,
    cost: '44.00',
    baseUnitsPerDay: 2.6,
    trueElasticity: -1.05,
    priceChanges: [{ atDayOffset: 58, pct: 6 }],
  },
  {
    handle: 'coffee-beans',
    title: 'Single-Origin Beans',
    variantTitle: '340g',
    productType: 'Grocery',
    vendor: 'Ridgeline',
    price: '21.00',
    compareAt: null,
    cost: '9.10',
    baseUnitsPerDay: 18,
    trueElasticity: -2.15,
    priceChanges: [
      { atDayOffset: 34, pct: 7 },
      { atDayOffset: 104, pct: 5 },
    ],
  },
  {
    handle: 'travel-mug',
    title: 'Insulated Travel Mug',
    variantTitle: '12oz',
    productType: 'Kitchen',
    vendor: 'Ridgeline',
    price: '42.00',
    compareAt: null,
    // Deliberately low volume: a zero-unit day here must never trip a guardrail.
    cost: '17.60',
    baseUnitsPerDay: 0.6,
    trueElasticity: -1.9,
    priceChanges: [],
  },
  {
    handle: 'field-notebook',
    title: 'Field Notebook',
    variantTitle: 'Pack of 2',
    productType: 'Stationery',
    vendor: 'Ridgeline',
    price: '18.00',
    compareAt: null,
    cost: '5.40',
    baseUnitsPerDay: 4.4,
    trueElasticity: -2.6,
    priceChanges: [{ atDayOffset: 82, pct: -10 }],
  },
  {
    handle: 'gift-card',
    title: 'Gift Card',
    variantTitle: '$50',
    productType: 'Gift Cards',
    vendor: 'Northline',
    price: '50.00',
    compareAt: null,
    cost: null,
    baseUnitsPerDay: 1.2,
    trueElasticity: -0.2,
    priceChanges: [],
    isGiftCard: true,
  },
  {
    handle: 'coffee-subscription',
    title: 'Coffee Subscription',
    variantTitle: 'Monthly',
    productType: 'Grocery',
    vendor: 'Ridgeline',
    price: '38.00',
    compareAt: null,
    cost: '16.00',
    baseUnitsPerDay: 2.8,
    trueElasticity: -0.7,
    priceChanges: [],
    hasSellingPlan: true,
  },
];

/** Weekly shape: retail peaks Thursday–Saturday. Index 1 = Monday. */
const DOW_MULTIPLIER: Record<number, number> = {
  1: 0.9,
  2: 0.95,
  3: 1.0,
  4: 1.12,
  5: 1.25,
  6: 1.18,
  7: 0.82,
};

/** Overdispersion range for the negative-binomial noise, per Lane C's request 7. */
export const DISPERSION_K_RANGE: readonly [number, number] = [4, 12];

export interface DemoTruth {
  variant_gid: string;
  title: string;
  true_elasticity: number;
  /** Negative-binomial dispersion used for this SKU: `var = mu + mu²/k`. */
  dispersion_k: number;
  /** Distinct list prices actually observed — the ceiling on what any fit can know. */
  price_levels: number;
  /** What an honest estimator should be able to claim about this product. */
  expected_confidence: 'fitted' | 'partial' | 'assumption';
}

export interface DemoStore {
  shop: ShopUpsert;
  products: ProductUpsert[];
  orderDays: OrderDayUpsert[];
  /** Applied price changes, oldest first — seeds the journal so history is complete. */
  priceHistory: {
    variant_gid: string;
    product_gid: string;
    title: string;
    sku: string | null;
    day: DayString;
    before_price_cents: Cents;
    after_price_cents: Cents;
  }[];
  /** Ground truth. Lane C scores against this; the app never reads it. */
  truth: DemoTruth[];
  window: { from: DayString; to: DayString; days: number };
}

export interface GenerateOptions {
  seed?: number;
  historyDays?: number;
  /** Last day of generated history. Defaults to yesterday in the shop's timezone. */
  endDay?: DayString;
  now?: Date;
}

export function generateDemoStore(options: GenerateOptions = {}): DemoStore {
  const seed = options.seed ?? 20260729;
  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS;
  const now = options.now ?? new Date();
  const endDay = options.endDay ?? addDays(today(DEMO_TIMEZONE, now), -1);
  const startDay = addDays(endDay, -(historyDays - 1));

  const rng = mulberry32(seed);
  const nowIso = now.toISOString();

  const shop: ShopUpsert = {
    shop_domain: DEMO_SHOP_DOMAIN,
    name: 'Northline Goods (demo)',
    email: 'demo@priceflag.app',
    currency: DEMO_CURRENCY,
    timezone: DEMO_TIMEZONE,
    mode: 'demo',
    api_version: '2026-07',
    scopes: 'read_products,write_products,read_orders,read_all_orders',
    plan_name: 'demo',
    access_token_enc: null,
    notify_emails: ['demo@priceflag.app'],
    installed_at: nowIso,
  };

  const products: ProductUpsert[] = [];
  const orderDays: OrderDayUpsert[] = [];
  const priceHistory: DemoStore['priceHistory'] = [];
  const truth: DemoTruth[] = [];

  // Store-wide promo days, so a promo lifts the whole catalog at once the way a
  // real sale does. Lane C needs this as a control, not as noise.
  const promoDays = new Set<DayString>();
  for (let i = 0; i < historyDays; i += 1) {
    if (rng() < 0.07) promoDays.add(addDays(startDay, i));
  }

  CATALOG.forEach((spec, index) => {
    const productId = 8_400_000_000 + index * 17;
    const variantId = 46_100_000_000 + index * 23;
    const productGid = toGid('Product', productId);
    const variantGid = toGid('ProductVariant', variantId);
    const inventoryItemGid = toGid('InventoryItem', 51_200_000_000 + index * 29);

    const finalPriceCents = parseMoneyToCents(spec.price);
    const compareAtCents = spec.compareAt === null ? null : parseMoneyToCents(spec.compareAt);
    const cogsCents = spec.cost === null ? null : parseMoneyToCents(spec.cost);
    const sku = `${spec.handle.toUpperCase().replace(/-/g, '')}-${index + 1}`;

    // Walk the price changes backwards from today's price to recover the price on
    // each historical day: the current price is the one fact we know for certain.
    const changes = [...spec.priceChanges].sort((a, b) => a.atDayOffset - b.atDayOffset);
    const priceAfterChange: Cents[] = [];
    let cursor = finalPriceCents;
    for (let i = changes.length - 1; i >= 0; i -= 1) {
      priceAfterChange[i] = cursor;
      const change = changes[i] as { atDayOffset: number; pct: number };
      // Invert the percentage change to get the price that preceded it.
      cursor = roundCents(cursor / (1 + change.pct / 100));
    }
    const initialPriceCents = cursor;

    const priceOnDay = (dayOffset: number): Cents => {
      let price = initialPriceCents;
      changes.forEach((change, i) => {
        if (dayOffset >= change.atDayOffset) price = priceAfterChange[i] as Cents;
      });
      return price;
    };

    changes.forEach((change, i) => {
      const before = i === 0 ? initialPriceCents : (priceAfterChange[i - 1] as Cents);
      priceHistory.push({
        variant_gid: variantGid,
        product_gid: productGid,
        title: spec.title,
        sku,
        day: addDays(startDay, change.atDayOffset),
        before_price_cents: before,
        after_price_cents: priceAfterChange[i] as Cents,
      });
    });

    products.push({
      product_gid: productGid,
      variant_gid: variantGid,
      inventory_item_gid: inventoryItemGid,
      title: spec.title,
      variant_title: spec.variantTitle,
      sku,
      vendor: spec.vendor,
      product_type: spec.productType,
      tags: [spec.productType.toLowerCase()],
      image_url: null,
      status: 'ACTIVE',
      price_cents: finalPriceCents,
      compare_at_cents: compareAtCents,
      currency: DEMO_CURRENCY,
      cogs_cents: cogsCents,
      cogs_source: cogsCents === null ? 'none' : 'shopify',
      cogs_updated_at: cogsCents === null ? null : nowIso,
      is_gift_card: spec.isGiftCard ?? false,
      requires_selling_plan: false,
      has_selling_plan: spec.hasSellingPlan ?? false,
      inventory_quantity: 40 + Math.floor(rng() * 120),
      available_for_sale: true,
    });

    // Stockouts: one or two multi-day gaps for most products. A gap is missing
    // supply, not weak demand, and Lane C has to be able to tell them apart.
    const stockouts = new Set<DayString>();
    const stockoutCount = rng() < 0.55 ? 1 : 0;
    for (let s = 0; s < stockoutCount; s += 1) {
      const start = Math.floor(rng() * (historyDays - 12)) + 5;
      const length = 2 + Math.floor(rng() * 4);
      for (let d = 0; d < length; d += 1) stockouts.add(addDays(startDay, start + d));
    }

    const priceLevels = new Set<Cents>();

    // Per-SKU overdispersion, drawn once so it is stable across the series.
    const dispersionK =
      DISPERSION_K_RANGE[0] + rng() * (DISPERSION_K_RANGE[1] - DISPERSION_K_RANGE[0]);

    for (let offset = 0; offset < historyDays; offset += 1) {
      const day = addDays(startDay, offset);
      const listPrice = priceOnDay(offset);
      const onPromo = promoDays.has(day) && !spec.isGiftCard;
      const hadStockout = stockouts.has(day);

      // Demand = base × weekday shape × slow trend × price response × promo lift.
      const dow = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const seasonal = DOW_MULTIPLIER[dow] ?? 1;
      const trend = 1 + 0.0009 * offset; // ~17% growth over 180 days
      const priceRatio = listPrice / initialPriceCents;
      const priceResponse = Math.pow(priceRatio, spec.trueElasticity);
      const promoLift = onPromo ? 1.55 : 1;

      const lambda = spec.baseUnitsPerDay * seasonal * trend * priceResponse * promoLift;
      const units = hadStockout ? 0 : negativeBinomial(rng, lambda, dispersionK);

      if (units > 0) priceLevels.add(listPrice);

      // A promo is a discount off the list price, which is exactly why the
      // regressor is list price and the realized price is recorded separately.
      const effectivePrice = onPromo ? applyPercent(listPrice, -15) : listPrice;
      const gross = units * listPrice;
      const discount = units * (listPrice - effectivePrice);
      // Occasional refund, a few days after the fact in a real store; here it is
      // folded into the same day to keep the aggregate honest and simple.
      const refundUnits = units > 0 && rng() < 0.02 ? 1 : 0;
      const refund = refundUnits * effectivePrice;
      const net = gross - discount - refund;

      orderDays.push({
        variant_gid: variantGid,
        product_gid: productGid,
        day,
        units,
        orders: units === 0 ? 0 : Math.max(1, Math.round(units * 0.85)),
        gross_revenue_cents: gross,
        discount_cents: discount,
        refund_units: refundUnits,
        refund_cents: refund,
        net_revenue_cents: net,
        realized_unit_price_cents: units > 0 ? roundCents(net / Math.max(1, units - refundUnits)) : null,
        list_price_cents: listPrice,
        had_stockout: hadStockout,
        on_promo: onPromo,
        source: 'seed',
      });
    }

    const levels = priceLevels.size;
    truth.push({
      variant_gid: variantGid,
      title: spec.variantTitle ? `${spec.title} — ${spec.variantTitle}` : spec.title,
      true_elasticity: spec.trueElasticity,
      dispersion_k: Number(dispersionK.toFixed(4)),
      price_levels: levels,
      // What an honest estimator can claim: two price levels and real volume is
      // estimable; one level is not, no matter how much data there is.
      expected_confidence:
        levels >= 3 && spec.baseUnitsPerDay >= 4
          ? 'fitted'
          : levels >= 2
            ? 'partial'
            : 'assumption',
    });
  });

  return {
    shop,
    products,
    orderDays,
    priceHistory: priceHistory.sort((a, b) => a.day.localeCompare(b.day)),
    truth,
    window: { from: startDay, to: endDay, days: historyDays },
  };
}

/** Convenience for tests: the demo variant gids that Priceflag will actually reprice. */
export function repriceableDemoVariantGids(store: DemoStore): string[] {
  return store.products
    .filter((product) => !product.is_gift_card && !product.has_selling_plan && !product.requires_selling_plan)
    .map((product) => product.variant_gid);
}
