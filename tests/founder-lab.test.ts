import assert from 'node:assert/strict';

import {
  DEFAULT_FOUNDER_LAB_INPUT,
  FounderLabInputError,
  parseFounderLabInput,
  runFounderLab,
} from '../lib/demo/founder-lab';

const NOW = new Date('2026-08-11T18:00:00.000Z');

let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (cause) {
    process.stderr.write(`  \x1b[31m✗\x1b[0m ${name}\n`);
    throw cause;
  }
}

process.stdout.write('\x1b[1mFounder Lab\x1b[0m\n');

test('runs the production forecast engine and SKU cohort planner', () => {
  const result = runFounderLab({ ...DEFAULT_FOUNDER_LAB_INPUT }, NOW);
  assert.equal(result.forecast.contract_version, '1.0.0');
  assert.equal(result.forecast.products.length, 8);
  assert.equal(result.forecast.products[0]?.current_price_cents, 4800);
  assert.equal(result.forecast.products[0]?.target_price_cents, 5199);
  assert.equal(result.forecast.fitted?.elasticity, -1.2);
  assert.deepEqual(
    result.rollout_plan.map((stage) => stage.skus_live),
    [2, 4, 8],
  );
  assert.deepEqual(
    result.rollout_plan.map((stage) => stage.hold_days),
    [3, 3, 4],
  );
});

test('uses the real one-SKU time canary instead of pretending to split traffic', () => {
  const result = runFounderLab({ ...DEFAULT_FOUNDER_LAB_INPUT, sku_count: 1 }, NOW);
  assert.deepEqual(
    result.rollout_plan.map((stage) => [stage.fraction, stage.skus_live]),
    [
      [1, 1],
      [1, 1],
    ],
  );
});

test('surfaces a below-cost warning before any write path exists', () => {
  const result = runFounderLab(
    {
      ...DEFAULT_FOUNDER_LAB_INPUT,
      current_price_cents: 6400,
      cogs_cents: 4600,
      price_change_pct: -35,
    },
    NOW,
  );
  assert(result.forecast.warnings.some((warning) => warning.code === 'price_below_cost'));
  assert((result.forecast.fitted?.expected.profit_delta_cents ?? 0) < 0);
});

test('keeps profit unknown when cost is intentionally blank', () => {
  const result = runFounderLab({ ...DEFAULT_FOUNDER_LAB_INPUT, cogs_cents: null }, NOW);
  assert.equal(result.forecast.baseline.profit_cents_per_day, null);
  assert.equal(result.forecast.fitted?.expected.profit_delta_cents, null);
  assert(result.forecast.warnings.some((warning) => warning.code === 'missing_cogs'));
});

test('rejects unsafe or nonsensical lab inputs', () => {
  assert.throws(
    () => parseFounderLabInput({ ...DEFAULT_FOUNDER_LAB_INPUT, price_change_pct: 0, sku_count: 0 }),
    (cause: unknown) => cause instanceof FounderLabInputError && cause.issues.length >= 2,
  );
});

process.stdout.write(`\n\x1b[32m${passed} passed\x1b[0m\n`);
