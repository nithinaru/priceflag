/**
 * The forecast. Two layers, deliberately in this order:
 *
 *   1. **Breakeven arithmetic** — unit-margin math, independent of the demand
 *      model. For a multi-product selection it explicitly assumes proportional
 *      demand movement, so that limitation travels with the result.
 *   2. **A predicted range** — Lane C's fitted elasticity where available, with
 *      a deliberately broad category default where history cannot identify the
 *      response. Missing data is tagged `assumption`; it never masquerades as a
 *      store-specific fit.
 *
 * Everything the card shows must be traceable to the scenario table or the
 * explanation string — no black boxes (R8).
 */

import { BASELINE_WINDOW_DAYS, DEFAULT_HORIZON_DAYS, MAX_FIT_AGE_DAYS, demoteConfidence, worstConfidence } from '../contracts';
import type {
  Confidence,
  ForecastOutcome,
  ForecastProductLine,
  ForecastResult,
  ForecastScenario,
  ForecastWarning,
} from '../contracts';
import { CONTRACT_VERSION } from '../contracts';
import { addDays, diffDays, nowIso, today, type DayString } from '../dates';
import {
  applyAbsolute,
  applyPercent,
  applyRounding,
  assertStorefrontPrice,
  formatPct,
  roundCents,
  type Cents,
  type Rounding,
} from '../money';
import type { ElasticityFitRow, OrderDay, Product } from '../types';
import { exclusionReasonFor } from '../types';

/** 95% normal interval — the multiplier on the fit's standard error. */
const Z_95 = 1.96;

/**
 * When Lane C reports no standard error we still must not pretend to precision,
 * so the range is drawn as if the SE were this fraction of the estimate.
 */
const IMPLIED_SE_FRACTION = 0.5;

/** Honest consumer-goods fallback when the store cannot identify elasticity. */
const DEFAULT_ELASTICITY = -1.5;
const DEFAULT_ELASTICITY_LOW = -2.5;
const DEFAULT_ELASTICITY_HIGH = -0.5;
const DEFAULT_ELASTICITY_SE =
  (DEFAULT_ELASTICITY_HIGH - DEFAULT_ELASTICITY_LOW) / (2 * Z_95);

/** A fitted range wider than this many points of unit change gets a warning. */
const WIDE_RANGE_POINTS = 40;

export class ForecastError extends Error {
  constructor(
    readonly code: 'no_eligible_variants' | 'no_baseline' | 'invalid_change',
    message: string,
  ) {
    super(message);
    this.name = 'ForecastError';
  }
}

export interface PriceChangeSpec {
  type: 'percent' | 'absolute';
  percent?: number;
  absolute_cents?: Cents;
  rounding?: Rounding;
}

export interface ForecastInput {
  shop: { currency: string; timezone: string };
  /** The merchant's selection. Ineligible variants may be included; they come back excluded. */
  products: Product[];
  /** Daily aggregates for those variants. Missing days are genuine zero-sales days. */
  orderDays: OrderDay[];
  change: PriceChangeSpec;
  horizonDays?: number;
  /** Lane C's fits, keyed by variant gid. Absent entries fall back to bracket math. */
  fits?: ReadonlyMap<string, ElasticityFitRow>;
  now?: Date;
}

interface VariantLine {
  product: Product;
  baseline: BaselineStats;
  unitsPerDay: number;
  ordersPerDay: number;
  basePriceCents: Cents;
  targetPriceCents: Cents;
  targetCompareAtCents: Cents | null;
  compareAtAction: 'keep' | 'clear' | 'none';
  revenueRealizationRate: number;
  cogsCents: Cents | null;
  fit: ElasticityFitRow | null;
  fitConfidence: Confidence;
}

// ---------------------------------------------------------------------------
// R13 — compare-at policy
// ---------------------------------------------------------------------------

/**
 * On a decrease, keep compare-at: the discount it implies is now more true, not
 * less. On an increase that meets or passes compare-at, clear it — leaving it
 * would display a "discount" to a price nobody is charging, which is both a
 * trust problem and, in several markets, a legal one.
 */
export function resolveCompareAt(
  currentPriceCents: Cents,
  compareAtCents: Cents | null,
  targetPriceCents: Cents,
): { target: Cents | null; action: 'keep' | 'clear' | 'none' } {
  if (compareAtCents === null || compareAtCents <= 0) return { target: null, action: 'none' };
  if (targetPriceCents >= compareAtCents) return { target: null, action: 'clear' };
  return { target: compareAtCents, action: 'keep' };
}

