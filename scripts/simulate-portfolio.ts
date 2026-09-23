/**
 * The investor numbers, reproducibly.
 *
 *   npx tsx scripts/simulate-portfolio.ts            # fits + full grid (needs uv, ~2 min)
 *   npx tsx scripts/simulate-portfolio.ts --no-fit   # reuse lib/demo/portfolio-fits.json
 *   npx tsx scripts/simulate-portfolio.ts --seeds 3  # fewer noise seeds per cell
 *
 * Two steps:
 *
 *   1. Run Lane C's real elasticity fitter (`priceflag_ml.elasticity.fit_store`)
 *      over each simulated store's OBSERVABLE columns — the same bridge as
 *      `seed-demo-fits.ts`, never the hidden truth — and commit the rows to
 *      `lib/demo/portfolio-fits.json` so the founder lab needs no Python.
 *   2. Drive `runRolloutSimulation` over every preset × scenario × noise seed and
 *      score the forecast, the guardrails, and the rollback against the truth.
 *
 * Writes `lib/demo/portfolio-eval.json` (aggregates the lab shows) and
 * `docs/SIMULATION_RESULTS.md` (the tables to talk from).
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { addDays } from '../lib/dates';
import { STORE_PRESETS, generatePortfolioStore, type StorePreset } from '../lib/demo/portfolio';
import {
  SIM_START_DAY,
  overridePortfolioFits,
  runRolloutSimulation,
  type SimulationInput,
  type SimulationResult,
} from '../lib/demo/simulate';

const ML_DIR = resolve(process.cwd(), 'ml');
const FITS_OUTPUT = resolve(process.cwd(), 'lib/demo/portfolio-fits.json');
const EVAL_OUTPUT = resolve(process.cwd(), 'lib/demo/portfolio-eval.json');
const DOC_OUTPUT = resolve(process.cwd(), 'docs/SIMULATION_RESULTS.md');

const BRIDGE = `
import json, sys
import pandas as pd
from priceflag_ml.elasticity import fit_store, fits_contract_rows

payload = json.load(sys.stdin)
frame = pd.DataFrame(payload["rows"])
fits = fit_store(frame, seed=0)
rows = fits_contract_rows(
    fits,
    shop_domain=payload["shop_domain"],
    fitted_at=payload["fitted_at"],
    window_start=payload["window_start"],
    window_end=payload["window_end"],
)
json.dump(rows, sys.stdout)
`;

interface Scenario {
  id: string;
  label: string;
  input: Omit<SimulationInput, 'preset' | 'seed'>;
  /** Healthy runs score the forecast; shock runs score detection. */
  kind: 'healthy' | 'shock';
}

const SCENARIOS: Scenario[] = [
  {
    id: 'raise_8',
    label: '+8% price increase, fitted model',
    kind: 'healthy',
    input: { price_change_pct: 8, horizon_days: 90, fits: 'fixture' },
  },
  {
    id: 'cut_10',
    label: '−10% price cut, fitted model',
    kind: 'healthy',
    input: { price_change_pct: -10, horizon_days: 90, fits: 'fixture' },
  },
  {
    id: 'raise_8_no_fit',
    label: '+8% increase, no store fit (assumption tier)',
    kind: 'healthy',
    input: { price_change_pct: 8, horizon_days: 90, fits: 'none' },
  },
  {
    id: 'shock_moderate',
    label: '+8%, shoppers react 40% worse than the curve from day 4',
    kind: 'shock',
    input: { price_change_pct: 8, horizon_days: 90, fits: 'fixture', shock: { factor: 0.6, from_day: 4 } },
  },
  {
    id: 'shock_severe',
    label: '+8%, demand halves on repriced SKUs from day 2',
    kind: 'shock',
    input: { price_change_pct: 8, horizon_days: 90, fits: 'fixture', shock: { factor: 0.5, from_day: 2 } },
  },
];

function parseArgs(argv: readonly string[]): { fit: boolean; seeds: number } {
  let fit = true;
  let seeds = 5;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-fit') fit = false;
    if (argv[i] === '--seeds' && argv[i + 1]) {
      seeds = Math.max(1, Number(argv[i + 1]));
      i += 1;
    }
  }
  return { fit, seeds };
}

