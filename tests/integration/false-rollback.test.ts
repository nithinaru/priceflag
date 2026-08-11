/**
 * Lane D — how often does auto-rollback fire on a HEALTHY rollout?
 *
 * PRD risk #2: "guardrails driven by miscalibrated bands would whipsaw pilots
 * with random rollbacks". Lane A hit this in practice and raised a demo
 * guardrail from 30% to 45%. Nobody quantified it. A false rollback costs a
 * merchant real money and, worse, costs them their trust in the automation.
 *
 * Two separate questions, and they have different answers:
 *
 *   1. Pure noise. Demand is unchanged; only Poisson variation. If a merchant
 *      opts into automatic rollback, how often would the guardrail fire?
 *   2. A correctly-forecast price rise. The merchant raises price, demand falls
 *      by exactly the predicted amount, and the no-change bracket is first
 *      conditioned on that approved forecast before outcomes are judged.
 */

import { bracketBand, combineBands, conditionBandOnDemandEffect } from '../../lib/engine/bands';
import { defaultGuardrails, BASELINE_WINDOW_DAYS } from '../../lib/contracts';
import type { GuardrailRule, Guardrails } from '../../lib/contracts';
import { evaluateGuardrails, type DailyObservation } from '../../lib/engine/guardrails';
import { addDays, type DayString } from '../../lib/dates';

import { assert, assertEqual, rng, section, test } from './_harness';

/** Poisson draw via inversion — fine at the rates a small store sees. */
function poisson(random: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= random();
  } while (p > limit);
  return k - 1;
}

const START: DayString = '2026-04-01' as DayString;

/**
 * One healthy rollout. `effect` is the true demand multiplier once the price
 * changes — 1.0 is pure noise, 0.88 is "orders fell 12%, exactly as forecast".
 */
function simulate(
  seed: number,
  skuCount: number,
  unitsPerSkuPerDay: number,
  rolloutDays: number,
  guardrails: Guardrails,
  effect: number,
): { rolledBack: boolean; day: number | null } {
  const random = rng(seed);

  // 60 days of pre-change history per SKU, which is what the evaluator loads.
  const history: { day: DayString; units: number }[][] = [];
  for (let sku = 0; sku < skuCount; sku += 1) {
    const rows: { day: DayString; units: number }[] = [];
    for (let d = -60; d <= -1; d += 1) {
      rows.push({ day: addDays(START, d), units: poisson(random, unitsPerSkuPerDay) });
    }
    history.push(rows);
  }

  const observations: DailyObservation[] = [];

  for (let d = 0; d < rolloutDays; d += 1) {
    const day = addDays(START, d);

    // Build the no-change baseline, then condition it on the demand effect the
    // merchant approved in the forecast.
    const perVariant = history.map((rows) => bracketBand(rows, day));
    const band = conditionBandOnDemandEffect(combineBands(perVariant), effect);

    // What actually sold. `effect` is the true, correctly-forecast change.
    let actual = 0;
    for (let sku = 0; sku < skuCount; sku += 1) actual += poisson(random, unitsPerSkuPerDay * effect);

    observations.push({
      day,
      stage_index: 0,
      actual_units: actual,
      actual_revenue_cents: actual * 2000,
      actual_profit_cents: actual * 800,
      expected_units: band.expected_units,
      expected_low: band.low,
      expected_high: band.high,
      expected_revenue_cents: Math.round(band.expected_units * 2000),
      expected_profit_cents: Math.round(band.expected_units * 800),
      breach_probability: null,
    });

    const assessment = evaluateGuardrails(guardrails, observations);
    if (assessment.action === 'rollback_all') return { rolledBack: true, day: d };
  }

  return { rolledBack: false, day: null };
}

function withThreshold(pct: number, consecutiveDays: number): Guardrails {
  const base = defaultGuardrails();
  const rule = base.rules[0] as GuardrailRule;
  return {
    ...base,
    auto_rollback: true,
    rules: [{ ...rule, threshold_pct: pct, consecutive_days: consecutiveDays }],
  } as Guardrails;
}

function ratePct(runs: number, hits: number): number {
  return Number(((hits / runs) * 100).toFixed(1));
}

