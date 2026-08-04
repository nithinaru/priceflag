/**
 * Turning a daily reading into a decision.
 *
 * Requested by Lane A (REQ-A-003): "Lane A would rather render a decision than
 * make one about whether a rollout is healthy." That is the right instinct, and
 * it is a safety argument as much as a UI one — if the UI computed health from
 * raw numbers it would eventually disagree with the evaluator that actually
 * decides whether to roll back, and the merchant would be looking at a different
 * verdict than the machine acted on.
 *
 * So the verdict is computed here, once, from the same band the evaluator used,
 * and served alongside every reading.
 */

import { formatCents, type Cents } from '../money';
import type { EvaluationDecision, RolloutReading } from '../types';

/** Where the day landed relative to the expected band. */
export type ReadingVerdict = 'within' | 'below' | 'above';

/**
 * A day is only `below` when it falls outside the honest interval — not merely
 * beneath the point estimate. Half of all healthy days are beneath the point
 * estimate; calling those "below" would make the UI look alarming on a rollout
 * that is behaving exactly as predicted.
 */
export function readingVerdict(actual: number, low: number, high: number): ReadingVerdict {
  if (actual < low) return 'below';
  if (actual > high) return 'above';
  return 'within';
}

export function verdictForReading(reading: Pick<RolloutReading, 'actual_units' | 'expected_low' | 'expected_high'>): ReadingVerdict {
  return readingVerdict(reading.actual_units, reading.expected_low, reading.expected_high);
}

/**
 * One merchant-facing sentence for a day (R25). `band_floored` matters here: a
 * floored band means volume was too low to judge, and saying "within expected"
 * would overclaim.
 */
export function readingSentence(
  reading: Pick<
    RolloutReading,
    'day' | 'actual_units' | 'expected_units' | 'expected_low' | 'expected_high' | 'band_floored' | 'band_stale'
  >,
): string {
  const verdict = verdictForReading(reading);
  const actual = formatUnits(reading.actual_units);
  const expected = formatUnits(reading.expected_units);

  if (reading.band_floored) {
    return `${actual} sold — too few orders a day on these products to read anything into it either way.`;
  }

  const caveat = reading.band_stale ? ' (our expectation is a little out of date, so the range is wider than usual)' : '';

  switch (verdict) {
    case 'below':
      return `${actual} sold against ${expected} expected — below the range we expected${caveat}.`;
    case 'above':
      return `${actual} sold against ${expected} expected — better than the range we expected${caveat}.`;
    default:
      return `${actual} sold against ${expected} expected — inside the range we expected${caveat}.`;
  }
}

export type RolloutHealth = 'healthy' | 'watching' | 'breaching' | 'too_early' | 'not_live';

/**
 * Rollout-level health for the "what is live right now?" glance (R16).
 *
 * `watching` is a deliberate middle state: a rollout with one bad day has not
 * tripped anything, but telling the merchant it is "healthy" would be a
 * half-truth they would be annoyed to discover later.
 */
export function rolloutHealth(
  status: string,
  readings: readonly Pick<RolloutReading, 'breach' | 'breach_streak' | 'band_floored' | 'actual_units' | 'expected_low' | 'expected_high'>[],
): RolloutHealth {
  if (status !== 'running' && status !== 'paused') return 'not_live';
  if (readings.length === 0) return 'too_early';

  const latest = readings[readings.length - 1] as (typeof readings)[number];
  if (latest.breach && latest.breach_streak >= 2) return 'breaching';
  if (latest.breach) return 'watching';
  if (latest.band_floored) return 'too_early';
  return verdictForReading(latest) === 'below' ? 'watching' : 'healthy';
}

/** One sentence for the whole rollout, for the overview page. */
export function healthSentence(health: RolloutHealth, decision: EvaluationDecision, streak = 0): string {
  switch (health) {
    case 'breaching':
      if (decision === 'rollback') {
        return 'Orders are below the range you set as acceptable. A rollback is being applied.';
      }
      if (decision === 'pause') {
        return 'Orders are below the range you set as acceptable. Priceflag paused the rollout for your decision; no prices were restored automatically.';
      }
      return streak >= 2
        ? 'Orders are below the range you set as acceptable for a second day. Priceflag will pause before any additional prices change.'
        : 'Orders are below the range you set as acceptable.';
    case 'watching':
      return 'Orders came in low yesterday. Nothing has changed yet — your guardrail needs more than one day before it acts.';
    case 'too_early':
      return 'Too early to tell. We need a full day of orders at the new price before there is anything to compare.';
    case 'not_live':
      return 'No prices are live from this rollout.';
    default:
      return decision === 'advance'
        ? 'Results held up, so the new price is going live on more of the selection.'
        : 'Orders are inside the range we expected.';
  }
}

/** Revenue/profit deltas for a completed set of readings, for the report. */
export function sumReadings(readings: readonly Pick<RolloutReading, 'actual_units' | 'actual_revenue_cents' | 'actual_profit_cents'>[]): {
  units: number;
  revenue_cents: Cents;
  /** null when any day's profit was unknown — an unknown does not sum to zero. */
  profit_cents: Cents | null;
} {
  let units = 0;
  let revenue = 0;
  let profit = 0;
  let profitKnown = true;

  for (const reading of readings) {
    units += reading.actual_units;
    revenue += reading.actual_revenue_cents;
    if (reading.actual_profit_cents === null) profitKnown = false;
    else profit += reading.actual_profit_cents;
  }

  return { units, revenue_cents: revenue, profit_cents: profitKnown ? profit : null };
}

function formatUnits(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${label} unit${rounded === 1 ? '' : 's'}`;
}

/** Re-exported for callers that already hold cents and want the money string. */
export { formatCents };