export function computeTargetPrice(currentPriceCents: Cents, change: PriceChangeSpec): Cents {
  const rounding: Rounding = change.rounding ?? 'none';

  if (change.type === 'percent') {
    if (change.percent === undefined || !Number.isFinite(change.percent)) {
      throw new ForecastError('invalid_change', 'a percent change needs a finite `percent`');
    }
    if (change.percent === 0) throw new ForecastError('invalid_change', 'a 0% change is not a change');
    const target = applyRounding(applyPercent(currentPriceCents, change.percent), rounding);
    try {
      return assertStorefrontPrice(target, 'target price');
    } catch {
      throw new ForecastError('invalid_change', 'the target price must be at least 1 cent');
    }
  }

  if (change.absolute_cents === undefined || !Number.isInteger(change.absolute_cents)) {
    throw new ForecastError('invalid_change', 'an absolute change needs an integer `absolute_cents`');
  }
  if (change.absolute_cents === 0) throw new ForecastError('invalid_change', 'a 0 cent change is not a change');
  const target = applyRounding(applyAbsolute(currentPriceCents, change.absolute_cents), rounding);
  try {
    return assertStorefrontPrice(target, 'target price');
  } catch {
    throw new ForecastError('invalid_change', 'the target price must be at least 1 cent');
  }
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

interface BaselineStats {
  unitsPerDay: number;
  ordersPerDay: number;
  windowDays: number;
  historyDays: number;
  observedPriceLevels: number;
  revenueRealizationRate: number;
}

/**
 * Units per day over a trailing window, counting days with no sales as zeros —
 * they are real days of demand. The window is four whole weeks so that
 * day-of-week effects cancel rather than tilt the number.
 */
export function computeBaseline(
  orderDays: readonly OrderDay[],
  variantGid: string,
  asOf: DayString,
  windowDays = BASELINE_WINDOW_DAYS,
): BaselineStats {
  return baselineFromRows(
    orderDays.filter((row) => row.variant_gid === variantGid),
    asOf,
    windowDays,
  );
}

/** Same computation with the per-variant rows already in hand. */
function baselineFromRows(
  rows: readonly OrderDay[],
  asOf: DayString,
  windowDays = BASELINE_WINDOW_DAYS,
): BaselineStats {
  if (rows.length === 0) {
    return {
      unitsPerDay: 0,
      ordersPerDay: 0,
      windowDays: 0,
      historyDays: 0,
      observedPriceLevels: 0,
      revenueRealizationRate: 1,
    };
  }

  const days = rows.map((row) => row.day).sort();
  const earliest = days[0] as DayString;
  const latest = days[days.length - 1] as DayString;
  const historyDays = diffDays(earliest, latest) + 1;

  // Anchor on the last day we actually have data for, not on "now": a sync that
  // finished yesterday should not read as two days of zero sales.
  const windowEnd = latest < asOf ? latest : asOf;
  const requestedStart = addDays(windowEnd, -(windowDays - 1));
  const windowStart = requestedStart > earliest ? requestedStart : earliest;
  const effectiveDays = Math.max(1, diffDays(windowStart, windowEnd) + 1);

  let units = 0;
  let orders = 0;
  let grossRevenue = 0;
  let netRevenue = 0;
  const priceLevels = new Set<number>();
  for (const row of rows) {
    if (row.day >= windowStart && row.day <= windowEnd) {
      units += row.units;
      orders += row.orders;
      grossRevenue += Math.max(0, row.gross_revenue_cents);
      netRevenue += row.net_revenue_cents;
    }
    const price = row.list_price_cents ?? row.realized_unit_price_cents;
    if (price !== null && price !== undefined && row.units > 0) priceLevels.add(price);
  }

  return {
    unitsPerDay: units / effectiveDays,
    ordersPerDay: orders / effectiveDays,
    windowDays: effectiveDays,
    historyDays,
    observedPriceLevels: priceLevels.size,
    revenueRealizationRate:
      grossRevenue > 0
        ? Math.min(1, Math.max(0, netRevenue / grossRevenue))
        : 1,
  };
}

// ---------------------------------------------------------------------------
// breakeven
// ---------------------------------------------------------------------------

export interface Breakeven {
  units_change_pct: number | null;
  direction: 'can_lose' | 'must_gain' | 'undefined';
  sentence: string;
}

/**
 * The unit change at which profit is unchanged, for the selection as a whole.
 *
 *   margin_before = Σ (p0 - c) · u        margin_after = Σ (p1 - c) · u
 *   breakeven multiplier k = margin_before / margin_after
 *
 * A price rise makes margin_after larger, so k < 1: units may fall by (1 - k)
 * before profit is worse than today. This is arithmetic, not a demand prediction;
 * with multiple products it assumes their unit demand moves proportionally.
 */
export function computeBreakeven(lines: readonly VariantLine[]): Breakeven {
  const anyMissingCogs = lines.some((line) => line.cogsCents === null);
  const totalUnits = lines.reduce((sum, line) => sum + line.unitsPerDay, 0);

  if (anyMissingCogs) {
    return {
      units_change_pct: null,
      direction: 'undefined',
      sentence:
        'Add your cost for these products and we can show the unit-sales change where margin breaks even.',
    };
  }
  if (totalUnits <= 0) {
    return {
      units_change_pct: null,
      direction: 'undefined',
      sentence: 'These products have no recent sales, so there is no order volume to break even against.',
    };
  }

  let marginBefore = 0;
  let marginAfter = 0;
  for (const line of lines) {
    const cogs = line.cogsCents as Cents;
    marginBefore += (line.basePriceCents * line.revenueRealizationRate - cogs) * line.unitsPerDay;
    marginAfter += (line.targetPriceCents * line.revenueRealizationRate - cogs) * line.unitsPerDay;
  }

  if (marginBefore <= 0) {
    return {
      units_change_pct: null,
      direction: 'undefined',
      sentence: "These products currently sell at or below cost, so there's no profit to protect yet.",
    };
  }
  if (marginAfter <= 0) {
    return {
      units_change_pct: null,
      direction: 'undefined',
      sentence: 'The new price is at or below your cost, so every extra order would lose money.',
    };
  }

  const k = marginBefore / marginAfter;
  const pct = (k - 1) * 100;

  if (pct < 0) {
    return {
      units_change_pct: pct,
      direction: 'can_lose',
      sentence:
        lines.length === 1
          ? `You can sell up to ${Math.abs(pct).toFixed(0)}% fewer units and still make the same profit.`
          : `If unit demand moves proportionally across these products, you can sell up to ${Math.abs(pct).toFixed(0)}% fewer units and still make the same profit.`,
    };
  }
  return {
    units_change_pct: pct,
    direction: 'must_gain',
    sentence:
      lines.length === 1
        ? `You need to sell at least ${pct.toFixed(0)}% more units to make the same profit.`
        : `If unit demand moves proportionally across these products, you need to sell at least ${pct.toFixed(0)}% more units to make the same profit.`,
  };
}

// ---------------------------------------------------------------------------
// scenarios ("show your work")
// ---------------------------------------------------------------------------

function outcomeAtUnitChange(
  lines: readonly VariantLine[],
  unitsChangePct: number,
  horizonDays: number,
  hasCogs: boolean,
): { revenue: Cents; profit: Cents | null; units: number } {
  const growth = 1 + unitsChangePct / 100;
  let revenueBefore = 0;
  let revenueAfter = 0;
  let profitBefore = 0;
  let profitAfter = 0;
  let unitsAfter = 0;

  for (const line of lines) {
    const units = line.unitsPerDay;
    const grown = units * growth;
    unitsAfter += grown;
    revenueBefore += line.basePriceCents * line.revenueRealizationRate * units;
    revenueAfter += line.targetPriceCents * line.revenueRealizationRate * grown;
    if (hasCogs) {
      const cogs = line.cogsCents as Cents;
      profitBefore += (line.basePriceCents * line.revenueRealizationRate - cogs) * units;
      profitAfter += (line.targetPriceCents * line.revenueRealizationRate - cogs) * grown;
    }
  }

  return {
    revenue: roundCents((revenueAfter - revenueBefore) * horizonDays),
    profit: hasCogs ? roundCents((profitAfter - profitBefore) * horizonDays) : null,
    units: unitsAfter * horizonDays,
  };
}

function scenarioLabel(pct: number, isBreakeven: boolean): string {
  if (isBreakeven) return 'Breakeven';
  if (pct === 0) return 'Units unchanged';
  return pct < 0 ? `${Math.abs(pct).toFixed(0)}% fewer units` : `${pct.toFixed(0)}% more units`;
}

/**
 * The scenario grid runs in the direction demand would move — down for a price
 * rise, up for a cut — with the breakeven point inserted in place. It is a
 * what-if table, not a prediction, and it is the part of the card that stays
 * legible when there is no model at all.
 */
export function buildScenarios(
  lines: readonly VariantLine[],
  breakeven: Breakeven,
  horizonDays: number,
  hasCogs: boolean,
  priceWentUp: boolean,
): ForecastScenario[] {
  const magnitudes = [0, 5, 10, 20, 30];
  const grid = magnitudes.map((magnitude) => (priceWentUp ? -magnitude : magnitude));

  if (breakeven.units_change_pct !== null) {
    const target = breakeven.units_change_pct;
    const alreadyClose = grid.some((pct) => Math.abs(pct - target) < 1);
    if (!alreadyClose) grid.push(target);
  }

  grid.sort((a, b) => b - a);

  return grid.map((pct) => {
    const isBreakeven =
      breakeven.units_change_pct !== null && Math.abs(pct - breakeven.units_change_pct) < 1e-9;
    const outcome = outcomeAtUnitChange(lines, pct, horizonDays, hasCogs);
    return {
      label: scenarioLabel(pct, isBreakeven),
      units_change_pct: Number(pct.toFixed(2)),
      units_total: Number(outcome.units.toFixed(2)),
      revenue_delta_cents: outcome.revenue,
      profit_delta_cents: outcome.profit,
      is_breakeven: isBreakeven,
    };
  });
}

// ---------------------------------------------------------------------------
// fitted range
// ---------------------------------------------------------------------------

function unitChangeFromElasticity(basePrice: Cents, targetPrice: Cents, elasticity: number): number {
  if (basePrice <= 0 || targetPrice <= 0) return 0;
  return (Math.pow(targetPrice / basePrice, elasticity) - 1) * 100;
}

/** Which elasticity to use for a given variant — the estimate, or an interval edge. */
type ElasticityPick = (fit: ElasticityFitRow) => number;

function fitSe(fit: ElasticityFitRow): number {
  // No standard error reported: do not pretend to precision, draw the range as if
  // the SE were a fixed fraction of the estimate.
  return fit.se ?? Math.abs(fit.elasticity) * IMPLIED_SE_FRACTION;
}

/**
 * Prefer Lane C's own credible bounds. Their posterior is asymmetric at the edges
 * — the high side is clipped near zero and wrong-sign fits vacate precision — so a
 * symmetric `elasticity ± z·se` would show a range the model does not actually
 * believe. Falls back to the symmetric interval per variant, so a mixed selection
 * where only some fits carry bounds still works.
 */
const pickLow: ElasticityPick = (fit) =>
  fit.low !== null && fit.low !== undefined ? fit.low : fit.elasticity - Z_95 * fitSe(fit);

const pickHigh: ElasticityPick = (fit) =>
  fit.high !== null && fit.high !== undefined ? fit.high : fit.elasticity + Z_95 * fitSe(fit);

type LineElasticityPick = (line: VariantLine) => number;

const expectedElasticity: LineElasticityPick = (line) => line.fit?.elasticity ?? DEFAULT_ELASTICITY;
const lowElasticity: LineElasticityPick = (line) =>
  line.fit ? pickLow(line.fit) : DEFAULT_ELASTICITY_LOW;
const highElasticity: LineElasticityPick = (line) =>
  line.fit ? pickHigh(line.fit) : DEFAULT_ELASTICITY_HIGH;

/**
 * Apply each SKU's own elasticity before adding money. Aggregating unit response
 * first and then applying it uniformly can reverse the profit sign when products
 * have different margins and demand sensitivity.
 */
function outcomeAtElasticities(
  lines: readonly VariantLine[],
  pick: LineElasticityPick,
  horizonDays: number,
  hasCogs: boolean,
): ForecastOutcome {
  let baseUnits = 0;
  let newUnits = 0;
  let revenueBefore = 0;
  let revenueAfter = 0;
  let profitBefore = 0;
  let profitAfter = 0;

  for (const line of lines) {
    const base = line.unitsPerDay;
    const changePct = unitChangeFromElasticity(
      line.basePriceCents,
      line.targetPriceCents,
      pick(line),
    );
    const next = base * (1 + changePct / 100);
    baseUnits += base;
    newUnits += next;
    revenueBefore += line.basePriceCents * line.revenueRealizationRate * base;
    revenueAfter += line.targetPriceCents * line.revenueRealizationRate * next;
    if (hasCogs) {
      const cogs = line.cogsCents as Cents;
      profitBefore += (line.basePriceCents * line.revenueRealizationRate - cogs) * base;
      profitAfter += (line.targetPriceCents * line.revenueRealizationRate - cogs) * next;
    }
  }

  const unitsChangePct = baseUnits > 0 ? (newUnits / baseUnits - 1) * 100 : 0;
  return {
    units_change_pct: Number(unitsChangePct.toFixed(2)),
    revenue_delta_cents: roundCents((revenueAfter - revenueBefore) * horizonDays),
    profit_delta_cents: hasCogs
      ? roundCents((profitAfter - profitBefore) * horizonDays)
      : null,
  };
}

/** Fit confidence after the staleness rule (R32): stale output is demoted, never served as fresh. */
export function effectiveFitConfidence(fit: ElasticityFitRow | null, now: Date): Confidence {
  if (!fit) return 'assumption';
  const ageDays = (now.getTime() - Date.parse(fit.fitted_at)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 'assumption';
  if (ageDays > MAX_FIT_AGE_DAYS) return demoteConfidence(fit.confidence);
  return fit.confidence;
}

// ---------------------------------------------------------------------------
// the whole card
// ---------------------------------------------------------------------------

export function buildForecast(input: ForecastInput): ForecastResult {
  const now = input.now ?? new Date();
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const asOf = today(input.shop.timezone, now);
  const rounding: Rounding = input.change.rounding ?? 'none';
  const warnings: ForecastWarning[] = [];

  const productLines: ForecastProductLine[] = [];
  const lines: VariantLine[] = [];
  let excludedCount = 0;
  let staleFitCount = 0;

  // Index once. A 500-SKU selection against 180 days of history is 90k rows, and
  // re-filtering that per variant per statistic is how a fast page turns slow.
  const rowsByVariant = new Map<string, OrderDay[]>();
  for (const row of input.orderDays) {
    const bucket = rowsByVariant.get(row.variant_gid);
    if (bucket) bucket.push(row);
    else rowsByVariant.set(row.variant_gid, [row]);
  }

  for (const product of input.products) {
    const exclusion = exclusionReasonFor(product);
    const baseline = baselineFromRows(rowsByVariant.get(product.variant_gid) ?? [], asOf);

    if (exclusion !== null) {
      excludedCount += 1;
      productLines.push({
        variant_gid: product.variant_gid,
        title: displayTitle(product),
        current_price_cents: product.price_cents,
        target_price_cents: product.price_cents,
        compare_at_cents: product.compare_at_cents,
        compare_at_action: 'none',
        cogs_cents: product.cogs_cents,
        cogs_source: product.cogs_source,
        baseline_units_per_day: Number(baseline.unitsPerDay.toFixed(4)),
        demand_multiplier: null,
        revenue_realization_rate: Number(baseline.revenueRealizationRate.toFixed(6)),
        confidence: 'assumption',
        excluded: true,
        exclusion_reason: exclusion,
      });
      continue;
    }

    const targetPriceCents = computeTargetPrice(product.price_cents, input.change);
    const compareAt = resolveCompareAt(product.price_cents, product.compare_at_cents, targetPriceCents);
    const fit = input.fits?.get(product.variant_gid) ?? null;
    const fitConfidence = effectiveFitConfidence(fit, now);
    const fitWasDemoted = fit !== null && fitConfidence !== fit.confidence;
    if (fitWasDemoted) staleFitCount += 1;
    // An `assumption`-tier fit is Lane C telling us not to lean on it. Use the
    // explicitly labelled broad default rather than presenting that weak fit as
    // store-specific evidence.
    const usableFit =
      fit !== null && !fitWasDemoted && fitConfidence !== 'assumption' ? fit : null;
    const demandMultiplier = Math.pow(
      targetPriceCents / product.price_cents,
      usableFit?.elasticity ?? DEFAULT_ELASTICITY,
    );

    lines.push({
      product,
      baseline,
      unitsPerDay: baseline.unitsPerDay,
      ordersPerDay: baseline.ordersPerDay,
      basePriceCents: product.price_cents,
      targetPriceCents,
      targetCompareAtCents: compareAt.target,
      compareAtAction: compareAt.action,
      revenueRealizationRate: baseline.revenueRealizationRate,
      cogsCents: product.cogs_cents,
      fit: usableFit,
      fitConfidence: usableFit ? fitConfidence : 'assumption',
    });

    productLines.push({
      variant_gid: product.variant_gid,
      title: displayTitle(product),
      current_price_cents: product.price_cents,
      target_price_cents: targetPriceCents,
      compare_at_cents: product.compare_at_cents,
      compare_at_action: compareAt.action,
      cogs_cents: product.cogs_cents,
      cogs_source: product.cogs_source,
      baseline_units_per_day: Number(baseline.unitsPerDay.toFixed(4)),
      demand_multiplier: Number(demandMultiplier.toFixed(6)),
      revenue_realization_rate: Number(baseline.revenueRealizationRate.toFixed(6)),
      confidence: usableFit ? fitConfidence : 'assumption',
      excluded: false,
      exclusion_reason: null,
    });
  }

  if (lines.length === 0) {
    throw new ForecastError(
      'no_eligible_variants',
      'Every selected product is excluded from repricing (gift card, subscription, or not active).',
    );
  }
  if (excludedCount > 0) {
    warnings.push({
      code: 'excluded_variants',
      message:
        excludedCount === 1
          ? '1 product is left out: gift cards and subscription products are never repriced.'
          : `${excludedCount} products are left out: gift cards and subscription products are never repriced.`,
    });
  }

  const hasCogs = lines.every((line) => line.cogsCents !== null);
  if (!hasCogs) {
    warnings.push({
      code: 'missing_cogs',
      message: 'Profit is unknown because some of these products have no cost saved. Revenue can still be calculated for each stated unit-demand scenario.',
    });
  }

  const totalUnitsPerDay = lines.reduce((sum, line) => sum + line.unitsPerDay, 0);
  const totalOrdersPerDay = lines.reduce((sum, line) => sum + line.ordersPerDay, 0);
  const revenuePerDay = roundCents(
    lines.reduce(
      (sum, line) => sum + line.basePriceCents * line.revenueRealizationRate * line.unitsPerDay,
      0,
    ),
  );
  const profitPerDay = hasCogs
    ? roundCents(
        lines.reduce(
          (sum, line) =>
            sum +
            (line.basePriceCents * line.revenueRealizationRate - (line.cogsCents as Cents)) *
              line.unitsPerDay,
          0,
        ),
      )
    : null;

  const weightedPrice = weightedAverage(lines.map((line) => [line.basePriceCents, line.unitsPerDay]));
  const avgPriceCents = roundCents(weightedPrice ?? averageOf(lines.map((line) => line.basePriceCents)));
  const avgCostCents = hasCogs
    ? roundCents(
        weightedAverage(lines.map((line) => [line.cogsCents as Cents, line.unitsPerDay])) ??
          averageOf(lines.map((line) => line.cogsCents as Cents)),
      )
    : null;

  const priceWentUp = lines.some((line) => line.targetPriceCents > line.basePriceCents);
  if (hasCogs && lines.some((line) => line.targetPriceCents < (line.cogsCents as Cents))) {
    warnings.push({
      code: 'price_below_cost',
      message: 'At least one new price is below what the product costs you. Every sale at that price loses money.',
    });
  }
  if (lines.some((line) => line.compareAtAction === 'clear')) {
    warnings.push({
      code: 'compare_at_cleared',
      message:
        'Some products show a "compare at" price that the new price meets or passes. We will clear it, so no fake discount is shown.',
    });
  }

  const breakeven = computeBreakeven(lines);
  const scenarios = buildScenarios(lines, breakeven, horizonDays, hasCogs, priceWentUp);

  // --- history quality, which is what actually decides the confidence tier ---
  const historyDays = Math.max(0, ...lines.map((line) => line.baseline.historyDays));
  const priceLevels = Math.max(0, ...lines.map((line) => line.baseline.observedPriceLevels));
  if (historyDays > 0 && historyDays < 28) {
    warnings.push({
      code: 'thin_history',
      message: `We only have ${historyDays} day${historyDays === 1 ? '' : 's'} of sales for these products, so treat the range as rough.`,
    });
  }
  if (priceLevels <= 1) {
    warnings.push({
      code: 'no_price_variation',
      message: 'These prices have never changed, so your own history cannot tell us how demand responds.',
    });
  }

  // --- predicted range ---
  const contributing = lines.filter((line) => line.fit !== null);
  const usesDefaultElasticity = contributing.length !== lines.length;
  // With trading history, always return a range. A store-specific fit is better;
  // the broad category default is still more honest than a lone point estimate.
  const useRange = totalUnitsPerDay > 0;

  let fitted: ForecastResult['fitted'] = null;
  let confidence: Confidence = 'assumption';
  let modelVersion: string | null = null;

  if (useRange) {
    const tiers = lines.map((line) => line.fitConfidence);
    confidence = worstConfidence(tiers);

    const elasticity = weightedAverage(
      lines.map((line) => [expectedElasticity(line), Math.max(line.unitsPerDay, 1e-9)]),
    ) as number;
    const se =
      weightedAverage(
        lines.map((line) => [
          line.fit
            ? line.fit.se ?? Math.abs(line.fit.elasticity) * IMPLIED_SE_FRACTION
            : DEFAULT_ELASTICITY_SE,
          Math.max(line.unitsPerDay, 1e-9),
        ]),
      ) ?? null;
    const nObs = contributing.reduce((sum, line) => sum + (line.fit as ElasticityFitRow).n_obs, 0);
    const priceVariation =
      weightedAverage(
        contributing.map((line) => [
          (line.fit as ElasticityFitRow).price_variation_pct,
          Math.max(line.unitsPerDay, 1e-9),
        ]),
      ) ?? 0;

    const expectedOutcome = outcomeAtElasticities(lines, expectedElasticity, horizonDays, hasCogs);
    const candidateA = outcomeAtElasticities(lines, lowElasticity, horizonDays, hasCogs);
    const candidateB = outcomeAtElasticities(lines, highElasticity, horizonDays, hasCogs);

    // A single joint draw can be pessimistic for profit but high for units (for
    // example, a below-cost price cut). `low` / `high` are displayable metric
    // bounds, so normalize each metric independently instead of emitting a
    // backwards range for the non-ranking metrics.
    const lowerOutcome: ForecastOutcome = {
      units_change_pct: Math.min(candidateA.units_change_pct, candidateB.units_change_pct),
      revenue_delta_cents: Math.min(candidateA.revenue_delta_cents, candidateB.revenue_delta_cents),
      profit_delta_cents:
        candidateA.profit_delta_cents === null || candidateB.profit_delta_cents === null
          ? null
          : Math.min(candidateA.profit_delta_cents, candidateB.profit_delta_cents),
    };
    const upperOutcome: ForecastOutcome = {
      units_change_pct: Math.max(candidateA.units_change_pct, candidateB.units_change_pct),
      revenue_delta_cents: Math.max(candidateA.revenue_delta_cents, candidateB.revenue_delta_cents),
      profit_delta_cents:
        candidateA.profit_delta_cents === null || candidateB.profit_delta_cents === null
          ? null
          : Math.max(candidateA.profit_delta_cents, candidateB.profit_delta_cents),
    };

    fitted = {
      elasticity: Number(elasticity.toFixed(4)),
      elasticity_se: se === null ? null : Number(se.toFixed(4)),
      n_obs: nObs,
      price_variation_pct: Number(priceVariation.toFixed(4)),
      source: usesDefaultElasticity
        ? 'category_default'
        : contributing.every((line) => ((line.fit as ElasticityFitRow).shrinkage_weight ?? 1) < 0.5)
          ? 'portfolio_prior'
          : 'model',
      expected: expectedOutcome,
      low: lowerOutcome,
      high: upperOutcome,
    };
    modelVersion = usesDefaultElasticity
      ? null
      : (contributing[0] as VariantLine | undefined)?.fit?.model_version ?? null;

    if (staleFitCount > 0) {
      warnings.push({
        code: 'stale_model',
        message:
          staleFitCount === 1
            ? 'One fitted model is more than a month old, so its old range was replaced with the broad consumer-goods default.'
            : `${staleFitCount} fitted models are more than a month old, so their old ranges were replaced with the broad consumer-goods default.`,
      });
    }
    if (Math.abs(fitted.high.units_change_pct - fitted.low.units_change_pct) > WIDE_RANGE_POINTS) {
      warnings.push({
        code: 'wide_range',
        message: 'The range is wide because your history does not pin demand down tightly. The breakeven arithmetic and its proportional-demand assumption are shown below.',
      });
    }
  }

  const assumptions = buildAssumptions(
    lines,
    horizonDays,
    hasCogs,
    rounding,
    historyDays,
    usesDefaultElasticity && useRange,
  );

  return {
    contract_version: CONTRACT_VERSION,
    generated_at: nowIso(now),
    model_version: modelVersion,
    currency: input.shop.currency,
    horizon_days: horizonDays,
    confidence,
    confidence_explanation: explainConfidence(confidence, historyDays, priceLevels, fitted),
    proposal: {
      change_type: input.change.type,
      change_pct: input.change.type === 'percent' ? (input.change.percent as number) : null,
      change_absolute_cents: input.change.type === 'absolute' ? (input.change.absolute_cents as Cents) : null,
      rounding,
      variant_count: lines.length,
    },
    baseline: {
      history_days: historyDays,
      units_per_day: Number(totalUnitsPerDay.toFixed(4)),
      orders_per_day: Number(totalOrdersPerDay.toFixed(4)),
      revenue_cents_per_day: revenuePerDay,
      profit_cents_per_day: profitPerDay,
      margin_pct:
        profitPerDay !== null && revenuePerDay > 0 ? Number(((profitPerDay / revenuePerDay) * 100).toFixed(2)) : null,
      avg_price_cents: avgPriceCents,
      avg_unit_cost_cents: avgCostCents,
      has_cogs: hasCogs,
    },
    breakeven,
    scenarios,
    fitted,
    explanation: buildExplanation(breakeven, fitted, confidence, horizonDays, hasCogs),
    assumptions,
    warnings,
    products: productLines,
  };
}

// ---------------------------------------------------------------------------
// prose
// ---------------------------------------------------------------------------

function explainConfidence(
  confidence: Confidence,
  historyDays: number,
  priceLevels: number,
  fitted: ForecastResult['fitted'],
): string {
  if (confidence === 'fitted' && fitted) {
    return `Fitted to ${historyDays} days of your own sales, across ${priceLevels} different price points on these products.`;
  }
  if (confidence === 'partial') {
    return 'Your history has only a little price movement, so the range is wider than usual and worth treating as a rough guide.';
  }
  if (priceLevels <= 1) {
    return 'These prices have never changed, so the range uses a broad consumer-goods assumption rather than claiming it was learned from your store.';
  }
  return 'We do not have enough sales history on every selected product, so the range uses a broad consumer-goods assumption where your own data is missing.';
}

function buildExplanation(
  breakeven: Breakeven,
  fitted: ForecastResult['fitted'],
  confidence: Confidence,
  horizonDays: number,
  hasCogs: boolean,
): string {
  const parts: string[] = [breakeven.sentence];

  if (fitted) {
    const expected = fitted.expected.units_change_pct;
    const direction = expected < 0 ? 'fall' : 'rise';
    const basis =
      confidence === 'assumption'
        ? 'Using a broad consumer-goods assumption'
        : 'Based on how these products have sold at different prices';
    parts.push(
      `${basis}, unit sales could ${direction} about ${Math.abs(expected).toFixed(0)}% ` +
        `(with a likely range from ${formatPct(fitted.low.units_change_pct, 0)} to ` +
        `${formatPct(fitted.high.units_change_pct, 0)}).`,
    );
    if (hasCogs && breakeven.units_change_pct !== null) {
      // The comparison reads the same in both directions: a price rise has a
      // negative breakeven (units you can afford to lose) and a cut has a
      // positive one (units you must gain), so "expected above breakeven" is
      // always the good side.
      const safe = expected > breakeven.units_change_pct;
      parts.push(
        safe
          ? 'That is on the right side of breakeven, so profit should improve — but the range is why the rollout is staged.'
          : 'That is on the wrong side of breakeven, which is why we would start with a small cohort and watch it.',
      );
    }
  } else {
    parts.push(
      `Every row in the table below is arithmetic over ${horizonDays} days under the stated proportional unit-demand assumption.`,
    );
  }

  return parts.join(' ');
}

function buildAssumptions(
  lines: readonly VariantLine[],
  horizonDays: number,
  hasCogs: boolean,
  rounding: Rounding,
  historyDays: number,
  usesDefaultElasticity: boolean,
): string[] {
  const assumptions = [
    `Baseline demand is your average daily units over the last ${BASELINE_WINDOW_DAYS} days (${historyDays} days of history available).`,
    `Figures are totals over ${horizonDays} days at the new price.`,
    'Revenue uses list prices, so any ongoing discounts are assumed to carry on unchanged.',
  ];
  if (hasCogs) {
    assumptions.push('Your cost per unit stays the same. If your costs move, re-run the forecast.');
  } else {
    assumptions.push('Profit is not shown because some products have no cost saved.');
  }
  if (rounding !== 'none') {
    assumptions.push(`New prices are rounded to end in ${rounding === 'end_00' ? 'a whole amount' : `.${rounding.slice(-2)}`}.`);
  }
  if (lines.length > 1) {
    assumptions.push(
      'Breakeven scenarios assume unit demand moves proportionally across the selected products; the predicted range applies each product’s own fitted or default response before adding money.',
    );
  }
  if (usesDefaultElasticity) {
    assumptions.push(
      `Where store history cannot identify demand response, the range uses a consumer-goods elasticity of ${DEFAULT_ELASTICITY.toFixed(1)}, with a deliberately broad ${DEFAULT_ELASTICITY_LOW.toFixed(1)} to ${DEFAULT_ELASTICITY_HIGH.toFixed(1)} range.`,
    );
  }
  return assumptions;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function displayTitle(product: Product): string {
  return product.variant_title && product.variant_title !== 'Default Title'
    ? `${product.title} — ${product.variant_title}`
    : product.title;
}

function weightedAverage(pairs: readonly [number, number][]): number | null {
  let weight = 0;
  let total = 0;
  for (const [value, w] of pairs) {
    if (w <= 0) continue;
    weight += w;
    total += value * w;
  }
  return weight > 0 ? total / weight : null;
}

function averageOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
