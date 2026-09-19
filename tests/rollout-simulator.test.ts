import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { generateDemoStore } from '../lib/demo/generator';
import { STORE_PRESETS, generatePortfolioStore, presetGidBase } from '../lib/demo/portfolio';
import {
  DEFAULT_SIMULATION_INPUT,
  SimulationInputError,
  parseSimulationInput,
  runRolloutSimulation,
} from '../lib/demo/simulate';
import { START_ATTENTION_REASON } from '../lib/engine/rollout';

let passed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (cause) {
    process.stderr.write(`  \x1b[31m✗\x1b[0m ${name}\n`);
    throw cause;
  }
}

/**
 * The demo store is the permanent sales demo and a golden fixture. Refactoring
 * the generator to accept other catalogs must not move a single row of it.
 */
const DEMO_STORE_SHA256 = 'cbce85a5cdd640cdf6a591c05f1ec36057d186e3e3748592b8ef7948af257e89';

async function main(): Promise<void> {
  process.stdout.write('\x1b[1mRollout simulator\x1b[0m\n');

  await test('the 14-product demo store is byte-identical after the generator refactor', () => {
    const store = generateDemoStore({ endDay: '2026-07-28', now: new Date('2026-07-29T12:00:00.000Z') });
    // The two truth fields added for the simulator are excluded: they are new
    // columns, not changed rows.
    const truth = store.truth.map(({ base_units_per_day: _b, initial_price_cents: _i, ...rest }) => rest);
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          products: store.products,
          orderDays: store.orderDays,
          priceHistory: store.priceHistory,
          truth,
          window: store.window,
        }),
      )
      .digest('hex');
    assert.equal(digest, DEMO_STORE_SHA256);
  });

  await test('every preset builds a deterministic store in its own gid range', () => {
    for (const preset of STORE_PRESETS) {
      const a = generatePortfolioStore(preset, { endDay: '2026-09-15', now: new Date('2026-09-16T13:15:00.000Z') });
      const b = generatePortfolioStore(preset, { endDay: '2026-09-15', now: new Date('2026-09-16T13:15:00.000Z') });
      assert.deepEqual(a.products, b.products, `${preset.id} is not deterministic`);
      assert(a.products.length >= preset.skuCount + 1, `${preset.id} lost its gift card`);
      const gids = new Set(a.products.map((product) => product.variant_gid));
      assert.equal(gids.size, a.products.length, `${preset.id} has duplicate variant gids`);
      const base = presetGidBase(preset);
      for (const gid of gids) {
        const id = Number(gid.split('/').at(-1));
        assert(id >= base && id < base + 1_000_000, `${preset.id} gid ${gid} is outside its range`);
      }
      assert.equal(a.truth.length, a.products.length, `${preset.id} truth does not cover every product`);
      assert(a.products.some((product) => product.is_gift_card), `${preset.id} has no gift card`);
      assert(a.products.some((product) => product.cogs_cents === null), `${preset.id} has no missing-cost SKU`);
    }
  });

  await test('a healthy rollout completes through the real evaluator and rolls back verified', async () => {
    const result = await runRolloutSimulation({ ...DEFAULT_SIMULATION_INPUT, seed: 7 });
    assert.equal(result.preset.id, 'morning-root');
    assert.equal(result.forecast.contract_version, '1.0.0');
    assert.equal(result.rollout.guardrails.auto_rollback, false, 'beta must never enable auto-rollback');
    assert(result.timeline.some((row) => row.decision === 'complete'), 'the rollout never completed');
    assert(result.timeline.filter((row) => row.decision === 'advance').length === result.input.stages.length - 1);
    assert.equal(result.readings.length, result.timeline.length, 'one reading per evaluated day');
    assert.equal(result.detection.false_pause, false);
    assert(result.realized !== null && result.realized.treated_sku_days > 0);
    assert.equal(result.accuracy.in_range, true);
    assert(result.rollback?.all_baselines_restored, 'rollback did not restore every baseline');
    assert.equal(result.rollout.status, 'rolled_back');
    assert.deepEqual(
      result.notifications.map((n) => n.kind),
      ['started', 'stage_advanced', 'stage_advanced', 'completed'],
    );
  });

  await test('a demand shock is caught by the guardrail: pause, alert, never an automatic revert', async () => {
    const result = await runRolloutSimulation({
      ...DEFAULT_SIMULATION_INPUT,
      preset: 'northline-apparel',
      seed: 11,
      shock: { factor: 0.5, from_day: 2 },
    });
    assert.equal(result.detection.shock_day, '2026-09-17');
    assert(result.detection.paused_day !== null, 'the shock was never caught');
    // Two bad days in a row have to land on non-floored days; on a 12-SKU
    // selection that is usually within a week and never beyond the hold plan.
    assert(result.detection.days_to_pause !== null && result.detection.days_to_pause <= 14, 'detection took too long on a mid-volume store');
    assert(result.notifications.some((n) => n.kind === 'breach'), 'no breach email was composed');
    assert(!result.notifications.some((n) => n.kind === 'auto_rollback'), 'the beta must not auto-revert');
    assert(result.events.some((event) => event.type === 'breach_detected'));
    // The founder lab restores at the end; the rollout itself only paused.
    assert(result.rollback?.all_baselines_restored);
  });

  await test('the hidden elasticity never reaches the forecast', async () => {
    const withoutFits = await runRolloutSimulation({ ...DEFAULT_SIMULATION_INPUT, fits: 'none', seed: 3 });
    assert.equal(withoutFits.forecast.confidence, 'assumption');
    assert(!JSON.stringify(withoutFits.forecast).includes('true_elasticity'));
    assert(!JSON.stringify(withoutFits.rollout).includes('true_elasticity'));
    const truths = new Set(withoutFits.selection.map((row) => row.true_elasticity));
    assert(!truths.has(withoutFits.forecast.fitted?.elasticity as number), 'the assumption-tier forecast used a hidden truth');
  });

  await test('a persistent Shopify throttle at confirmation pauses before anything is judged', async () => {
    const result = await runRolloutSimulation({
      ...DEFAULT_SIMULATION_INPUT,
      seed: 5,
      shopify_fault: { kind: 'throttle', onCall: 1, persistent: true },
    });
    assert.equal(result.timeline.length, 0, 'the evaluator must not judge a rollout that never went live');
    assert(result.events.some((event) => event.type === 'price_write_failed' || event.type === 'held'));
    assert(result.notifications.some((n) => n.kind === 'breach' && n.reason === START_ATTENTION_REASON));
    assert(result.rollback?.all_baselines_restored, 'nothing was written, so everything is at baseline');
  });

  await test('rejects nonsense inputs with every problem named', () => {
    assert.throws(
      () => parseSimulationInput({ preset: 'nope', price_change_pct: 0, horizon_days: 3 }),
      (cause: unknown) => cause instanceof SimulationInputError && cause.issues.length >= 3,
    );
  });

  process.stdout.write(`\n\x1b[32m${passed} passed\x1b[0m\n`);
}

void main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
