import { DEFAULT_HORIZON_DAYS, type Confidence, type ForecastResult, type StageSpec } from '../contracts';
import { addDays, today } from '../dates';
import { buildForecast, type PriceChangeSpec } from '../engine/forecast';
import { assignCohorts, liveCountAtStage, normalizeStages } from '../engine/rollout';
import { roundCents, type Rounding } from '../money';
import { toGid } from '../shopify/gid';
import type { ElasticityFitRow, OrderDay, Product } from '../types';

const LAB_SHOP_ID = 'founder-lab-shop';
const LAB_TIMEZONE = 'America/Los_Angeles';
const LAB_MODEL_VERSION = 'founder-lab-simulated-fit-v1';
const MAX_LAB_SKUS = 20;

export type FounderLabRounding = Extract<Rounding, 'none' | 'end_99' | 'end_95' | 'end_00'>;

export interface FounderLabInput {
  product_name: string;
  sku_count: number;
  current_price_cents: number;
  cogs_cents: number | null;
  units_per_day: number;
  price_change_pct: number;
  elasticity: number;
  elasticity_se: number;
  history_days: number;
  horizon_days: number;
  rounding: FounderLabRounding;
}

export interface FounderLabStage extends StageSpec {
  skus_live: number;
  skus_total: number;
}

export interface FounderLabResult {
  forecast: ForecastResult;
  rollout_plan: FounderLabStage[];
  simulated_fit: {
    elasticity: number;
    elasticity_se: number;
    confidence: Confidence;
    history_days: number;
    model_version: typeof LAB_MODEL_VERSION;
    explanation: string;
  };
}

export type FounderLabApiResponse =
  | { ok: true; result: FounderLabResult }
  | { ok: false; message: string; issues?: string[] };

export const DEFAULT_FOUNDER_LAB_INPUT: Readonly<FounderLabInput> = Object.freeze({
  product_name: 'Northline Everyday Tee',
  sku_count: 8,
  current_price_cents: 4800,
  cogs_cents: 1800,
  units_per_day: 12,
  price_change_pct: 8,
  elasticity: -1.2,
  elasticity_se: 0.25,
  history_days: 120,
  horizon_days: DEFAULT_HORIZON_DAYS,
  rounding: 'end_99',
});

export class FounderLabInputError extends Error {
  constructor(readonly issues: string[]) {
    super(issues[0] ?? 'Enter valid founder lab inputs.');
    this.name = 'FounderLabInputError';
  }
}

export function parseFounderLabInput(value: unknown): FounderLabInput {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FounderLabInputError(['Send a JSON object with the lab inputs.']);
  }

  const input = value as Record<string, unknown>;
  const productName = typeof input.product_name === 'string' ? input.product_name.trim() : '';
  if (productName.length < 1 || productName.length > 80) {
    issues.push('Product name must be between 1 and 80 characters.');
  }

  const skuCount = integerInRange(input.sku_count, 1, MAX_LAB_SKUS, 'SKU count', issues);
  const currentPrice = integerInRange(
    input.current_price_cents,
    1,
    10_000_000,
    'Current price in cents',
    issues,
  );

  let cogs: number | null = null;
  if (input.cogs_cents !== null) {
    cogs = integerInRange(input.cogs_cents, 0, 10_000_000, 'Unit cost in cents', issues);
  }

  const unitsPerDay = numberInRange(input.units_per_day, 0.01, 10_000, 'Units per day', issues);
  const priceChange = numberInRange(
    input.price_change_pct,
    -90,
    400,
    'Price change',
    issues,
  );
  if (priceChange === 0) issues.push('Price change cannot be zero.');

  const elasticity = numberInRange(input.elasticity, -8, -0.05, 'Elasticity', issues);
  const elasticitySe = numberInRange(
    input.elasticity_se,
    0.05,
    3,
    'Elasticity uncertainty',
    issues,
  );
  const historyDays = integerInRange(input.history_days, 35, 365, 'History days', issues);
  const horizonDays = integerInRange(input.horizon_days, 7, 365, 'Forecast horizon', issues);

  const rounding = input.rounding;
  const allowedRounding: FounderLabRounding[] = ['none', 'end_99', 'end_95', 'end_00'];
  if (typeof rounding !== 'string' || !allowedRounding.includes(rounding as FounderLabRounding)) {
    issues.push('Choose a supported price rounding rule.');
  }

  if (issues.length > 0) throw new FounderLabInputError(issues);

  return {
    product_name: productName,
    sku_count: skuCount,
    current_price_cents: currentPrice,
    cogs_cents: cogs,
    units_per_day: unitsPerDay,
    price_change_pct: priceChange,
    elasticity,
    elasticity_se: elasticitySe,
    history_days: historyDays,
    horizon_days: horizonDays,
    rounding: rounding as FounderLabRounding,
  };
}

