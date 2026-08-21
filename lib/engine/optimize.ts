/**
 * Per-SKU constrained lattice search — the TypeScript side of price
 * optimization, so demo mode (and any store with fresh fits) gets suggestions
 * without waiting for the Python nightly.
 *
 * Same demand model as the forecast: `units1 = units0 * (P1/P0)^elasticity`,
 * with the revenue realization rate honored exactly as
 * `outcomeAtElasticities` does. Same baseline, same fit-staleness demotion,
 * same integer-cents discipline. Deterministic and pure: `now` is injected,
 * nothing here reads a clock or rolls a die.
 *
 * Honesty rules baked in:
 *  - No fit, a demoted (stale) fit, or an assumption-tier fit → the SKU is
 *    skipped, never "optimized" on the broad category default. A default
 *    elasticity is fine for showing a *range* on a merchant's own proposal; it
 *    is not fine as the objective of a machine-made suggestion.
 *  - No COGS → no profit objective → skipped. We never guess costs (R3).
 *  - Every row carries the constraint that bound it and a plain-language
 *    rationale — suggestions show their work like forecasts do.
 */

import { CONTRACT_VERSION, type Confidence } from '../contracts';
import { nowIso, today } from '../dates';
import {
  MIN_STOREFRONT_PRICE_CENTS,
  applyRounding,
  formatCents,
  roundCents,
  type Cents,
  type Rounding,
} from '../money';
import type { ElasticityFitRow, OrderDay, Product } from '../types';
import { exclusionReasonFor } from '../types';
import { computeBaseline, effectiveFitConfidence, pickHigh, pickLow } from './forecast';

// ---------------------------------------------------------------------------
// public shapes
// ---------------------------------------------------------------------------

export const OPTIMIZER_MODEL_VERSION = 'optimizer-lattice-1.0-ts';

export const DEFAULT_MARGIN_FLOOR_PCT = 10;
export const DEFAULT_MAX_CHANGE_PCT = 25;
/** Partial fits carry real store signal but wide uncertainty. Keep their
 * machine-made moves small; merchants can still model a larger manual move. */
export const PARTIAL_CONFIDENCE_MAX_CHANGE_PCT = 7;
/** A price cut only helps if stock can serve the demand it buys. */
export const INVENTORY_HORIZON_DAYS = 30;
/** `rounding: 'none'` has no natural lattice; a cent grid over a wide window is
 *  huge, so we search ~this many evenly spaced cent steps instead. */
export const NONE_GRID_POINTS = 200;

/** Schema bounds on any elasticity we report (price_recommendation.schema.json). */
const ELASTICITY_MIN = -12;
const ELASTICITY_MAX = 2;

export type BindingConstraint = 'margin_floor' | 'max_change' | 'inventory' | 'lattice_edge' | 'none';

export type SkipReason =
  /* exclusionReasonFor — never repriced at all */
  | 'gift_card'
  | 'subscription'
  | 'not_active'
  | 'zero_price'
  /* optimizer-specific */
  | 'missing_cogs'
  | 'no_usable_fit'
  | 'positive_elasticity'
  | 'no_demand'
  | 'no_candidates'
  | 'current_price_optimal';

export interface SkippedVariant {
  variant_gid: string;
  reason: SkipReason;
}

/** One row, field-for-field the shape of contracts/price_recommendation.schema.json. */
export interface PriceRecommendationRow {
  contract_version: typeof CONTRACT_VERSION;
  shop_domain: string;
  variant_gid: string;
  current_price_cents: Cents;
  recommended_price_cents: Cents;
  robust_price_cents: Cents;
  rounding: Rounding;
  elasticity: number;
  elasticity_low: number | null;
  elasticity_high: number | null;
  fit_model_version: string | null;
  confidence: Confidence;
  expected: {
    nominal_profit_delta_cents_per_day: Cents;
    robust_profit_delta_cents_per_day: Cents;
    nominal_revenue_delta_cents_per_day: Cents;
    robust_revenue_delta_cents_per_day: Cents;
  };
  constraints: {
    margin_floor_pct: number | null;
    max_change_pct: number | null;
    inventory_cap_applied: boolean;
    binding: BindingConstraint[];
  };
  candidates_evaluated: number;
  baseline_units_per_day: number;
  rationale: string;
  model_version: string;
  model_run_id: string | null;
  computed_at: string;
}

