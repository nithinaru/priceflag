/**
 * Lane D — guardrail semantics.
 *
 * The guardrail is the auto-rollback trigger, so its failure mode is not "missed
 * a drop" but "reverted a healthy rollout". These tests pin the *meaning* of the
 * inputs a merchant can set, and the precedence rules between them.
 */

import { DEFAULT_MIN_EXPECTED_UNITS, defaultGuardrails } from '../../lib/contracts';
import type { GuardrailRule, Guardrails } from '../../lib/contracts';
import { evaluateGuardrails, ruleConditionHolds, type DailyObservation } from '../../lib/engine/guardrails';
import type { DayString } from '../../lib/dates';

import { assert, assertEqual, section, test } from './_harness';

function observation(overrides: Partial<DailyObservation> = {}): DailyObservation {
  return {
    day: '2026-07-20' as DayString,
    stage_index: 0,
    actual_units: 100,
    actual_revenue_cents: 100_000,
    actual_profit_cents: 40_000,
    expected_units: 100,
    expected_low: 80,
    expected_high: 120,
    expected_revenue_cents: 100_000,
    expected_profit_cents: 40_000,
    breach_probability: null,
    ...overrides,
  };
}

function rule(overrides: Partial<GuardrailRule> = {}): GuardrailRule {
  return {
    id: 'r1',
    metric: 'units',
    comparison: 'below_expected_pct',
    threshold_pct: 30,
    consecutive_days: 2,
    scope: 'rollout',
    action: 'rollback_all',
    sentence: 'test rule',
    ...overrides,
  } as GuardrailRule;
}

function guardrails(rules: GuardrailRule[], autoRollback = true): Guardrails {
  return { ...defaultGuardrails(), auto_rollback: autoRollback, rules } as Guardrails;
}

/** `days` consecutive days, all with the same observation shape. */
function run(days: number, build: (index: number) => Partial<DailyObservation>): DailyObservation[] {
  const out: DailyObservation[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = `2026-07-${String(10 + i).padStart(2, '0')}` as DayString;
    out.push(observation({ day, ...build(i) }));
  }
  return out;
}