/**
 * Runs the production forecast and rollout planning code against synthetic rows.
 * Nothing is persisted and no Shopify client is constructed anywhere in this path.
 */
export function runFounderLab(inputValue: FounderLabInput, now = new Date()): FounderLabResult {
  const input = parseFounderLabInput(inputValue);
  const products = makeProducts(input, now);
  const orderDays = makeOrderHistory(input, products, now);
  const confidence: Confidence = input.history_days >= 90 ? 'fitted' : 'partial';
  const fits = makeFits(input, products, now, confidence);
  const change: PriceChangeSpec = {
    type: 'percent',
    percent: input.price_change_pct,
    rounding: input.rounding,
  };

  const forecast = buildForecast({
    shop: { currency: 'USD', timezone: LAB_TIMEZONE },
    products,
    orderDays,
    change,
    fits,
    horizonDays: input.horizon_days,
    now,
  });

  const stages = normalizeStages(undefined, products.length);
  const cohorts = assignCohorts(
    'founder-lab-rollout',
    products.map((product) => product.variant_gid),
    stages,
  );
  const rolloutPlan = stages.map((stage) => ({
    ...stage,
    skus_live: liveCountAtStage(cohorts, stage.index),
    skus_total: products.length,
  }));

  return {
    forecast,
    rollout_plan: rolloutPlan,
    simulated_fit: {
      elasticity: input.elasticity,
      elasticity_se: input.elasticity_se,
      confidence,
      history_days: input.history_days,
      model_version: LAB_MODEL_VERSION,
      explanation:
        'The lab turns your elasticity and uncertainty inputs into a clearly labelled simulated model fit, then passes it through the same forecast and SKU-cohort planner used by the merchant workflow.',
    },
  };
}

function makeProducts(input: FounderLabInput, now: Date): Product[] {
  const instant = now.toISOString();
  return Array.from({ length: input.sku_count }, (_, index) => {
    const suffix = input.sku_count === 1 ? '' : ` · SKU ${index + 1}`;
    return {
      id: `founder-lab-product-${index + 1}`,
      shop_id: LAB_SHOP_ID,
      product_gid: toGid('Product', 99_000_000_000 + index * 2),
      variant_gid: toGid('ProductVariant', 99_000_000_001 + index * 2),
      inventory_item_gid: toGid('InventoryItem', 98_000_000_001 + index),
      title: `${input.product_name}${suffix}`,
      variant_title: null,
      sku: `LAB-${String(index + 1).padStart(2, '0')}`,
      vendor: 'Founder Lab',
      product_type: 'Simulation',
      tags: ['founder-lab'],
      image_url: null,
      status: 'ACTIVE',
      price_cents: input.current_price_cents,
      compare_at_cents: null,
      currency: 'USD',
      cogs_cents: input.cogs_cents,
      cogs_source: input.cogs_cents === null ? 'none' : 'manual',
      cogs_updated_at: input.cogs_cents === null ? null : instant,
      is_gift_card: false,
      requires_selling_plan: false,
      has_selling_plan: false,
      inventory_quantity: 1_000,
      available_for_sale: true,
      first_synced_at: instant,
      last_synced_at: instant,
      deleted_at: null,
      created_at: instant,
      updated_at: instant,
    };
  });
}