function fitPreset(preset: StorePreset): Record<string, unknown>[] {
  const now = new Date(`${SIM_START_DAY}T13:15:00.000Z`);
  const store = generatePortfolioStore(preset, { endDay: addDays(SIM_START_DAY, -1), now });
  const rows = store.orderDays.map((row) => ({
    shop_id: preset.domain,
    sku: row.variant_gid,
    date: row.day,
    units: row.units,
    price_cents: row.list_price_cents,
    revenue_cents: row.net_revenue_cents,
    promo: row.on_promo,
    stockout: row.had_stockout,
  }));
  const payload = {
    rows,
    shop_domain: preset.domain,
    fitted_at: `${store.window.to}T12:00:00.000Z`,
    window_start: store.window.from,
    window_end: store.window.to,
  };
  process.stdout.write(`  ${preset.name.padEnd(26)} ${String(store.products.length).padStart(4)} SKUs, ${rows.length} product-days… `);
  const started = Date.now();
  const output = execFileSync('uv', ['run', '--quiet', 'python', '-c', BRIDGE], {
    cwd: ML_DIR,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const fits = JSON.parse(output) as Record<string, unknown>[];
  const tiers = new Map<string, number>();
  for (const fit of fits) tiers.set(String(fit.confidence), (tiers.get(String(fit.confidence)) ?? 0) + 1);
  process.stdout.write(`${fits.length} fits in ${((Date.now() - started) / 1000).toFixed(0)}s (${[...tiers].map(([t, n]) => `${t}=${n}`).join(', ')})\n`);
  return fits;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value: number | null, digits = 0): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function num(value: number | null, digits = 1, suffix = ''): string {
  return value === null ? '—' : `${value.toFixed(digits)}${suffix}`;
}

interface CellScore {
  preset: string;
  scenario: string;
  kind: Scenario['kind'];
  runs: number;
  forecast_confidence: Record<string, number>;
  in_range_rate: number | null;
  units_error_mae: number | null;
  units_error_median_abs: number | null;
  revenue_error_median_abs_pct: number | null;
  false_pause_rate: number | null;
  detection_rate: number | null;
  days_to_pause_median: number | null;
  completed_rate: number;
  rollback_restored_rate: number;
}

function scoreCell(preset: StorePreset, scenario: Scenario, results: readonly SimulationResult[]): CellScore {
  const confidence: Record<string, number> = {};
  for (const result of results) {
    confidence[result.forecast.confidence] = (confidence[result.forecast.confidence] ?? 0) + 1;
  }
  const scored = results.filter((result) => result.accuracy.in_range !== null);
  const errors = scored.map((result) => result.accuracy.units_error_points as number);
  const revenueErrors = scored
    .map((result) => result.accuracy.revenue_error_pct)
    .filter((value): value is number => value !== null)
    .map((value) => Math.abs(value));
  const shocks = results.filter((result) => result.detection.shock_day !== null);
  const detected = shocks.filter((result) => result.detection.paused_day !== null);
  return {
    preset: preset.id,
    scenario: scenario.id,
    kind: scenario.kind,
    runs: results.length,
    forecast_confidence: confidence,
    in_range_rate: scenario.kind === 'healthy' && scored.length > 0 ? scored.filter((r) => r.accuracy.in_range).length / scored.length : null,
    units_error_mae: scenario.kind === 'healthy' ? mean(errors.map((value) => Math.abs(value))) : null,
    units_error_median_abs: scenario.kind === 'healthy' ? median(errors.map((value) => Math.abs(value))) : null,
    revenue_error_median_abs_pct: scenario.kind === 'healthy' ? median(revenueErrors) : null,
    false_pause_rate: scenario.kind === 'healthy' ? results.filter((r) => r.detection.false_pause).length / results.length : null,
    detection_rate: scenario.kind === 'shock' && shocks.length > 0 ? detected.length / shocks.length : null,
    days_to_pause_median: scenario.kind === 'shock' ? median(detected.map((r) => r.detection.days_to_pause as number)) : null,
    completed_rate: results.filter((r) => r.timeline.some((row) => row.decision === 'complete')).length / results.length,
    rollback_restored_rate: results.filter((r) => r.rollback?.all_baselines_restored).length / results.length,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.fit) {
    process.stdout.write("Step 1 — Lane C's fitter over each store's observable rows\n");
    const fits: Record<string, Record<string, unknown>[]> = {};
    for (const preset of STORE_PRESETS) fits[preset.id] = fitPreset(preset);
    writeFileSync(FITS_OUTPUT, `${JSON.stringify(fits, null, 2)}\n`, 'utf8');
    overridePortfolioFits(fits);
    process.stdout.write(`  wrote ${FITS_OUTPUT}\n\n`);
  }

  process.stdout.write(`Step 2 — ${STORE_PRESETS.length} stores × ${SCENARIOS.length} scenarios × ${args.seeds} seeds\n`);
  const cells: CellScore[] = [];
  const stores: Record<string, SimulationResult['store'] & { elasticity: SimulationResult['elasticity']['store'] }> = {};
  const started = Date.now();

  for (const preset of STORE_PRESETS) {
    for (const scenario of SCENARIOS) {
      const results: SimulationResult[] = [];
      for (let seed = 1; seed <= args.seeds; seed += 1) {
        const result = await runRolloutSimulation({ ...scenario.input, preset: preset.id, seed: preset.seed * 100 + seed });
        results.push(result);
        if (scenario.id === 'raise_8' && seed === 1) {
          stores[preset.id] = { ...result.store, elasticity: result.elasticity.store };
        }
      }
      const cell = scoreCell(preset, scenario, results);
      cells.push(cell);
      process.stdout.write(
        `  ${preset.name.padEnd(26)} ${scenario.id.padEnd(16)} ` +
          (scenario.kind === 'healthy'
            ? `in-range ${pct(cell.in_range_rate)}  |err| median ${num(cell.units_error_median_abs, 1, ' pts')}  false-pause ${pct(cell.false_pause_rate)}`
            : `detected ${pct(cell.detection_rate)}  median day ${num(cell.days_to_pause_median, 0)}`) +
          `  rollback ${pct(cell.rollback_restored_rate)}\n`,
      );
    }
  }
  process.stdout.write(`  ${cells.reduce((sum, cell) => sum + cell.runs, 0)} runs in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  const healthy = cells.filter((cell) => cell.kind === 'healthy' && cell.scenario !== 'raise_8_no_fit');
  const noFit = cells.filter((cell) => cell.scenario === 'raise_8_no_fit');
  const shock = cells.filter((cell) => cell.kind === 'shock');
  const overall = {
    generated_at: new Date().toISOString(),
    sim_start_day: SIM_START_DAY,
    seeds_per_cell: args.seeds,
    runs: cells.reduce((sum, cell) => sum + cell.runs, 0),
    healthy_in_range_rate: mean(healthy.map((cell) => cell.in_range_rate).filter((v): v is number => v !== null)),
    healthy_units_error_median_abs: median(healthy.map((cell) => cell.units_error_median_abs).filter((v): v is number => v !== null)),
    no_fit_in_range_rate: mean(noFit.map((cell) => cell.in_range_rate).filter((v): v is number => v !== null)),
    no_fit_units_error_median_abs: median(noFit.map((cell) => cell.units_error_median_abs).filter((v): v is number => v !== null)),
    false_pause_rate: mean(healthy.map((cell) => cell.false_pause_rate).filter((v): v is number => v !== null)),
    shock_detection_rate: mean(shock.map((cell) => cell.detection_rate).filter((v): v is number => v !== null)),
    shock_days_to_pause_median: median(shock.map((cell) => cell.days_to_pause_median).filter((v): v is number => v !== null)),
    rollback_restored_rate: mean(cells.map((cell) => cell.rollback_restored_rate)),
    elasticity_within_0_3: mean(Object.values(stores).map((s) => s.elasticity.within_0_3).filter((v): v is number => v !== null)),
    elasticity_mae: mean(Object.values(stores).map((s) => s.elasticity.mae).filter((v): v is number => v !== null)),
    elasticity_ci80_coverage: mean(Object.values(stores).map((s) => s.elasticity.ci80_covers_truth).filter((v): v is number => v !== null)),
  };

  writeFileSync(EVAL_OUTPUT, `${JSON.stringify({ overall, stores, cells }, null, 2)}\n`, 'utf8');
  writeFileSync(DOC_OUTPUT, renderDoc(overall, stores, cells), 'utf8');
  process.stdout.write(`\nwrote ${EVAL_OUTPUT}\nwrote ${DOC_OUTPUT}\n`);
}

function renderDoc(
  overall: Record<string, number | string | null>,
  stores: Record<string, SimulationResult['store'] & { elasticity: SimulationResult['elasticity']['store'] }>,
  cells: readonly CellScore[],
): string {
  const lines: string[] = [];
  lines.push('# Simulation results — six stores, known truth');
  lines.push('');
  lines.push(
    'Every number here comes from running the production engine — forecast, cohort planner, price writer, evaluator, guardrails, rollback — over **simulated stores whose true price elasticity is known and hidden from the model**. They are projections of what the beta should do, not merchant results. Regenerate with `npx tsx scripts/simulate-portfolio.ts`.',
  );
  lines.push('');
  lines.push(`Generated ${String(overall.generated_at)} · simulated clock starts ${String(overall.sim_start_day)} · ${String(overall.seeds_per_cell)} noise seeds per cell · ${String(overall.runs)} full rollouts.`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push('| What | Number | How it is measured |');
  lines.push('|---|---|---|');
  lines.push(`| Forecast range contains the realized outcome | **${pct(overall.healthy_in_range_rate as number | null)}** | Healthy +8% and −10% rollouts; realized units change over the 90-day window vs the forecast's low–high range |`);
  lines.push(`| Typical forecast miss | **${num(overall.healthy_units_error_median_abs as number | null, 1, ' pts')}** | Median \\|realized − expected\\| units change, percentage points |`);
  lines.push(`| Same, with no store-specific fit (assumption tier) | ${pct(overall.no_fit_in_range_rate as number | null)} in range · ${num(overall.no_fit_units_error_median_abs as number | null, 1, ' pts')} miss | What the product shows a store with no usable price history |`);
  lines.push(`| False pauses on healthy rollouts | **${pct(overall.false_pause_rate as number | null)}** | A guardrail pause with no demand shock injected |`);
  lines.push(`| Demand shocks caught | **${pct(overall.shock_detection_rate as number | null)}** · median day ${num(overall.shock_days_to_pause_median as number | null, 0)} | Shoppers react 40–50% worse than the curve; days from shock to pause |`);
  lines.push(`| Every price restored after rollback | **${pct(overall.rollback_restored_rate as number | null)}** | Fake Shopify re-read against frozen baselines after every run |`);
  lines.push(`| Elasticity recovered within ±0.3 | **${pct(overall.elasticity_within_0_3 as number | null)}** · MAE ${num(overall.elasticity_mae as number | null, 2)} · 80% interval covers truth ${pct(overall.elasticity_ci80_coverage as number | null)} | Lane C's fitter on observable rows vs hidden truth, over estimated SKUs |`);
  lines.push('');
  lines.push('## The stores');
  lines.push('');
  lines.push('| Store | Size | SKUs | Units/day | Estimated SKUs | Within ±0.3 | Fit MAE | 80% CI covers truth | Tiers (fitted / partial / assumption) |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const preset of STORE_PRESETS) {
    const store = stores[preset.id];
    if (!store) continue;
    const e = store.elasticity;
    lines.push(
      `| ${preset.name} | ${preset.size} | ${store.sku_count} | ${store.units_per_day} | ${e.n_estimated}/${e.n} | ${pct(e.within_0_3)} | ${num(e.mae, 2)} | ${pct(e.ci80_covers_truth)} | ${e.tiers.fitted} / ${e.tiers.partial} / ${e.tiers.assumption} |`,
    );
  }
  lines.push('');
  lines.push('## Forecast accuracy (healthy rollouts)');
  lines.push('');
  lines.push('| Store | Scenario | Runs | Forecast tier | In range | Median miss (pts) | Mean miss (pts) | Median revenue miss | False pause | Completed | Rollback |');
  lines.push('|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const cell of cells.filter((c) => c.kind === 'healthy')) {
    const preset = STORE_PRESETS.find((p) => p.id === cell.preset) as StorePreset;
    const scenario = SCENARIOS.find((s) => s.id === cell.scenario) as Scenario;
    const tier = Object.entries(cell.forecast_confidence).map(([t, n]) => `${t}×${n}`).join(' ');
    lines.push(
      `| ${preset.name} | ${scenario.label} | ${cell.runs} | ${tier} | ${pct(cell.in_range_rate)} | ${num(cell.units_error_median_abs)} | ${num(cell.units_error_mae)} | ${num(cell.revenue_error_median_abs_pct, 0, '%')} | ${pct(cell.false_pause_rate)} | ${pct(cell.completed_rate)} | ${pct(cell.rollback_restored_rate)} |`,
    );
  }
  lines.push('');
  lines.push('## Guardrails (injected demand shocks)');
  lines.push('');
  lines.push('| Store | Scenario | Runs | Caught | Median days to pause | Rollback |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const cell of cells.filter((c) => c.kind === 'shock')) {
    const preset = STORE_PRESETS.find((p) => p.id === cell.preset) as StorePreset;
    const scenario = SCENARIOS.find((s) => s.id === cell.scenario) as Scenario;
    lines.push(`| ${preset.name} | ${scenario.label} | ${cell.runs} | ${pct(cell.detection_rate)} | ${num(cell.days_to_pause_median, 0)} | ${pct(cell.rollback_restored_rate)} |`);
  }
  lines.push('');
  lines.push('## How to read this honestly');
  lines.push('');
  lines.push('- **Simulated, with truth known.** Real stores have no ground truth, which is exactly why these numbers exist: they are the only place the forecast can be scored against what actually would have happened.');
  lines.push('- **The forecast never sees the truth.** Elasticity is estimated by the Python champion (`elasticity-poisson-eb-1.0`) from units, list price, promo and stockout flags — the columns a real Shopify sync produces. The simulator then generates the future from the hidden elasticity.');
  lines.push('- **Small stores detect slower.** Below about three expected units a day a zero is noise, so the low-volume floor deliberately refuses to count those days. That is the "quiet Tuesday" protection, and it costs detection speed on tiny catalogs.');
  lines.push('- **Beta posture: pause, never auto-revert.** A caught shock pauses and emails a recommendation; the restore is a merchant click. The rollback row measures that click.');
  lines.push('- **Revenue misses are wider than unit misses** because revenue compounds the unit error with price and promo mix over a 90-day window.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

void main().catch((cause: unknown) => {
  process.stderr.write(`\nsimulation failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exit(1);
});