export async function runFalseRollbackSuite(): Promise<void> {
  section('auto-rollback false-alarm rate (PRD risk #2)');

  const RUNS = 200;
  const ROLLOUT_DAYS = 12; // default plan: 25/50/100 with 3-4 day holds

  await test('the opt-in auto-rollback guardrail stays below its pure-noise budget', async () => {
    const defaults = { ...defaultGuardrails(), auto_rollback: true } as Guardrails;
    const rule = defaults.rules[0] as GuardrailRule;
    process.stdout.write(
      `    \x1b[2mopt-in auto-rollback: ${rule.threshold_pct}% below expected for ${rule.consecutive_days} day(s), ` +
        `action=${rule.action}, auto_rollback=${defaults.auto_rollback}\x1b[0m\n`,
    );

    const table: string[] = [];
    let worst = 0;
    for (const [skus, perSku] of [
      [1, 3],
      [3, 3],
      [6, 3],
      [12, 2],
      [26, 2],
      [50, 1],
    ] as [number, number][]) {
      let hits = 0;
      for (let run = 0; run < RUNS; run += 1) {
        if (simulate(0xfa15e + run * 7919 + skus, skus, perSku, ROLLOUT_DAYS, defaults, 1.0).rolledBack) hits += 1;
      }
      const rate = ratePct(RUNS, hits);
      worst = Math.max(worst, rate);
      table.push(`${String(skus).padStart(3)} SKUs @ ${perSku}/day → ${String(rate).padStart(5)}%`);
    }
    for (const line of table) process.stdout.write(`    \x1b[2m${line}\x1b[0m\n`);

    assert(
      worst <= 5,
      `a HEALTHY rollout (demand unchanged, pure Poisson noise) auto-rolls back in up to ${worst}% of runs ` +
        `with automatic rollback explicitly enabled. Every one of those is a merchant whose prices were reverted for ` +
        `nothing. Budget for a 12-day rollout should be well under 5%.`,
    );
  });

  await test('a correctly-forecast price rise is scored against its conditioned band', async () => {
    // The merchant raises price. The forecast predicts orders fall 12%. Orders
    // fall exactly 12% — the forecast was right and the rollout is a success.
    // The bracket starts as a no-change baseline and is conditioned on the
    // predicted 12% before actual demand is judged.
    const defaults = { ...defaultGuardrails(), auto_rollback: true } as Guardrails;
    const rule = defaults.rules[0] as GuardrailRule;
    const threshold = rule.threshold_pct ?? 30;

    const rows: string[] = [];
    let firstBadDrop: number | null = null;

    for (const dropPct of [5, 10, 15, 20, 25, 30]) {
      let hits = 0;
      for (let run = 0; run < RUNS; run += 1) {
        if (simulate(0xd0b + run * 7919 + dropPct, 6, 3, ROLLOUT_DAYS, defaults, 1 - dropPct / 100).rolledBack) {
          hits += 1;
        }
      }
      const rate = ratePct(RUNS, hits);
      rows.push(`predicted & realised drop ${String(dropPct).padStart(2)}% → auto-rollback in ${String(rate).padStart(5)}% of runs`);
      if (rate > 50 && firstBadDrop === null) firstBadDrop = dropPct;
    }
    for (const line of rows) process.stdout.write(`    \x1b[2m${line}\x1b[0m\n`);

    assert(
      firstBadDrop === null,
      `A price rise whose demand effect was predicted EXACTLY still auto-rolls back once the predicted drop ` +
        `approaches the guardrail threshold (first majority-failure at a ${firstBadDrop}% drop, threshold ${threshold}%). ` +
        `The conditioned band must preserve the rollback budget: a change ` +
        `forecast to cost ${firstBadDrop}% of orders cannot be run under a ${threshold}% guardrail even when the ` +
        `forecast is perfect. The guardrail sentence promises "below expected", and the merchant reads "expected" ` +
        `as "expected given this change".`,
    );
  });

  await test('the bracket band remains active after the rollout outlives its history window', async () => {
    // The evaluator loads history [start-60, start-1]. The fallback must remain
    // anchored to that pre-change history after day 28 rather than sliding past
    // it and silently disabling monitoring.
    const history: { day: DayString; units: number }[] = [];
    for (let d = -60; d <= -1; d += 1) history.push({ day: addDays(START, d), units: 10 });

    const dayBefore = addDays(START, BASELINE_WINDOW_DAYS - 1);
    const dayAfter = addDays(START, BASELINE_WINDOW_DAYS);

    const before = bracketBand(history, dayBefore);
    const after = bracketBand(history, dayAfter);

    assert(before.expected_units > 0, `day ${BASELINE_WINDOW_DAYS - 1} still has a band (${before.expected_units})`);
    assert(after.n_obs > 0, `day ${BASELINE_WINDOW_DAYS}: the band remains anchored to loaded history`);

    // Now prove the safety consequence rather than just the arithmetic.
    const observations: DailyObservation[] = [];
    for (let i = 0; i < 3; i += 1) {
      const day = addDays(START, BASELINE_WINDOW_DAYS + i);
      const band = bracketBand(history, day);
      observations.push({
        day,
        stage_index: 0,
        actual_units: 0, // a total collapse: every product stopped selling
        actual_revenue_cents: 0,
        actual_profit_cents: 0,
        expected_units: band.expected_units,
        expected_low: band.low,
        expected_high: band.high,
        expected_revenue_cents: 0,
        expected_profit_cents: 0,
        breach_probability: null,
      });
    }
    const assessment = evaluateGuardrails(
      { ...defaultGuardrails(), auto_rollback: true } as Guardrails,
      observations,
    );

    assertEqual(
      assessment.action,
      'rollback_all',
      `The bracket band must remain anchored to the history the evaluator loaded, so a TOTAL collapse ` +
        `to zero units for three days straight still fires after ${BASELINE_WINDOW_DAYS} days (a paused-and-resumed ` +
        `rollout, a long canary, or any plan with long holds).`,
    );
  });
}
