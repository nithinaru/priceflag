/**
 * The rollout simulator behind the founder lab and the investor numbers.
 *
 * It does not model Priceflag; it *runs* Priceflag. A preset store is loaded
 * into an in-memory `DemoAdapter`, the real forecast is built, a real draft is
 * frozen, the real `startRollout` writes the first cohort into a fake Shopify,
 * and then the production evaluator is ticked once per simulated day exactly as
 * the GitHub Actions schedule ticks it. The only invented thing is tomorrow's
 * demand, which comes from the same generator that produced the history — with
 * a hidden true elasticity the engine never sees.
 *
 * That is what makes the accuracy numbers honest: the forecast uses whatever
 * Lane C's fitter estimated from observable rows, and the simulator scores it
 * against what the hidden truth then produced.
 *
 * Nothing here persists, and no Shopify client is ever constructed.
 */

import { randomUUID } from 'node:crypto';

import { DemoAdapter, fitRowsFromContract } from '../adapters/demo';
import type { StoreAdapter } from '../adapters/types';
import { parseProposal, prepareForecast } from '../api/proposals';
import {
  CONTRACT_VERSION,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MIN_EXPECTED_UNITS,
  defaultGuardrails,
  type Confidence,
  type ForecastResult,
  type Guardrails,
  type ProposalRequest,
  type StageSpec,
} from '../contracts';
import { addDays, dayInTimeZone, diffDays, nowIso, type DayString } from '../dates';
import { evaluateRollout, startRollout } from '../evaluator';
import { normalizeStages, planRolloutVariants } from '../engine/rollout';
import { applyPercent, type Cents, type Rounding } from '../money';
import type { Notification, Notifier } from '../notify';
import { rollbackRollout, verifyRollback } from '../pricing/writer';
import {
  exclusionReasonFor,
  type ElasticityFitRow,
  type OrderDayUpsert,
  type Product,
  type Rollout,
  type RolloutCreate,
  type RolloutEvent,
  type RolloutReading,
  type Shop,
} from '../types';
import { FakeShopify, type FaultPlan } from './fake-shopify';
import {
  PROMO_DISCOUNT_PCT,
  PROMO_PROBABILITY,
  expectedUnits,
  mulberry32,
  negativeBinomial,
  type DemoStore,
  type DemoTruth,
} from './generator';
import PORTFOLIO_FITS from './portfolio-fits.json';
import { estimatedUnitsPerDay, findPreset, generatePortfolioStore, type StorePreset } from './portfolio';

/** The simulator's clock. Fixed, so a run is reproducible (CLAUDE.md: no Date.now() in engine logic). */
export const SIM_START_DAY: DayString = '2026-09-16';
const SIM_TIMEZONE = 'America/New_York';
/** The evaluator's daily tick, 13:15 UTC like `evaluator.yml`. */
const TICK_UTC = 'T13:15:00.000Z';

export interface SimulationInput {
  preset: string;
  price_change_pct: number;
  rounding?: Rounding;
  /** How many repriceable SKUs to select. Defaults by store size. */
  selection_size?: number;
  horizon_days?: number;
  stages?: { fraction: number; hold_days: number }[];
  guardrail?: { threshold_pct: number; consecutive_days: number; min_expected_units: number };
  /**
   * Shoppers react worse than the elasticity curve says, on the repriced SKUs,
   * from this rollout day (1 = the first live day). `factor` multiplies demand.
   */
  shock?: { factor: number; from_day: number } | null;
  /** Use the committed Lane C fits for this preset, or run with none (assumption tier). */
  fits?: 'fixture' | 'none';
  /** A Shopify failure to inject into the writer, as the adversarial suite does. */
  shopify_fault?: FaultPlan | null;
  /** Restore every price at the end and verify it, as a merchant rollback would. */
  rollback_at_end?: boolean;
  /** Noise seed for the simulated future. Defaults from the preset. */
  seed?: number;
}