function makeOrderHistory(input: FounderLabInput, products: readonly Product[], now: Date): OrderDay[] {
  const endDay = addDays(today(LAB_TIMEZONE, now), -1);
  const startDay = addDays(endDay, -(input.history_days - 1));
  const currentPriceDays = Math.min(input.history_days - 7, Math.max(28, Math.floor(input.history_days * 0.4)));
  const priorPrice = Math.max(1, roundCents(input.current_price_cents / 1.08));
  const priorUnits = input.units_per_day * Math.pow(priorPrice / input.current_price_cents, input.elasticity);
  const rows: OrderDay[] = [];

  products.forEach((product, productIndex) => {
    for (let dayIndex = 0; dayIndex < input.history_days; dayIndex += 1) {
      const usesCurrentPrice = dayIndex >= input.history_days - currentPriceDays;
      const listPrice = usesCurrentPrice ? input.current_price_cents : priorPrice;
      const meanUnits = usesCurrentPrice ? input.units_per_day : priorUnits;
      const units = observedWholeUnits(meanUnits, dayIndex, productIndex);
      const grossRevenue = units * listPrice;

      rows.push({
        shop_id: LAB_SHOP_ID,
        variant_gid: product.variant_gid,
        product_gid: product.product_gid,
        day: addDays(startDay, dayIndex),
        units,
        orders: units,
        gross_revenue_cents: grossRevenue,
        discount_cents: 0,
        refund_units: 0,
        refund_cents: 0,
        net_revenue_cents: grossRevenue,
        realized_unit_price_cents: listPrice,
        list_price_cents: listPrice,
        had_stockout: false,
        on_promo: false,
        source: 'seed',
      });
    }
  });

  return rows;
}

function makeFits(
  input: FounderLabInput,
  products: readonly Product[],
  now: Date,
  confidence: Confidence,
): ReadonlyMap<string, ElasticityFitRow> {
  const fittedAt = now.toISOString();
  const endDay = addDays(today(LAB_TIMEZONE, now), -1);
  const startDay = addDays(endDay, -(input.history_days - 1));
  const low = input.elasticity - 1.96 * input.elasticity_se;
  const high = Math.min(-0.05, input.elasticity + 1.96 * input.elasticity_se);

  return new Map(
    products.map((product, index) => [
      product.variant_gid,
      {
        id: `founder-lab-fit-${index + 1}`,
        shop_id: LAB_SHOP_ID,
        variant_gid: product.variant_gid,
        elasticity: input.elasticity,
        se: input.elasticity_se,
        low,
        high,
        interval_nominal: 0.95,
        n_obs: input.history_days,
        price_variation_pct: 8,
        confidence,
        confidence_explanation: 'Simulated from founder-entered lab assumptions.',
        method: 'founder_lab_scenario_override',
        shrinkage_weight: 1,
        prior_elasticity: null,
        r2: null,
        model_version: LAB_MODEL_VERSION,
        model_run_id: null,
        window_start: startDay,
        window_end: endDay,
        fitted_at: fittedAt,
        created_at: fittedAt,
      } satisfies ElasticityFitRow,
    ]),
  );
}

/** Integer daily observations whose long-run mean remains the entered decimal. */
function observedWholeUnits(mean: number, dayIndex: number, productIndex: number): number {
  const phase = ((productIndex * 37) % 100) / 100;
  const before = Math.floor(dayIndex * mean + phase);
  const after = Math.floor((dayIndex + 1) * mean + phase);
  return Math.max(0, after - before);
}

function numberInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
  issues: string[],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push(`${label} must be between ${min} and ${max}.`);
    return min;
  }
  return value;
}

function integerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
  issues: string[],
): number {
  const parsed = numberInRange(value, min, max, label, issues);
  if (!Number.isInteger(value)) {
    issues.push(`${label} must be a whole number.`);
    return Math.round(parsed);
  }
  return parsed;
}