export async function runGuardrailSuite(): Promise<void> {
  section('guardrails — merchant-settable inputs');

  await test('the shipped default is not trigger-happy on an ordinary day', async () => {
    const defaults = defaultGuardrails();
    assert(defaults.rules.length > 0, 'there is a default rule');
    const only = defaults.rules[0] as GuardrailRule;
    assert(
      (only.consecutive_days ?? 0) >= 2,
      `the default fires after ${only.consecutive_days} day(s); one bad day must never be enough`,
    );
    const healthy = run(5, () => ({ actual_units: 100 }));
    assertEqual(evaluateGuardrails(defaults, healthy).action, null, 'a healthy run does not fire the default');
  });

  await test('consecutive_days = 0 fires on the very first bad day', async () => {
    // `fires = streak >= rule.consecutive_days` and streak is at least 1, so 0
    // behaves exactly like 1 rather than "never". Whether that is the intent, it
    // must at least be a value the UI cannot offer as "0 = disabled".
    const history = run(1, () => ({ actual_units: 10 }));
    const assessment = evaluateGuardrails(guardrails([rule({ consecutive_days: 0 })]), history);
    assertEqual(assessment.action, 'rollback_all', 'a 0-day rule fires immediately');
  });

  await test('threshold_pct = 0 reverts on any shortfall at all, however small', async () => {
    const history = run(2, () => ({ actual_units: 99.9, expected_units: 100 }));
    const assessment = evaluateGuardrails(guardrails([rule({ threshold_pct: 0, consecutive_days: 2 })]), history);
    assertEqual(
      assessment.action,
      'rollback_all',
      'a 0% threshold means "below expected by any amount" — a merchant who types 0 gets a hair trigger',
    );
  });

  await test('a 99% threshold effectively disables the rule', async () => {
    const history = run(3, () => ({ actual_units: 5, expected_units: 100 }));
    const assessment = evaluateGuardrails(guardrails([rule({ threshold_pct: 99, consecutive_days: 2 })]), history);
    assertEqual(assessment.action, null, 'a 95% collapse does not cross a 99% threshold');
  });

  await test('the low-volume floor stops a quiet day from registering a breach', async () => {
    const quiet = DEFAULT_MIN_EXPECTED_UNITS - 0.5;
    const history = run(3, () => ({ actual_units: 0, expected_units: quiet }));
    const assessment = evaluateGuardrails(guardrails([rule()]), history);
    assertEqual(assessment.action, null, 'a zero on a near-zero-expectation day carries no information');
    assertEqual(assessment.floored, true, 'and the day is reported as floored, not silently dropped');
  });

  await test('a gap in the data breaks the streak — "2 days in a row" means 2 actual days', async () => {
    const history: DailyObservation[] = [
      observation({ day: '2026-07-10' as DayString, actual_units: 10 }),
      // 11th missing
      observation({ day: '2026-07-12' as DayString, actual_units: 10 }),
    ];
    const assessment = evaluateGuardrails(guardrails([rule({ consecutive_days: 2 })]), history);
    assertEqual(assessment.streak, 1, 'the gap resets the streak');
    assertEqual(assessment.action, null, 'so the rule does not fire');
  });

  await test('auto_rollback = false downgrades a rollback to a pause', async () => {
    const history = run(3, () => ({ actual_units: 10 }));
    const assessment = evaluateGuardrails(guardrails([rule()], false), history);
    assertEqual(assessment.action, 'pause', 'alert-only mode never reverts prices on its own');
  });

  await test('an unknown profit skips the profit rule loudly instead of passing it', async () => {
    const history = run(3, () => ({ actual_units: 10, actual_profit_cents: null, expected_profit_cents: null }));
    const assessment = evaluateGuardrails(guardrails([rule({ id: 'p1', metric: 'profit' })]), history);
    assertEqual(assessment.action, null, 'an unknown profit is not a satisfied guardrail');
    assertEqual(assessment.skipped.length, 1, 'and the skip is recorded');
    assert(
      (assessment.skipped[0]?.why ?? '').includes('cost'),
      'the skip explains itself in merchant language',
    );
  });

  section('guardrails — breach probability precedence (R29)');

  await test('a calibrated breach probability takes precedence over the raw threshold', async () => {
    const history = run(2, () => ({ actual_units: 100, expected_units: 100, breach_probability: 0.95 }));
    const assessment = evaluateGuardrails(guardrails([rule({ consecutive_days: 2 })]), history);
    assertEqual(assessment.action, 'rollback_all', 'a confident breach probability fires even when units look fine');
  });

  await test('a breach probability bypasses the low-volume floor', async () => {
    // The floor exists because a zero on a near-zero-expectation day is ordinary
    // Poisson noise. The probability branch returns before the floor is consulted,
    // so a miscalibrated probability on a near-zero day can revert a rollout that
    // the floor was written to protect.
    const quiet = DEFAULT_MIN_EXPECTED_UNITS - 0.5;
    const history = run(2, () => ({ actual_units: 0, expected_units: quiet, breach_probability: 0.9 }));
    const assessment = evaluateGuardrails(guardrails([rule({ consecutive_days: 2 })]), history);
    assertEqual(
      assessment.action,
      'rollback_all',
      'documenting the precedence: the floor does NOT protect a day that carries a breach probability',
    );
  });

  await test('one breach probability fires EVERY rule, whatever metric each rule watches', async () => {
    // `breach_probability` is a property of the day, not of a metric. Lane C's C5
    // monitor computes it from UNITS. `ruleConditionHolds` consults it before it
    // ever looks at `rule.metric`, so a units-derived probability also fires a
    // revenue rule and a profit rule — including a profit rule on a selection
    // whose profit is unknown.
    const day = observation({ breach_probability: 0.95, actual_profit_cents: null, expected_profit_cents: null });

    const units = ruleConditionHolds(rule({ metric: 'units' }), day);
    const revenue = ruleConditionHolds(rule({ id: 'r2', metric: 'revenue' }), day);
    const profit = ruleConditionHolds(rule({ id: 'r3', metric: 'profit' }), day);

    assertEqual(units.holds, true, 'the units rule fires — correct, this is what the probability measures');
    assertEqual(
      revenue.holds,
      false,
      'a units-derived breach probability must not fire a REVENUE rule: the merchant set a limit on revenue, ' +
        'and revenue is exactly on expectation here',
    );
    void profit;
  });

  await test('a profit rule with unknown profit is not fired by a breach probability', async () => {
    // The `known` check runs first, so this should be a skip, not a breach.
    const day = observation({ breach_probability: 0.95, actual_profit_cents: null, expected_profit_cents: null });
    const profit = ruleConditionHolds(rule({ id: 'r3', metric: 'profit' }), day);
    assertEqual(profit.holds, false, 'unknown profit cannot breach');
    assertEqual(profit.known, false, 'and it is reported as unknowable, so the caller records a skip');
  });
}