export interface SimulationSelection {
  variant_gid: string;
  title: string;
  baseline_price_cents: Cents;
  target_price_cents: Cents;
  cogs_cents: Cents | null;
  cohort_stage: number;
  baseline_units_per_day: number;
  /** Simulator ground truth. Lab-only; never shown to a merchant. */
  true_elasticity: number;
  fitted_elasticity: number | null;
  fit_confidence: Confidence;
}

export interface ElasticitySummary {
  n: number;
  n_estimated: number;
  /** Mean absolute error of estimated vs true, over estimated SKUs. */
  mae: number | null;
  within_0_3: number | null;
  ci80_covers_truth: number | null;
  tiers: Record<Confidence, number>;
}

export interface RealizedOutcome {
  treated_sku_days: number;
  from: DayString;
  to: DayString;
  actual_units: number;
  control_units: number;
  units_change_pct: number;
  /** Per treated SKU-day, scaled to the forecast's horizon × selection. */
  revenue_delta_cents: Cents;
  profit_delta_cents: Cents | null;
}

export interface SimulationTimelineRow {
  day: DayString;
  stage_index: number;
  decision: string;
  reason: string;
  actual_units: number | null;
  expected_units: number | null;
  expected_low: number | null;
  expected_high: number | null;
  breach: boolean;
  band_floored: boolean;
}

export interface SimulationResult {
  preset: StorePreset;
  store: { sku_count: number; repriceable: number; units_per_day: number; history_days: number };
  input: Required<Pick<SimulationInput, 'price_change_pct' | 'horizon_days' | 'selection_size' | 'fits' | 'rollback_at_end'>> &
    Pick<SimulationInput, 'shock' | 'shopify_fault' | 'rounding' | 'seed'> & {
      guardrail: NonNullable<SimulationInput['guardrail']>;
      stages: StageSpec[];
    };
  selection: SimulationSelection[];
  forecast: ForecastResult;
  rollout: Rollout;
  readings: RolloutReading[];
  events: RolloutEvent[];
  notifications: { kind: Notification['kind']; reason: string | null; detail: number | null }[];
  timeline: SimulationTimelineRow[];
  realized: RealizedOutcome | null;
  accuracy: {
    forecast_units_change_pct: number | null;
    forecast_low_pct: number | null;
    forecast_high_pct: number | null;
    units_error_points: number | null;
    in_range: boolean | null;
    revenue_error_pct: number | null;
  };
  detection: {
    shock_day: DayString | null;
    paused_day: DayString | null;
    days_to_pause: number | null;
    /** A pause with no shock configured. */
    false_pause: boolean;
  };
  elasticity: { selection: ElasticitySummary; store: ElasticitySummary };
  rollback: {
    attempted: boolean;
    verified: number;
    mismatched: number;
    /** Every repriced SKU is back on its frozen baseline in the fake Shopify. */
    all_baselines_restored: boolean;
  } | null;
  days_simulated: number;
}

export class SimulationInputError extends Error {
  constructor(readonly issues: string[]) {
    super(issues[0] ?? 'Enter valid simulator inputs.');
    this.name = 'SimulationInputError';
  }
}

const DEFAULT_SELECTION: Record<StorePreset['size'], number> = { small: 6, medium: 12, large: 24 };

function numberIn(value: unknown, min: number, max: number, label: string, issues: string[], fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push(`${label} must be between ${min} and ${max}.`);
    return fallback;
  }
  return value;
}