export interface OptimizeConstraints {
  /** Minimum gross margin over cogs, in percent. null = no floor. */
  marginFloorPct?: number | null;
  /** Cap on |price change| from current, in percent. */
  maxChangePct?: number;
  /** Cap a cut's projected demand by what stock can serve over 30 days. */
  inventoryAware?: boolean;
}

export interface OptimizeInput {
  shop: { shop_domain: string; currency: string; timezone: string };
  products: Product[];
  /** Daily aggregates for those variants. Missing days are genuine zero-sales days. */
  orderDays: OrderDay[];
  /** Lane C's fits, keyed by variant gid. SKUs without a usable fit are skipped. */
  fits?: ReadonlyMap<string, ElasticityFitRow>;
  constraints?: OptimizeConstraints;
  rounding?: Rounding;
  now?: Date;
}

export interface OptimizeResult {
  recommendations: PriceRecommendationRow[];
  skipped: SkippedVariant[];
}

// ---------------------------------------------------------------------------
// candidate lattice
// ---------------------------------------------------------------------------

interface Window {
  lo: Cents;
  hi: Cents;
  /** Which lower bound won: the margin floor, the % cap, or the 1-cent storefront floor. */
  loSource: 'margin_floor' | 'max_change' | 'storefront_min';
}

function constrainedWindow(
  currentCents: Cents,
  cogsCents: Cents,
  marginFloorPct: number | null,
  maxChangePct: number,
): Window {
  // The epsilon guards float artifacts like 600 * 1.1 === 660.0000000000001,
  // which would otherwise push an exact integer bound one cent off.
  const pctLo = Math.ceil(currentCents * (1 - maxChangePct / 100) - 1e-9);
  const hi = Math.floor(currentCents * (1 + maxChangePct / 100) + 1e-9);
  const floorLo =
    marginFloorPct === null
      ? null
      : Math.ceil((cogsCents * (100 + marginFloorPct)) / 100 - 1e-9);

  let lo: Cents = MIN_STOREFRONT_PRICE_CENTS;
  let loSource: Window['loSource'] = 'storefront_min';
  if (pctLo > lo) {
    lo = pctLo;
    loSource = 'max_change';
  }
  if (floorLo !== null && floorLo > lo) {
    lo = floorLo;
    loSource = 'margin_floor';
  }
  return { lo, hi, loSource };
}

/**
 * Every candidate is on the requested rounding lattice inside [lo, hi].
 *
 * For the ending lattices there is exactly one candidate per whole-dollar
 * block; we enumerate them arithmetically and keep only points that
 * `applyRounding` maps to themselves, so the lattice can never drift from
 * lib/money.ts. For `'none'` a cent-granularity grid over a wide window is too
 * large, so we search ~NONE_GRID_POINTS evenly spaced cent steps (plus the
 * current price when it falls inside the window, so "no change" is always a
 * comparable candidate).
 */
