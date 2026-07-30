/**
 * Guardrail evaluation — the safety system.
 *
 * The failure mode that matters here is not "missed a real drop", it is
 * "rolled a healthy rollout back because a small store had a quiet Tuesday".
 * A merchant who gets whipsawed once stops trusting the automation, and then the
 * product is worse than no product. Three mechanisms keep that from happening:
 *
 *   1. **Consecutive days.** One bad day is never enough by default.
 *   2. **A low-volume floor.** Below a few expected units a day, a zero is
 *      ordinary Poisson noise and carries no information. Those days cannot
 *      register a breach on their own.
 *   3. **Breach probability when Lane C provides it.** A calibrated
 *      P(true effect is worse than the threshold) beats a raw threshold crossing
 *      on noisy data, so it takes precedence when present (R29).
 *
 * Profit rules are skipped — loudly, never silently passed — when COGS is
 * missing, because an unknown profit is not a satisfied guardrail.
 */

import { DEFAULT_MIN_EXPECTED_UNITS } from '../contracts';
import type { GuardrailRule, Guardrails } from '../contracts';
import type { DayString } from '../dates';
import { formatCents, type Cents } from '../money';

/** Confidence at which a calibrated breach probability fires on its own. */
export const BREACH_PROBABILITY_THRESHOLD = 0.8;

export interface DailyObservation {
  day: DayString;
  stage_index: number;
  actual_units: number;
  actual_revenue_cents: Cents;
  /** null = unknown because some variant has no COGS. Not zero. */
  actual_profit_cents: Cents | null;
  expected_units: number;
  expected_low: number;
  expected_high: number;
  expected_revenue_cents: Cents;
  expected_profit_cents: Cents | null;
  /** Lane C (C5). When present and calibrated, preferred over the raw threshold. */
  breach_probability?: number | null;
}

export interface SkippedRule {
  rule_id: string;
  /** Plain language, surfaced in the event log so a skip is never invisible. */
  why: string;
}

export interface GuardrailAssessment {
  /** Did today's data satisfy some rule's condition? */
  breach: boolean;
  /** Consecutive trailing days the firing rule's condition has held, including today. */
  streak: number;
  rule_id: string | null;
  reason: string | null;
  /** Set only when the streak has reached the rule's `consecutive_days`. */
  action: 'rollback_all' | 'pause' | null;
  /** true when today's low volume meant the day could not count. */
  floored: boolean;
  skipped: SkippedRule[];
}

interface MetricReading {
  actual: number;
  expected: number;
  /** null when the metric is unknowable today. */
  known: boolean;
  format: (value: number) => string;
}

function readMetric(rule: GuardrailRule, observation: DailyObservation, currency: string): MetricReading {
  switch (rule.metric) {
    case 'units':
      return {
        actual: observation.actual_units,
        expected: observation.expected_units,
        known: true,
        format: (value) => `${value.toFixed(value < 10 ? 1 : 0)} units`,
      };
    case 'revenue':
      return {
        actual: observation.actual_revenue_cents,
        expected: observation.expected_revenue_cents,
        known: true,
        format: (value) => formatCents(Math.round(value), currency),
      };
    case 'profit':
      return {
        actual: observation.actual_profit_cents ?? 0,
        expected: observation.expected_profit_cents ?? 0,
        known: observation.actual_profit_cents !== null && observation.expected_profit_cents !== null,
        format: (value) => formatCents(Math.round(value), currency),
      };
    default:
      // Unknown metric from a newer contract version: cannot evaluate, so say so
      // rather than guessing.
      return { actual: 0, expected: 0, known: false, format: String };
  }
}

/** Would this rule's condition hold on this single day? */
export function ruleConditionHolds(
  rule: GuardrailRule,
  observation: DailyObservation,
  currency = 'USD',
): { holds: boolean; floored: boolean; known: boolean; reason: string } {
  const reading = readMetric(rule, observation, currency);
  if (!reading.known) {
    return { holds: false, floored: false, known: false, reason: '' };
  }

  // A calibrated probability, when we have one, is strictly better evidence than
  // a threshold crossing — it already accounts for how noisy this SKU is.
  const probability = observation.breach_probability;
  if (probability !== null && probability !== undefined) {
    const holds = probability >= BREACH_PROBABILITY_THRESHOLD;
    return {
      holds,
      floored: false,
      known: true,
      reason: holds
        ? `On ${observation.day}, we were ${(probability * 100).toFixed(0)}% sure the drop was real, not noise.`
        : '',
    };
  }

  const floor = rule.min_expected_units ?? DEFAULT_MIN_EXPECTED_UNITS;
  if (rule.metric === 'units' && observation.expected_units < floor) {
    // Too quiet for a single day to mean anything.
    return { holds: false, floored: true, known: true, reason: '' };
  }

  if (rule.comparison === 'below_absolute') {
    const floorValue = rule.absolute_floor ?? 0;
    const holds = reading.actual < floorValue;
    return {
      holds,
      floored: false,
      known: true,
      reason: holds
        ? `On ${observation.day}, ${reading.format(reading.actual)} came in below your floor of ${reading.format(floorValue)}.`
        : '',
    };
  }

  const thresholdPct = rule.threshold_pct ?? 0;
  const limit = reading.expected * (1 - thresholdPct / 100);
  const holds = reading.expected > 0 && reading.actual < limit;
  const shortfallPct = reading.expected > 0 ? ((reading.expected - reading.actual) / reading.expected) * 100 : 0;

  return {
    holds,
    floored: false,
    known: true,
    reason: holds
      ? `On ${observation.day}, ${reading.format(reading.actual)} came in ${shortfallPct.toFixed(0)}% below the ${reading.format(reading.expected)} we expected (your limit is ${thresholdPct.toFixed(0)}%).`
      : '',
  };
}