/** Validate and default a request body. Throws `SimulationInputError` with every problem. */
export function parseSimulationInput(value: unknown): SimulationInput & {
  price_change_pct: number;
  horizon_days: number;
  fits: 'fixture' | 'none';
  rollback_at_end: boolean;
  guardrail: NonNullable<SimulationInput['guardrail']>;
} {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SimulationInputError(['Send a JSON object with the simulator inputs.']);
  }
  const input = value as Record<string, unknown>;
  const preset = typeof input.preset === 'string' ? findPreset(input.preset) : null;
  if (preset === null) issues.push('Choose one of the simulated stores.');

  const priceChange = numberIn(input.price_change_pct, -60, 200, 'Price change', issues, 8);
  if (priceChange === 0) issues.push('Price change cannot be zero.');
  const horizon = Math.round(numberIn(input.horizon_days, 14, 180, 'Forecast horizon', issues, DEFAULT_HORIZON_DAYS));
  const selectionSize =
    input.selection_size === undefined
      ? undefined
      : Math.round(numberIn(input.selection_size, 1, 60, 'Selection size', issues, 6));

  const rounding = input.rounding;
  if (rounding !== undefined && !['none', 'end_99', 'end_95', 'end_00'].includes(String(rounding))) {
    issues.push('Choose a supported rounding rule.');
  }

  const rawGuardrail = (input.guardrail ?? {}) as Record<string, unknown>;
  const guardrail = {
    threshold_pct: numberIn(rawGuardrail.threshold_pct, 5, 90, 'Guardrail threshold', issues, 35),
    consecutive_days: Math.round(numberIn(rawGuardrail.consecutive_days, 1, 7, 'Consecutive days', issues, 2)),
    min_expected_units: numberIn(rawGuardrail.min_expected_units, 0, 50, 'Low-volume floor', issues, DEFAULT_MIN_EXPECTED_UNITS),
  };

  let shock: SimulationInput['shock'] = null;
  if (input.shock !== undefined && input.shock !== null) {
    const raw = input.shock as Record<string, unknown>;
    shock = {
      factor: numberIn(raw.factor, 0.05, 1.5, 'Shock factor', issues, 0.6),
      from_day: Math.round(numberIn(raw.from_day, 1, 120, 'Shock day', issues, 4)),
    };
  }

  let stages: SimulationInput['stages'];
  if (input.stages !== undefined) {
    if (!Array.isArray(input.stages) || input.stages.length === 0 || input.stages.length > 6) {
      issues.push('Stages must be a list of one to six steps.');
    } else {
      stages = input.stages.map((stage) => {
        const row = (stage ?? {}) as Record<string, unknown>;
        return {
          fraction: numberIn(row.fraction, 0.01, 1, 'Stage fraction', issues, 1),
          hold_days: Math.round(numberIn(row.hold_days, 1, 30, 'Stage hold days', issues, 3)),
        };
      });
    }
  }

  const fits = input.fits === 'none' ? 'none' : 'fixture';
  const rollbackAtEnd = input.rollback_at_end === undefined ? true : input.rollback_at_end === true;
  const seed = input.seed === undefined ? undefined : Math.round(numberIn(input.seed, 0, 2 ** 31, 'Seed', issues, 0));

  let fault: FaultPlan | null = null;
  if (input.shopify_fault !== undefined && input.shopify_fault !== null) {
    const raw = input.shopify_fault as Record<string, unknown>;
    const kinds = ['throttle', 'server_error', 'timeout_after_write', 'timeout_before_write', 'user_errors', 'ack_partial'];
    if (!kinds.includes(String(raw.kind))) issues.push('Choose a supported Shopify fault.');
    fault = {
      kind: raw.kind as FaultPlan['kind'],
      onCall: Math.round(numberIn(raw.onCall, 0, 50, 'Fault call number', issues, 1)),
      persistent: raw.persistent === true,
    };
  }

  if (issues.length > 0) throw new SimulationInputError(issues);

  return {
    preset: (preset as StorePreset).id,
    price_change_pct: priceChange,
    rounding: rounding as Rounding | undefined,
    selection_size: selectionSize,
    horizon_days: horizon,
    stages,
    guardrail,
    shock,
    fits,
    shopify_fault: fault,
    rollback_at_end: rollbackAtEnd,
    seed,
  };
}

