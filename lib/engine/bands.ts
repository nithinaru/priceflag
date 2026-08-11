/**
 * The fallback expected band.
 *
 * Lane C's fitted baselines (C3) are better than this and the evaluator prefers
 * them whenever they are fresh. This exists so that the safety system works on
 * day one, on a store with three weeks of history, and on the morning after a
 * model run failed — the fallback chain in `contracts/README.md` is what keeps
 * the three lanes from blocking each other.
 *
 * It is deliberately simple and explainable: a day-of-week-adjusted trailing
 * mean with an overdispersed Poisson interval. Two properties matter more than
 * accuracy:
 *
 *   - it never claims to be a model (`expected_source: 'bracket'`), and
 *   - it is generous on low-volume SKUs, where a zero-unit day is ordinary noise
 *     rather than evidence of a problem.
 */

import { BASELINE_WINDOW_DAYS, DEFAULT_MIN_EXPECTED_UNITS } from '../contracts';
import { addDays, isoDayOfWeek, type DayString } from '../dates';

/** z for an 80% central interval, matching Lane C's nominal band width. */
const Z_80 = 1.2816;

/** Weight of the day-of-week mean; shrinks toward the overall mean when thin. */
const DOW_PRIOR_STRENGTH = 2;

export interface DailyUnits {
  day: DayString;
  units: number;
}

export interface BandEstimate {
  expected_units: number;
  low: number;
  high: number;
  interval: number;
  /** true when the low edge was widened because volume is too low to judge. */
  floored: boolean;
  source: 'bracket';
  /** Days of history that went into it — surfaced so the UI can be honest. */
  n_obs: number;
}

export interface BracketBandOptions {
  windowDays?: number;
  interval?: number;
  minExpectedUnits?: number;
}

/**
 * Expected units for `targetDay` from history strictly before it.
 *
 * Only pre-change days should be passed in during a rollout: including days that
 * already carry the new price would let the band drift toward the very effect it
 * is meant to detect.
 */
export function bracketBand(
  history: readonly DailyUnits[],
  targetDay: DayString,
  options: BracketBandOptions = {},
): BandEstimate {
  const windowDays = options.windowDays ?? BASELINE_WINDOW_DAYS;
  const interval = options.interval ?? 0.8;
  const minExpected = options.minExpectedUnits ?? DEFAULT_MIN_EXPECTED_UNITS;

  const eligible = history.filter((row) => row.day < targetDay);
  const latestHistoricalDay = eligible.reduce<DayString | null>(
    (latest, row) => (latest === null || row.day > latest ? row.day : latest),
    null,
  );

  // Monitoring deliberately receives pre-change history only. Once targetDay
  // moves beyond that history, keep the window anchored to its latest day;
  // otherwise a long or paused rollout eventually slides past every observation
  // and silently disables its guardrails.
  const lastPossibleEnd = latestHistoricalDay === null ? targetDay : addDays(latestHistoricalDay, 1);
  const windowEnd = lastPossibleEnd < targetDay ? lastPossibleEnd : targetDay;
  const windowStart = addDays(windowEnd, -windowDays);
  const window = eligible.filter((row) => row.day >= windowStart && row.day < windowEnd);

  if (window.length === 0) {
    // No history at all: an honest band is an infinitely wide one, which in
    // practice means "this day cannot trigger anything".
    return {
      expected_units: 0,
      low: 0,
      high: 0,
      interval,
      floored: true,
      source: 'bracket',
      n_obs: 0,
    };
  }

  const overallMean = mean(window.map((row) => row.units));

  const targetDow = isoDayOfWeek(targetDay);
  const sameDow = window.filter((row) => isoDayOfWeek(row.day) === targetDow).map((row) => row.units);
  const dowMean = sameDow.length > 0 ? mean(sameDow) : overallMean;

  // Shrink the day-of-week mean toward the overall mean by how many same-weekday
  // observations we actually have. Four Mondays is a signal; one Monday is not.
  const weight = sameDow.length / (sameDow.length + DOW_PRIOR_STRENGTH);
  const expected = weight * dowMean + (1 - weight) * overallMean;

  // Retail daily units are overdispersed relative to Poisson (promos, weekends,
  // bulk orders), so take whichever variance is larger. Understating the spread
  // here would cause exactly the false rollbacks this band exists to prevent.
  const sampleVariance = variance(window.map((row) => row.units));
  const sd = Math.sqrt(Math.max(sampleVariance, expected));
  const z = zForInterval(interval);

  const rawLow = expected - z * sd;
  const high = expected + z * sd;
  const floored = expected < minExpected;

  return {
    expected_units: round4(expected),
    low: round4(floored ? 0 : Math.max(0, rawLow)),
    high: round4(Math.max(high, expected)),
    interval,
    floored,
    source: 'bracket',
    n_obs: window.length,
  };
}

/** Move a no-change interval to "expected given the approved price change". */
export function conditionBandOnDemandEffect(band: BandEstimate, demandMultiplier: number): BandEstimate {
  const multiplier = Number.isFinite(demandMultiplier) ? Math.max(0, demandMultiplier) : 1;
  return {
    ...band,
    expected_units: round4(band.expected_units * multiplier),
    low: round4(band.low * multiplier),
    high: round4(band.high * multiplier),
  };
}

/**
 * Aggregate a rollout-level band from per-variant bands. Means add; independent
 * variances add, so the aggregate is proportionally *tighter* than any single
 * SKU — which is why rollout-scope guardrails are the quieter default.
 */
export function combineBands(bands: readonly BandEstimate[], interval = 0.8): BandEstimate {
  if (bands.length === 0) {
    return { expected_units: 0, low: 0, high: 0, interval, floored: true, source: 'bracket', n_obs: 0 };
  }

  const z = zForInterval(interval);
  let expected = 0;
  let varianceSum = 0;
  let nObs = 0;
  let anyFloored = false;

  for (const band of bands) {
    expected += band.expected_units;
    // Recover each band's sd from its own half-width so a model-derived band and
    // a bracket band can be combined on the same footing.
    const halfWidth = Math.max(band.high - band.expected_units, band.expected_units - band.low);
    const sd = halfWidth / zForInterval(band.interval);
    varianceSum += sd * sd;
    nObs = Math.max(nObs, band.n_obs);
    if (band.floored) anyFloored = true;
  }

  const sd = Math.sqrt(varianceSum);
  // The aggregate is only "too quiet to judge" if it is itself low-volume, not
  // merely because one small SKU in it was.
  const floored = expected < DEFAULT_MIN_EXPECTED_UNITS && anyFloored;

  return {
    expected_units: round4(expected),
    low: round4(floored ? 0 : Math.max(0, expected - z * sd)),
    high: round4(expected + z * sd),
    interval,
    floored,
    source: 'bracket',
    n_obs: nObs,
  };
}

function zForInterval(interval: number): number {
  // Only the two widths the system actually uses; anything else falls back to 80%
  // rather than pretending to a precision we did not compute.
  if (Math.abs(interval - 0.95) < 1e-9) return 1.96;
  if (Math.abs(interval - 0.9) < 1e-9) return 1.6449;
  return Z_80;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