/**
 * Evaluate every rule against the trailing history.
 *
 * `history` is ascending and its last element is the day being evaluated. The
 * streak is counted backwards from that day: a gap in the data breaks the streak,
 * because "two days in a row" has to mean two actual days.
 */
export function evaluateGuardrails(
  guardrails: Guardrails,
  history: readonly DailyObservation[],
  currency = 'USD',
): GuardrailAssessment {
  const skipped: SkippedRule[] = [];
  const empty: GuardrailAssessment = {
    breach: false,
    streak: 0,
    rule_id: null,
    reason: null,
    action: null,
    floored: false,
    skipped,
  };

  if (history.length === 0 || guardrails.rules.length === 0) return empty;
  const todayObservation = history[history.length - 1] as DailyObservation;

  let best: GuardrailAssessment | null = null;
  let anyFloored = false;

  for (const rule of guardrails.rules) {
    const todayResult = ruleConditionHolds(rule, todayObservation, currency);
    if (!todayResult.known) {
      skipped.push({
        rule_id: rule.id,
        why:
          rule.metric === 'profit'
            ? 'Skipped the profit guardrail: some of these products have no cost saved, so profit is unknown.'
            : `Skipped guardrail ${rule.id}: this version of Priceflag cannot evaluate it.`,
      });
      continue;
    }
    if (todayResult.floored) anyFloored = true;
    if (!todayResult.holds) continue;

    // Count backwards while the condition keeps holding on consecutive days.
    let streak = 1;
    for (let i = history.length - 2; i >= 0; i -= 1) {
      const previous = history[i] as DailyObservation;
      const next = history[i + 1] as DailyObservation;
      const contiguous = daysApart(previous.day, next.day) === 1;
      if (!contiguous) break;
      const result = ruleConditionHolds(rule, previous, currency);
      if (!result.known || !result.holds) break;
      streak += 1;
    }

    const fires = streak >= rule.consecutive_days;
    const candidate: GuardrailAssessment = {
      breach: true,
      streak,
      rule_id: rule.id,
      reason: todayResult.reason,
      // auto_rollback=false downgrades a rollback to a pause: alert, do not act.
      action: fires ? (guardrails.auto_rollback ? rule.action : 'pause') : null,
      floored: false,
      skipped,
    };

    // Prefer a rule that actually fires, then the longer streak. A rollback
    // outranks a pause when both fire.
    if (best === null || rank(candidate) > rank(best)) best = candidate;
  }

  if (best === null) return { ...empty, floored: anyFloored };
  return best;
}

function rank(assessment: GuardrailAssessment): number {
  const actionWeight = assessment.action === 'rollback_all' ? 2 : assessment.action === 'pause' ? 1 : 0;
  return actionWeight * 1000 + assessment.streak;
}

function daysApart(from: DayString, to: DayString): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/**
 * Turn a rule back into the sentence it was built from. Only for rules that
 * arrive without one — a stored `sentence` is what the merchant agreed to and is
 * always preferred verbatim.
 */
export function describeRule(rule: GuardrailRule): string {
  if (rule.sentence) return rule.sentence;

  const metric = rule.metric === 'units' ? 'daily units' : `daily ${rule.metric}`;
  const scope = rule.scope === 'product' ? ' for any single product' : '';
  const days = rule.consecutive_days === 1 ? '' : ` for ${rule.consecutive_days} days in a row`;
  const consequence =
    rule.action === 'rollback_all' ? 'revert everything automatically' : 'pause the rollout and let you know';

  if (rule.comparison === 'below_absolute') {
    return `If ${metric}${scope} fall below ${rule.absolute_floor ?? 0}${days}, ${consequence}.`;
  }
  return `If ${metric}${scope} fall more than ${(rule.threshold_pct ?? 0).toFixed(0)}% below expected${days}, ${consequence}.`;
}