function labGuardrails(rule: NonNullable<SimulationInput['guardrail']>): Guardrails {
  const base = defaultGuardrails();
  const first = base.rules[0];
  if (!first) return base;
  const days = rule.consecutive_days;
  return {
    ...base,
    auto_rollback: false,
    rules: [
      {
        ...first,
        id: `units-${Math.round(rule.threshold_pct)}-${days}d`,
        threshold_pct: rule.threshold_pct,
        consecutive_days: days,
        min_expected_units: rule.min_expected_units,
        action: 'pause',
        sentence: `If daily units fall more than ${Math.round(rule.threshold_pct)}% below expected for ${days} day${days === 1 ? '' : 's'} in a row, pause the rollout and alert me.`,
      },
    ],
  };
}

function tickAfter(day: DayString): Date {
  return new Date(`${addDays(day, 1)}${TICK_UTC}`);
}

let fixtureOverride: Record<string, Record<string, unknown>[]> | null = null;

/** Scripts that just regenerated the fixture swap it in without a re-import. */
export function overridePortfolioFits(fits: Record<string, Record<string, unknown>[]> | null): void {
  fixtureOverride = fits;
}

function fitFixtureFor(preset: StorePreset): Record<string, unknown>[] {
  const all = fixtureOverride ?? (PORTFOLIO_FITS as Record<string, Record<string, unknown>[]>);
  return all[preset.id] ?? [];
}

function summarizeElasticity(
  rows: readonly { true_elasticity: number; fit: ElasticityFitRow | undefined }[],
): ElasticitySummary {
  const tiers: Record<Confidence, number> = { fitted: 0, partial: 0, assumption: 0 };
  let estimated = 0;
  let absError = 0;
  let within = 0;
  let covered = 0;
  let coverable = 0;
  for (const row of rows) {
    const tier: Confidence = row.fit?.confidence ?? 'assumption';
    tiers[tier] += 1;
    if (!row.fit || tier === 'assumption') continue;
    estimated += 1;
    const error = Math.abs(row.fit.elasticity - row.true_elasticity);
    absError += error;
    if (error <= 0.3) within += 1;
    const low = row.fit.low ?? (row.fit.se === null ? null : row.fit.elasticity - 1.2816 * row.fit.se);
    const high = row.fit.high ?? (row.fit.se === null ? null : row.fit.elasticity + 1.2816 * row.fit.se);
    if (low !== null && high !== null) {
      coverable += 1;
      if (row.true_elasticity >= low && row.true_elasticity <= high) covered += 1;
    }
  }
  return {
    n: rows.length,
    n_estimated: estimated,
    mae: estimated === 0 ? null : absError / estimated,
    within_0_3: estimated === 0 ? null : within / estimated,
    ci80_covers_truth: coverable === 0 ? null : covered / coverable,
    tiers,
  };
}

interface LedgerRow {
  day: DayString;
  variant_gid: string;
  treated: boolean;
  units: number;
  net_cents: Cents;
  control_units: number;
  control_net_cents: Cents;
  cogs_cents: Cents | null;
}