export function enumerateCandidates(
  currentCents: Cents,
  window: Window,
  rounding: Rounding,
): Cents[] {
  const { lo, hi } = window;
  if (hi < lo) return [];

  const out = new Set<Cents>();

  if (rounding === 'none') {
    const span = hi - lo;
    const steps = Math.min(span, NONE_GRID_POINTS - 1);
    if (steps <= 0) {
      out.add(lo);
    } else {
      for (let i = 0; i <= steps; i += 1) {
        out.add(lo + Math.round((span * i) / steps));
      }
    }
    if (currentCents >= lo && currentCents <= hi) out.add(currentCents);
  } else {
    const ending = rounding === 'end_99' ? 99 : rounding === 'end_95' ? 95 : 0;
    for (let dollars = Math.floor(lo / 100) - 1; dollars <= Math.ceil(hi / 100) + 1; dollars += 1) {
      const candidate = dollars * 100 + ending;
      if (candidate < MIN_STOREFRONT_PRICE_CENTS || candidate < lo || candidate > hi) continue;
      // Self-mapping check: a lattice point must be a fixed point of the
      // rounding rule, or a merchant-approved suggestion would move on write.
      if (applyRounding(candidate, rounding) !== candidate) continue;
      out.add(candidate);
    }
  }

  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// objective
// ---------------------------------------------------------------------------

interface Objective {
  currentCents: Cents;
  unitsPerDay: number;
  revenueRealizationRate: number;
  cogsCents: Cents;
  /** Max units/day the inventory can serve over the horizon; null = uncapped. */
  capUnitsPerDay: number | null;
}

interface Evaluation {
  profitDelta: number; // float cents/day; rounded only at the reporting edge
  revenueDelta: number;
  capApplied: boolean;
}

/**
 * Expected daily profit/revenue delta at `priceCents` under elasticity `e` —
 * the same demand model as `outcomeAtElasticities` in forecast.ts:
 * `units1 = units0 * (P1/P0)^e`, with money flowing at the realization rate
 * (list price × the observed net/gross ratio) and COGS paid per unit.
 *
 * The inventory cap constrains both futures. Comparing a capped proposal with
 * an uncapped baseline would manufacture a loss even for "keep today's price".
 */
function evaluateAt(objective: Objective, priceCents: Cents, elasticity: number): Evaluation {
  const { currentCents, unitsPerDay, revenueRealizationRate: r, cogsCents, capUnitsPerDay } = objective;
  let units1 = unitsPerDay * Math.pow(priceCents / currentCents, elasticity);
  let capApplied = false;
  if (capUnitsPerDay !== null && units1 > capUnitsPerDay) {
    units1 = capUnitsPerDay;
    capApplied = true;
  }
  // Inventory constrains both futures. Comparing a capped proposal with an
  // uncapped baseline manufactures a loss even for "keep today's price" and
  // can make the least-bad lattice point look like a recommendation.
  const baselineUnits = capUnitsPerDay === null ? unitsPerDay : Math.min(unitsPerDay, capUnitsPerDay);
  const revenueDelta = priceCents * r * units1 - currentCents * r * baselineUnits;
  const profitDelta =
    (priceCents * r - cogsCents) * units1 - (currentCents * r - cogsCents) * baselineUnits;
  return { profitDelta, revenueDelta, capApplied };
}

/**
 * Worst-case (robust) evaluation over the fit's credible interval.
 *
 * Intuition for which bound bites: for a price INCREASE the danger is demand
 * falling harder than expected, i.e. the most-elastic bound (fit low, most
 * negative). For a CUT the danger is demand barely responding, i.e. the
 * least-elastic bound (fit high, closest to zero). Rather than encode that
 * case split, we evaluate both interval endpoints and take the minimum: for a
 * fixed price, `units1 = u0·x^e` is monotone in `e` (x = P1/P0), and the
 * profit delta is affine in `units1`, so the worst case over the whole
 * interval is always attained at an endpoint. Taking the min also stays
 * correct in the odd corner where the realized unit margin `P·r − c` is
 * negative and *fewer* units would actually be the good news — a direction
 * heuristic would pick the optimistic bound there.
 */
function evaluateRobust(objective: Objective, priceCents: Cents, eLow: number, eHigh: number): Evaluation {
  const atLow = evaluateAt(objective, priceCents, eLow);
  const atHigh = evaluateAt(objective, priceCents, eHigh);
  const worst = atLow.profitDelta <= atHigh.profitDelta ? atLow : atHigh;
  return {
    profitDelta: worst.profitDelta,
    // Report the revenue pessimistic bound per metric, mirroring how
    // forecast.ts normalizes each displayable metric's range independently.
    revenueDelta: Math.min(atLow.revenueDelta, atHigh.revenueDelta),
    capApplied: worst.capApplied,
  };
}

interface ScoredCandidate {
  price: Cents;
  nominal: Evaluation;
  robust: Evaluation;
}

/**
 * Deterministic argmax: strictly-better profit wins; on an exact tie the
 * candidate closer to the current price wins (a smaller move for the same
 * expected money is the more conservative suggestion), and a remaining tie
 * goes to the lower price. No randomness, no map-iteration-order dependence.
 */
function argmax(
  candidates: readonly ScoredCandidate[],
  score: (candidate: ScoredCandidate) => number,
  currentCents: Cents,
): ScoredCandidate {
  let best = candidates[0] as ScoredCandidate;
  for (const candidate of candidates) {
    const s = score(candidate);
    const bestScore = score(best);
    if (
      s > bestScore ||
      (s === bestScore &&
        (Math.abs(candidate.price - currentCents) < Math.abs(best.price - currentCents) ||
          (Math.abs(candidate.price - currentCents) === Math.abs(best.price - currentCents) &&
            candidate.price < best.price)))
    ) {
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// rationale (merchant-facing, no jargon — R25)
// ---------------------------------------------------------------------------

function buildRationale(
  currency: string,
  currentCents: Cents,
  recommendedCents: Cents,
  nominalProfitDelta: Cents,
  robustProfitDelta: Cents,
  binding: readonly BindingConstraint[],
  marginFloorPct: number | null,
  maxChangePct: number | null,
): string {
  const direction = recommendedCents > currentCents ? 'Raise' : 'Lower';
  const parts: string[] = [
    `${direction} the price from ${formatCents(currentCents, currency)} to ${formatCents(recommendedCents, currency)}.`,
  ];
  parts.push(
    nominalProfitDelta > 0
      ? `Based on how this product has sold at different prices, that should add about ${formatCents(nominalProfitDelta, currency)} in profit per day.`
      : `That is the best price available on this price ending within your limits, though it may cost about ${formatCents(-nominalProfitDelta, currency)} per day compared with today.`,
  );
  parts.push(
    robustProfitDelta >= 0
      ? `Even at the cautious end of the likely range it should still add about ${formatCents(robustProfitDelta, currency)} per day.`
      : `At the cautious end of the likely range it could cost about ${formatCents(-robustProfitDelta, currency)} per day, which is why suggestions are staged and never applied automatically.`,
  );
  for (const constraint of binding) {
    if (constraint === 'max_change' && maxChangePct !== null) {
      parts.push(`The suggestion stops at your ${formatPctPlain(maxChangePct)} change limit.`);
    } else if (constraint === 'margin_floor' && marginFloorPct !== null) {
      parts.push(`The suggestion stops at your minimum margin of ${formatPctPlain(marginFloorPct)} over cost.`);
    } else if (constraint === 'inventory') {
      parts.push('Available stock limits how many units the model can count as sellable over the next 30 days, and that limit is priced in.');
    } else if (constraint === 'lattice_edge') {
      parts.push('The suggestion sits at the edge of the prices considered.');
    }
  }
  // The contract caps rationale at 500 characters; the sentences above cannot
  // exceed it, but stay defensive rather than ship an invalid row.
  return parts.join(' ').slice(0, 500);
}

function formatPctPlain(pct: number): string {
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// the search
// ---------------------------------------------------------------------------

function clampElasticity(value: number): number {
  return Math.min(ELASTICITY_MAX, Math.max(ELASTICITY_MIN, value));
}

/**
 * Constrained per-SKU price suggestions on the rounding lattice.
 *
 * Golden sanity check (asserted in tests/optimizer.test.ts): for constant
 * elasticity e < -1 the continuous profit maximizer of
 * `(P − c) · u0 · (P/P0)^e` is `P* = c · e / (1 + e)`. With e = −2.0 that is
 * `P* = 2c`; when COGS is 50% of the current price, P* IS the current price
 * (already optimal), and when COGS is 60%, P* is a 20% increase — the lattice
 * argmax must land next to those points.
 */
export function optimizePrices(input: OptimizeInput): OptimizeResult {
  const now = input.now ?? new Date();
  const asOf = today(input.shop.timezone, now);
  const computedAt = nowIso(now);
  const rounding: Rounding = input.rounding ?? 'end_99';
  const marginFloorPct = input.constraints?.marginFloorPct === undefined
    ? DEFAULT_MARGIN_FLOOR_PCT
    : input.constraints.marginFloorPct;
  const maxChangePct = input.constraints?.maxChangePct ?? DEFAULT_MAX_CHANGE_PCT;
  const inventoryAware = input.constraints?.inventoryAware ?? true;

  const recommendations: PriceRecommendationRow[] = [];
  const skipped: SkippedVariant[] = [];

  for (const product of input.products) {
    const exclusion = exclusionReasonFor(product);
    if (exclusion !== null) {
      skipped.push({ variant_gid: product.variant_gid, reason: exclusion });
      continue;
    }

    // No profit objective without a cost — we never guess COGS (R3).
    if (product.cogs_cents === null) {
      skipped.push({ variant_gid: product.variant_gid, reason: 'missing_cogs' });
      continue;
    }

    // Same usable-fit rule as buildForecast: a missing fit, a stale (demoted)
    // fit, or an assumption-tier fit is Lane C telling us not to lean on it.
    const fit = input.fits?.get(product.variant_gid) ?? null;
    if (fit !== null && Number.isFinite(fit.elasticity) && fit.elasticity >= 0) {
      // Match the Python optimizer: a wrong-sign fit is evidence of confounding,
      // not evidence that raising price creates demand. Skip instead of clamping
      // it into a recommendation.
      skipped.push({ variant_gid: product.variant_gid, reason: 'positive_elasticity' });
      continue;
    }
    const fitConfidence = effectiveFitConfidence(fit, now);
    const fitWasDemoted = fit !== null && fitConfidence !== fit.confidence;
    const usableFit =
      fit !== null && Number.isFinite(fit.elasticity) && !fitWasDemoted && fitConfidence !== 'assumption'
        ? fit
        : null;
    if (usableFit === null) {
      skipped.push({ variant_gid: product.variant_gid, reason: 'no_usable_fit' });
      continue;
    }

    const baseline = computeBaseline(input.orderDays, product.variant_gid, asOf);
    if (baseline.unitsPerDay <= 0) {
      skipped.push({ variant_gid: product.variant_gid, reason: 'no_demand' });
      continue;
    }

    const currentCents = product.price_cents;
    const effectiveMaxChangePct =
      fitConfidence === 'partial'
        ? Math.min(maxChangePct, PARTIAL_CONFIDENCE_MAX_CHANGE_PCT)
        : maxChangePct;
    const window = constrainedWindow(currentCents, product.cogs_cents, marginFloorPct, effectiveMaxChangePct);
    const candidatePrices = enumerateCandidates(currentCents, window, rounding);
    if (candidatePrices.length === 0) {
      // e.g. the margin floor sits above the max-change ceiling, or the window
      // between them contains no lattice point.
      skipped.push({ variant_gid: product.variant_gid, reason: 'no_candidates' });
      continue;
    }
    // Staying put is always the benchmark, even when today's price is not on
    // the requested lattice or is itself below the margin floor. The floor
    // constrains moves; it is not permission to recommend an expected loss
    // merely to repair a pre-existing low margin. Without this benchmark an
    // argmax over only losing, floor-compliant moves returns the least-bad loss
    // as a "suggestion".
    const evaluationPrices = [currentCents, ...candidatePrices.filter((price) => price !== currentCents)];

    const elasticity = clampElasticity(usableFit.elasticity);
    const eLow = clampElasticity(pickLow(usableFit));
    const eHigh = clampElasticity(pickHigh(usableFit));

    const capUnitsPerDay =
      inventoryAware &&
      product.inventory_quantity !== null &&
      Number.isFinite(product.inventory_quantity) &&
      product.inventory_quantity >= 0
        ? product.inventory_quantity / INVENTORY_HORIZON_DAYS
        : null;

    const objective: Objective = {
      currentCents,
      unitsPerDay: baseline.unitsPerDay,
      revenueRealizationRate: baseline.revenueRealizationRate,
      cogsCents: product.cogs_cents,
      capUnitsPerDay,
    };
    const uncapped: Objective = { ...objective, capUnitsPerDay: null };

    const scored: ScoredCandidate[] = evaluationPrices.map((price) => ({
      price,
      nominal: evaluateAt(objective, price, elasticity),
      robust: evaluateRobust(objective, price, eLow, eHigh),
    }));

    // Asymmetric selection (mirrors ml/priceflag_ml/optimize.py, gated by
    // run_c7): CUT candidates are scored at their worst-case (pessimistic
    // bound) profit, RAISE candidates at the point estimate. A wrong raise is
    // self-limiting — margin cushions every sale you keep — while a wrong cut
    // compounds, giving away margin on every unit without buying the volume.
    // So a cut is only suggested when even the cautious end says it wins.
    const selectionScore = (candidate: ScoredCandidate): number =>
      candidate.price < currentCents ? candidate.robust.profitDelta : candidate.nominal.profitDelta;

    const nominalBest = argmax(scored, selectionScore, currentCents);
    const robustBest = argmax(scored, (candidate) => candidate.robust.profitDelta, currentCents);

    if (nominalBest.price === currentCents) {
      // The lattice says the current price is already the profit maximizer.
      // "Change nothing" is not a suggestion the propose flow can prefill.
      skipped.push({ variant_gid: product.variant_gid, reason: 'current_price_optimal' });
      continue;
    }

    // Did the inventory cap move or bind the answer? Compare against the same
    // search without the cap, and check whether the cap is active at either
    // chosen price.
    const uncappedScored: ScoredCandidate[] = capUnitsPerDay === null
      ? scored
      : evaluationPrices.map((price) => ({
          price,
          nominal: evaluateAt(uncapped, price, elasticity),
          robust: evaluateRobust(uncapped, price, eLow, eHigh),
        }));
    const uncappedBest = argmax(uncappedScored, selectionScore, currentCents);
    const inventoryCapApplied =
      capUnitsPerDay !== null &&
      (nominalBest.nominal.capApplied ||
        robustBest.robust.capApplied ||
        uncappedBest.price !== nominalBest.price);

    // Which constraints is the nominal optimum pressed against?
    const minCandidate = candidatePrices[0] as Cents;
    const maxCandidate = candidatePrices[candidatePrices.length - 1] as Cents;
    const binding = new Set<BindingConstraint>();
    if (nominalBest.price === maxCandidate) {
      // The upper edge of the window is only ever the max-change cap.
      binding.add('max_change');
    }
    if (nominalBest.price === minCandidate) {
      if (window.loSource === 'margin_floor') binding.add('margin_floor');
      else if (window.loSource === 'max_change') binding.add('max_change');
      else binding.add('lattice_edge');
    }
    if (capUnitsPerDay !== null && nominalBest.nominal.capApplied) binding.add('inventory');
    const bindingList: BindingConstraint[] = binding.size === 0 ? ['none'] : [...binding].sort();

    const expected = {
      nominal_profit_delta_cents_per_day: roundCents(nominalBest.nominal.profitDelta),
      robust_profit_delta_cents_per_day: roundCents(nominalBest.robust.profitDelta),
      nominal_revenue_delta_cents_per_day: roundCents(nominalBest.nominal.revenueDelta),
      robust_revenue_delta_cents_per_day: roundCents(nominalBest.robust.revenueDelta),
    };

    // Sub-cent-per-day model improvements round to no merchant value and are
    // too fragile to justify a storefront change. Keep them out of the prefill
    // surface instead of presenting numerical noise as a recommendation.
    if (expected.nominal_profit_delta_cents_per_day <= 0) {
      skipped.push({ variant_gid: product.variant_gid, reason: 'current_price_optimal' });
      continue;
    }

    recommendations.push({
      contract_version: CONTRACT_VERSION,
      shop_domain: input.shop.shop_domain,
      variant_gid: product.variant_gid,
      current_price_cents: currentCents,
      recommended_price_cents: nominalBest.price,
      robust_price_cents: robustBest.price,
      rounding,
      elasticity,
      elasticity_low: eLow,
      elasticity_high: eHigh,
      fit_model_version: usableFit.model_version,
      confidence: fitConfidence,
      expected,
      constraints: {
        margin_floor_pct: marginFloorPct,
        max_change_pct: effectiveMaxChangePct,
        inventory_cap_applied: inventoryCapApplied,
        binding: bindingList,
      },
      candidates_evaluated: evaluationPrices.length,
      baseline_units_per_day: Number(baseline.unitsPerDay.toFixed(4)),
      rationale: buildRationale(
        input.shop.currency,
        currentCents,
        nominalBest.price,
        expected.nominal_profit_delta_cents_per_day,
        expected.robust_profit_delta_cents_per_day,
        bindingList,
        marginFloorPct,
        effectiveMaxChangePct,
      ),
      model_version: OPTIMIZER_MODEL_VERSION,
      model_run_id: null,
      computed_at: computedAt,
    });
  }

  return { recommendations, skipped };
}
