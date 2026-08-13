/**
 * Focused tests for the evaluator's counterfactual band consumption:
 *
 *   npx tsx lib/evaluator/counterfactual-bands.test.ts
 *
 * C5 stamps identical cohort-level numbers onto every variant row of a
 * rollout. These tests pin the two safety properties of that contract:
 * rollout-scoped selection (another rollout's rows never qualify) and
 * no double counting (the cohort band is one row, never a sum).
 */

import assert from 'node:assert/strict';

import {
  counterfactualCohortBand,
  selectCounterfactualBandsForRollout,
  selectExpectedBandsForRollout,
} from './index';
import type { DayString } from '../dates';
import type { ExpectedBandRow, Rollout } from '../types';

const NOW = new Date('2026-07-20T06:00:00Z');
const ROLLOUT_ID = 'current-rollout';

function band(overrides: Partial<ExpectedBandRow> = {}): ExpectedBandRow {
  return {
    id: 'row-1',
    shop_id: 'shop-1',
    variant_gid: 'gid://shopify/ProductVariant/1',
    day: '2026-07-19' as DayString,
    expected_units: 40,
    low: 30,
    high: 50,
    interval_nominal: 0.8,
    band_kind: 'counterfactual',
    rollout_id: ROLLOUT_ID,
    breach_probability: 0.35,
    is_floored: false,
    model_version: 'counterfactual-cleanlevel-1.0',
    model_run_id: null,
    generated_at: '2026-07-20T02:00:00Z',
    ...overrides,
  };
}

function rollout(): Rollout {
  return {
    id: ROLLOUT_ID,
    forecast: {
      products: [
        {
          variant_gid: 'gid://shopify/ProductVariant/1',
          excluded: false,
          baseline_units_per_day: 30,
          current_price_cents: 1000,
          target_price_cents: 1000,
          demand_multiplier: 1,
        },
        {
          variant_gid: 'gid://shopify/ProductVariant/2',
          excluded: false,
          baseline_units_per_day: 10,
          current_price_cents: 1000,
          target_price_cents: 1000,
          demand_multiplier: 1,
        },
      ],
    },
  } as unknown as Rollout;
}

// --- selection: scope, freshness, dedupe ------------------------------------

{
  const rows = [
    band({ id: 'mine-old', generated_at: '2026-07-19T02:00:00Z', expected_units: 33 }),
    band({ id: 'mine-new' }),
    band({ id: 'other-rollout', rollout_id: 'prior-rollout' }),
    band({ id: 'unscoped', rollout_id: null }),
    band({ id: 'baseline', band_kind: 'baseline', rollout_id: null }),
    band({ id: 'stale', generated_at: '2026-07-10T02:00:00Z' }),
  ];

  const selected = selectCounterfactualBandsForRollout(rows, ROLLOUT_ID, NOW);
  assert.equal(selected.length, 1, 'one row per variant/day');
  assert.equal(selected[0]?.id, 'mine-new', 'newest scoped row wins');

  const baselines = selectExpectedBandsForRollout(rows, ROLLOUT_ID, NOW);
  assert.equal(baselines.length, 1, 'baseline selection is unchanged');
  assert.equal(baselines[0]?.id, 'baseline', 'counterfactual rows stay ineligible as baselines');
}

// --- cohort band: one row, never a sum --------------------------------------

{
  const rows = [
    band({ id: 'v1', variant_gid: 'gid://shopify/ProductVariant/1' }),
    band({ id: 'v2', variant_gid: 'gid://shopify/ProductVariant/2' }),
  ];
  const cohort = counterfactualCohortBand(
    rollout(),
    ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
    rows,
  );
  assert.ok(cohort !== null, 'full coverage yields a cohort band');
  assert.equal(cohort.band.expected_units, 40, 'cohort-stamped rows are not summed');
  assert.equal(cohort.band.low, 30, 'the row keeps its own width');
  assert.equal(cohort.band.high, 50, 'the row keeps its own width');
  assert.equal(cohort.breachProbability, 0.35, 'the calibrated probability flows through');
  assert.equal(cohort.modelVersion, 'counterfactual-cleanlevel-1.0');

  const shares = cohort.variantBands.map((item) => item.counterfactual.expected_units);
  assert.equal(shares.length, 2, 'one economics split per variant');
  assert.ok(Math.abs((shares[0] as number) - 30) < 1e-9, 'split follows the frozen baseline share');
  assert.ok(Math.abs((shares[1] as number) - 10) < 1e-9, 'split follows the frozen baseline share');
  assert.ok(
    Math.abs(shares.reduce((sum, units) => sum + units, 0) - cohort.band.expected_units) < 1e-9,
    'the split re-adds to the cohort exactly',
  );
}

// --- partial coverage refuses rather than guessing --------------------------

{
  const rows = [band({ id: 'v1', variant_gid: 'gid://shopify/ProductVariant/1' })];
  const cohort = counterfactualCohortBand(
    rollout(),
    ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2'],
    rows,
  );
  assert.equal(cohort, null, 'a partially-covered cohort is refused');

  assert.equal(
    counterfactualCohortBand(rollout(), [], []),
    null,
    'an empty cohort is refused',
  );
}

console.log('counterfactual-bands: all assertions passed');