/** Run one rollout on one simulated store, end to end, through the production engine. */
export async function runRolloutSimulation(rawInput: SimulationInput): Promise<SimulationResult> {
  const input = parseSimulationInput(rawInput);
  const preset = findPreset(input.preset) as StorePreset;
  const startDay = SIM_START_DAY;
  const startInstant = new Date(`${startDay}${TICK_UTC}`);

  // --- the store -----------------------------------------------------------
  const store: DemoStore = generatePortfolioStore(preset, {
    endDay: addDays(startDay, -1),
    now: startInstant,
  });
  const adapter: StoreAdapter = new DemoAdapter({ persist: false, autoSeed: false });
  const shop: Shop = await adapter.upsertShop({
    ...store.shop,
    timezone: SIM_TIMEZONE,
    mode: 'demo',
    access_token_enc: null,
  });
  await adapter.upsertProducts(shop.id, store.products);
  await adapter.upsertOrderDays(shop.id, store.orderDays);

  const truthByGid = new Map(store.truth.map((row) => [row.variant_gid, row]));
  const repriceableGids = store.products
    .filter((product) => exclusionReasonFor({ ...product, deleted_at: null } as Product) === null)
    .map((product) => product.variant_gid);

  // --- Lane C's fits, if we have them for this store ------------------------
  const fixture = input.fits === 'fixture' ? fitFixtureFor(preset) : [];
  if (fixture.length > 0 && adapter.upsertFits) {
    const rows = fitRowsFromContract(shop.id, fixture, `lab-${preset.id}`, nowIso(startInstant));
    await adapter.upsertFits(shop.id, rows.map(({ id: _id, ...rest }) => rest));
  }
  const storeFits = fixture.length > 0 ? await adapter.getLatestFits(shop.id, repriceableGids) : new Map<string, ElasticityFitRow>();

  // --- the selection ---------------------------------------------------------
  const rng = mulberry32((input.seed ?? preset.seed + 1) >>> 0);
  const shuffled = [...repriceableGids];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string];
  }
  const selectionSize = Math.min(shuffled.length, input.selection_size ?? DEFAULT_SELECTION[preset.size]);
  const selectedGids = shuffled.slice(0, selectionSize).sort();
  if (selectedGids.length === 0) throw new SimulationInputError(['This store has nothing repriceable.']);

  // --- forecast + draft, exactly as POST /api/rollouts does -------------------
  const proposal: ProposalRequest = parseProposal({
    contract_version: CONTRACT_VERSION,
    name: `Lab · ${input.price_change_pct > 0 ? '+' : ''}${input.price_change_pct}% on ${selectedGids.length} products`,
    variant_gids: selectedGids,
    change: { type: 'percent', percent: input.price_change_pct, rounding: input.rounding ?? 'none' },
    horizon_days: input.horizon_days,
    ...(input.stages ? { stages: input.stages } : {}),
    guardrails: labGuardrails(input.guardrail),
  });
  const { forecast, products } = await prepareForecast(adapter, shop, proposal);
  const eligibleCount = products.filter((product) => exclusionReasonFor(product) === null).length;
  const stages = normalizeStages(proposal.stages, eligibleCount);
  const rolloutId = randomUUID();
  const baselineUnits = new Map(forecast.products.map((line) => [line.variant_gid, line.baseline_units_per_day]));
  const variants = planRolloutVariants({
    rolloutId,
    shopId: shop.id,
    products,
    change: proposal.change,
    stages,
    baselineUnitsPerDay: baselineUnits,
    currency: shop.currency,
  });
  const draft: RolloutCreate & { id: string } = {
    id: rolloutId,
    shop_id: shop.id,
    name: proposal.name as string,
    status: 'draft',
    change_type: 'percent',
    change_pct: input.price_change_pct,
    change_absolute_cents: null,
    rounding: proposal.change.rounding ?? 'none',
    horizon_days: input.horizon_days,
    stages,
    current_stage: -1,
    stage_entered_at: null,
    guardrails: proposal.guardrails as Guardrails,
    forecast,
    scheduled_start_at: null,
    started_at: null,
    ended_at: null,
    ended_reason: null,
    paused_reason: null,
    notify_emails: [],
    created_by: 'founder-lab',
  };
  const created = await adapter.createDraftRollout(draft, variants);

  // --- the fake Shopify and the recording notifier ----------------------------
  const shopify = new FakeShopify().seed(products);
  if (input.shopify_fault) shopify.program(input.shopify_fault);
  const notifications: SimulationResult['notifications'] = [];
  const notifier: Notifier = async (notification) => {
    notifications.push({
      kind: notification.kind,
      reason: notification.reason ?? null,
      detail: notification.detail ?? null,
    });
  };
  const client = shopify.asClient();
  const context = { adapter, client, shop };

  // --- confirm: stage 0 goes live through the real writer ---------------------
  await startRollout(adapter, shop, created.rollout, { client, notifier, now: startInstant, skipLock: true });
  let rollout = (await adapter.getRollout(rolloutId)) as Rollout;

  // --- day by day ---------------------------------------------------------------
  const selected = products.map((product) => ({
    product,
    truth: truthByGid.get(product.variant_gid) as DemoTruth,
  }));
  const ledger: LedgerRow[] = [];
  const timeline: SimulationTimelineRow[] = [];
  const historyStart = store.window.from;
  let finalStageDay: DayString | null = null;
  let pausedDay: DayString | null = null;
  let shockDay: DayString | null = null;
  const maxDays = stages.reduce((sum, stage) => sum + stage.hold_days, 0) + input.horizon_days + 3;
  let daysSimulated = 0;

  const noteFinalStage = (): void => {
    if (finalStageDay === null && rollout.current_stage === stages.length - 1 && rollout.stage_entered_at !== null) {
      finalStageDay = dayInTimeZone(new Date(rollout.stage_entered_at), SIM_TIMEZONE);
    }
  };
  noteFinalStage();

  for (let dayIndex = 1; dayIndex <= maxDays; dayIndex += 1) {
    // A rollout that never started, or stopped, has no future worth generating.
    if (rollout.status !== 'running' && rollout.status !== 'completed') break;
    const day = addDays(startDay, dayIndex - 1);
    const offset = diffDays(historyStart, day);
    const onPromo = rng() < PROMO_PROBABILITY;
    const shockActive = input.shock !== null && input.shock !== undefined && dayIndex >= input.shock.from_day;
    const rows: OrderDayUpsert[] = [];

    for (const { product, truth } of selected) {
      if (truth === undefined) continue;
      const livePrice = shopify.priceOf(product.variant_gid) ?? product.price_cents;
      const treated = livePrice !== product.price_cents;
      const spec = { baseUnitsPerDay: truth.base_units_per_day, trueElasticity: truth.true_elasticity };
      const shockMultiplier = treated && shockActive ? (input.shock as { factor: number }).factor : 1;
      if (treated && shockActive && shockDay === null) shockDay = day;
      const lambda = expectedUnits(spec, day, offset, livePrice / truth.initial_price_cents, onPromo) * shockMultiplier;
      const controlUnits = expectedUnits(spec, day, offset, product.price_cents / truth.initial_price_cents, onPromo);
      const units = negativeBinomial(rng, lambda, truth.dispersion_k);
      const effective = onPromo ? applyPercent(livePrice, PROMO_DISCOUNT_PCT) : livePrice;
      const controlEffective = onPromo ? applyPercent(product.price_cents, PROMO_DISCOUNT_PCT) : product.price_cents;
      const gross = units * livePrice;
      const discount = units * (livePrice - effective);
      const net = gross - discount;
      rows.push({
        variant_gid: product.variant_gid,
        product_gid: product.product_gid,
        day,
        units,
        orders: units === 0 ? 0 : Math.max(1, Math.round(units * 0.85)),
        gross_revenue_cents: gross,
        discount_cents: discount,
        refund_units: 0,
        refund_cents: 0,
        net_revenue_cents: net,
        realized_unit_price_cents: units > 0 ? effective : null,
        list_price_cents: livePrice,
        had_stockout: false,
        on_promo: onPromo,
        source: 'sync',
      });
      ledger.push({
        day,
        variant_gid: product.variant_gid,
        treated,
        units,
        net_cents: net,
        control_units: controlUnits,
        control_net_cents: Math.round(controlUnits * controlEffective),
        cogs_cents: product.cogs_cents,
      });
    }
    await adapter.upsertOrderDays(shop.id, rows);
    daysSimulated = dayIndex;

    if (rollout.status === 'running') {
      const outcome = await evaluateRollout(adapter, shop, rollout, {
        asOfDay: day,
        now: tickAfter(day),
        client,
        notifier,
        skipLock: true,
      });
      timeline.push({
        day,
        stage_index: outcome.reading?.stage_index ?? rollout.current_stage,
        decision: outcome.skipped ?? outcome.decision,
        reason: outcome.reason,
        actual_units: outcome.reading?.actual_units ?? null,
        expected_units: outcome.reading?.expected_units ?? null,
        expected_low: outcome.reading?.expected_low ?? null,
        expected_high: outcome.reading?.expected_high ?? null,
        breach: outcome.reading?.breach ?? false,
        band_floored: outcome.reading?.band_floored ?? false,
      });
      rollout = (await adapter.getRollout(rolloutId)) as Rollout;
      noteFinalStage();
      if (rollout.status === 'paused') {
        pausedDay = day;
        break;
      }
      if (rollout.status !== 'running' && rollout.status !== 'completed') break;
    }

    if (finalStageDay !== null && diffDays(finalStageDay, day) >= input.horizon_days - 1) break;
  }

  // --- what actually happened, against the hidden truth -----------------------
  const treatedRows = ledger.filter((row) => row.treated);
  let realized: RealizedOutcome | null = null;
  if (treatedRows.length > 0) {
    const actualUnits = treatedRows.reduce((sum, row) => sum + row.units, 0);
    const controlUnits = treatedRows.reduce((sum, row) => sum + row.control_units, 0);
    const revenueDelta = treatedRows.reduce((sum, row) => sum + (row.net_cents - row.control_net_cents), 0);
    const profitKnown = treatedRows.every((row) => row.cogs_cents !== null);
    const profitDelta = profitKnown
      ? treatedRows.reduce(
          (sum, row) =>
            sum +
            (row.net_cents - (row.cogs_cents as Cents) * row.units) -
            (row.control_net_cents - (row.cogs_cents as Cents) * row.control_units),
          0,
        )
      : null;
    const scale = (input.horizon_days * selected.length) / treatedRows.length;
    realized = {
      treated_sku_days: treatedRows.length,
      from: treatedRows[0]?.day as DayString,
      to: treatedRows[treatedRows.length - 1]?.day as DayString,
      actual_units: actualUnits,
      control_units: Number(controlUnits.toFixed(2)),
      units_change_pct: controlUnits > 0 ? ((actualUnits - controlUnits) / controlUnits) * 100 : 0,
      revenue_delta_cents: Math.round(revenueDelta * scale),
      profit_delta_cents: profitDelta === null ? null : Math.round(profitDelta * scale),
    };
  }

  const fitted = forecast.fitted;
  const forecastPct = fitted?.expected.units_change_pct ?? null;
  const lowPct = fitted ? Math.min(fitted.low.units_change_pct, fitted.high.units_change_pct) : null;
  const highPct = fitted ? Math.max(fitted.low.units_change_pct, fitted.high.units_change_pct) : null;
  const unitsError = realized !== null && forecastPct !== null ? realized.units_change_pct - forecastPct : null;
  const inRange =
    realized !== null && lowPct !== null && highPct !== null
      ? realized.units_change_pct >= lowPct && realized.units_change_pct <= highPct
      : null;
  const revenueError =
    realized !== null && fitted && fitted.expected.revenue_delta_cents !== 0
      ? ((realized.revenue_delta_cents - fitted.expected.revenue_delta_cents) / Math.abs(fitted.expected.revenue_delta_cents)) * 100
      : null;

  // --- the promise: everything goes back --------------------------------------
  let rollback: SimulationResult['rollback'] = null;
  if (input.rollback_at_end) {
    shopify.clearFaults();
    const current = (await adapter.getRollout(rolloutId)) as Rollout;
    await rollbackRollout(context, current, { reason: 'Founder lab: restore every price at the end of the run.', actor: 'merchant' });
    const verification = await verifyRollback(context, current);
    const allVariants = await adapter.getRolloutVariants(rolloutId);
    const restored = allVariants
      .filter((variant) => !variant.excluded)
      .every((variant) => shopify.priceOf(variant.variant_gid) === variant.baseline_price_cents);
    await adapter.updateRollout(rolloutId, {
      status: 'rolled_back',
      ended_at: nowIso(tickAfter(addDays(startDay, daysSimulated))),
      ended_reason: 'manual_rollback',
    });
    await adapter.appendRolloutEvent({
      rollout_id: rolloutId,
      shop_id: shop.id,
      type: 'manual_rollback',
      actor: 'merchant',
      message: `Founder lab restored ${verification.verified} price${verification.verified === 1 ? '' : 's'} to their frozen baselines and re-read each one from Shopify.`,
      data: { verified: verification.verified, mismatched: verification.mismatched.length },
    });
    rollback = {
      attempted: true,
      verified: verification.verified,
      mismatched: verification.mismatched.length,
      all_baselines_restored: restored && verification.mismatched.length === 0,
    };
    rollout = (await adapter.getRollout(rolloutId)) as Rollout;
  }

  const rolloutVariants = await adapter.getRolloutVariants(rolloutId);
  const selectionRows: SimulationSelection[] = rolloutVariants
    .filter((variant) => !variant.excluded)
    .map((variant) => {
      const truth = truthByGid.get(variant.variant_gid);
      const fit = storeFits.get(variant.variant_gid);
      return {
        variant_gid: variant.variant_gid,
        title: truth?.title ?? variant.title,
        baseline_price_cents: variant.baseline_price_cents,
        target_price_cents: variant.target_price_cents,
        cogs_cents: variant.cogs_cents_at_creation,
        cohort_stage: variant.cohort_stage,
        baseline_units_per_day: variant.baseline_units_per_day ?? 0,
        true_elasticity: truth?.true_elasticity ?? 0,
        fitted_elasticity: fit && fit.confidence !== 'assumption' ? fit.elasticity : null,
        fit_confidence: fit?.confidence ?? 'assumption',
      };
    });

  const elasticityRows = (gids: readonly string[]) =>
    gids.map((gid) => ({
      true_elasticity: truthByGid.get(gid)?.true_elasticity ?? 0,
      fit: storeFits.get(gid),
    }));

  return {
    preset,
    store: {
      sku_count: store.products.length,
      repriceable: repriceableGids.length,
      units_per_day: Number(estimatedUnitsPerDay(store).toFixed(1)),
      history_days: store.window.days,
    },
    input: {
      price_change_pct: input.price_change_pct,
      horizon_days: input.horizon_days,
      selection_size: selectedGids.length,
      fits: input.fits,
      rollback_at_end: input.rollback_at_end,
      shock: input.shock ?? null,
      shopify_fault: input.shopify_fault ?? null,
      rounding: input.rounding,
      seed: input.seed,
      guardrail: input.guardrail,
      stages,
    },
    selection: selectionRows,
    forecast,
    rollout,
    readings: await adapter.listRolloutReadings(rolloutId),
    events: await adapter.listRolloutEvents(rolloutId),
    notifications,
    timeline,
    realized,
    accuracy: {
      forecast_units_change_pct: forecastPct,
      forecast_low_pct: lowPct,
      forecast_high_pct: highPct,
      units_error_points: unitsError,
      in_range: inRange,
      revenue_error_pct: revenueError,
    },
    detection: {
      shock_day: shockDay,
      paused_day: pausedDay,
      days_to_pause: shockDay !== null && pausedDay !== null ? diffDays(shockDay, pausedDay) + 1 : null,
      false_pause: pausedDay !== null && input.shock == null && input.shopify_fault == null,
    },
    elasticity: {
      selection: summarizeElasticity(elasticityRows(selectedGids)),
      store: summarizeElasticity(elasticityRows(repriceableGids)),
    },
    rollback,
    days_simulated: daysSimulated,
  };
}

/** The lab's starting point: the small coffee-alternatives store, a modest increase. */
export const DEFAULT_SIMULATION_INPUT: Readonly<SimulationInput> = Object.freeze({
  preset: 'morning-root',
  price_change_pct: 8,
  rounding: 'end_99' as Rounding,
  horizon_days: 30,
  guardrail: { threshold_pct: 35, consecutive_days: 2, min_expected_units: DEFAULT_MIN_EXPECTED_UNITS },
  shock: null,
  fits: 'fixture' as const,
  rollback_at_end: true,
});
