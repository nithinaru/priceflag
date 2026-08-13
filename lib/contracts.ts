/**
 * TypeScript mirrors of `contracts/*.schema.json`.
 *
 * The JSON Schemas are the law; these types are the convenience. They are kept
 * in sync by `scripts/smoke.ts`, which validates a fixture of each type against
 * the schema on every run — so a drift between the two fails the build rather
 * than reaching the UI as a missing number.
 *
 * Lanes A and C may import from here freely.
 */

import type { Cents, Rounding } from './money';

export const CONTRACT_VERSION = '1.0.0' as const;

/** How much a lane may trust a number. Consumers treat anything unknown as `assumption`. */
export type Confidence = 'fitted' | 'partial' | 'assumption';

export const CONFIDENCE_ORDER: readonly Confidence[] = ['fitted', 'partial', 'assumption'];

/** R32 staleness. Shared so all three lanes demote on the same clock. */
export const MAX_BAND_AGE_DAYS = 2;
export const MAX_FIT_AGE_DAYS = 30;

/** Low-volume floor: below this many expected units, a single day is not evidence. */
export const DEFAULT_MIN_EXPECTED_UNITS = 3;

/** Default staged plan: 25% -> 50% -> 100% of the selection (R11). Never traffic. */
export const DEFAULT_STAGE_PLAN: readonly StageSpec[] = [
  { index: 0, fraction: 0.25, hold_days: 3 },
  { index: 1, fraction: 0.5, hold_days: 3 },
  { index: 2, fraction: 1, hold_days: 4 },
];

/** A single SKU cannot be split into cohorts, so it becomes a time canary (R11). */
export const CANARY_STAGE_PLAN: readonly StageSpec[] = [
  { index: 0, fraction: 1, hold_days: 3 },
  { index: 1, fraction: 1, hold_days: 4 },
];

export const DEFAULT_HORIZON_DAYS = 90;
export const DEFAULT_HISTORY_DAYS = 180;
/** Trailing window used for the baseline in a forecast. Four whole weeks, so
 *  day-of-week effects cancel instead of tilting the baseline. */
export const BASELINE_WINDOW_DAYS = 28;

/** Worst (most cautious) tier among the inputs. */
export function worstConfidence(tiers: readonly Confidence[]): Confidence {
  let worst: Confidence = 'fitted';
  for (const tier of tiers) {
    if (CONFIDENCE_ORDER.indexOf(tier) > CONFIDENCE_ORDER.indexOf(worst)) worst = tier;
  }
  return worst;
}

/** One step down, never up. Used for staleness demotion (R32). */
export function demoteConfidence(tier: Confidence): Confidence {
  return tier === 'fitted' ? 'partial' : 'assumption';
}

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------

export interface StageSpec {
  index: number;
  /** Cumulative share of the SELECTION live at this stage. The last stage is 1. */
  fraction: number;
  hold_days: number;
}

// ---------------------------------------------------------------------------
// forecast_result.schema.json
// ---------------------------------------------------------------------------

export type ForecastWarningCode =
  | 'missing_cogs'
  | 'price_below_cost'
  | 'thin_history'
  | 'no_price_variation'
  | 'stale_model'
  | 'excluded_variants'
  | 'wide_range'
  | 'compare_at_cleared';

export interface ForecastWarning {
  code: ForecastWarningCode;
  message: string;
}

export type CompareAtAction = 'keep' | 'clear' | 'none';

export type ExclusionReason = 'gift_card' | 'subscription' | 'not_active' | 'zero_price' | null;

export interface ForecastOutcome {
  units_change_pct: number;
  revenue_delta_cents: Cents;
  /** null means unknown, not zero: some variant has no COGS (R3). */
  profit_delta_cents: Cents | null;
}

export interface ForecastScenario {
  label: string;
  units_change_pct: number;
  units_total: number;
  revenue_delta_cents: Cents;
  profit_delta_cents: Cents | null;
  is_breakeven: boolean;
}

export interface ForecastProductLine {
  variant_gid: string;
  title: string;
  current_price_cents: Cents;
  target_price_cents: Cents;
  compare_at_cents: Cents | null;
  compare_at_action: CompareAtAction;
  cogs_cents: Cents | null;
  cogs_source: CogsSource;
  baseline_units_per_day: number;
  /** Expected unit-demand multiplier at this line's approved target price. */
  demand_multiplier: number | null;
  /** Frozen pre-change net revenue after discounts/returns, divided by gross revenue. */
  revenue_realization_rate: number;
  confidence: Confidence;
  excluded: boolean;
  exclusion_reason: ExclusionReason;
}

export interface ForecastResult {
  contract_version: typeof CONTRACT_VERSION;
  generated_at: string;
  model_version: string | null;
  currency: string;
  horizon_days: number;
  confidence: Confidence;
  confidence_explanation: string;
  proposal: {
    change_type: 'percent' | 'absolute';
    change_pct: number | null;
    change_absolute_cents: Cents | null;
    rounding: Rounding;
    variant_count: number;
  };
  baseline: {
    history_days: number;
    units_per_day: number;
    orders_per_day: number;
    revenue_cents_per_day: Cents;
    profit_cents_per_day: Cents | null;
    margin_pct: number | null;
    avg_price_cents: Cents;
    avg_unit_cost_cents: Cents | null;
    has_cogs: boolean;
  };
  breakeven: {
    units_change_pct: number | null;
    direction: 'can_lose' | 'must_gain' | 'undefined';
    sentence: string;
  };
  scenarios: ForecastScenario[];
  fitted: {
    elasticity: number;
    elasticity_se: number | null;
    n_obs: number;
    price_variation_pct: number;
    source: 'model' | 'portfolio_prior' | 'category_default';
    expected: ForecastOutcome;
    low: ForecastOutcome;
    high: ForecastOutcome;
  } | null;
  explanation: string;
  assumptions: string[];
  warnings: ForecastWarning[];
  products: ForecastProductLine[];
}

// ---------------------------------------------------------------------------
// elasticity_fit.schema.json
// ---------------------------------------------------------------------------

export interface ElasticityFit {
  contract_version: typeof CONTRACT_VERSION;
  shop_domain: string;
  variant_gid: string;
  elasticity: number;
  se: number | null;
  /** Credible bounds on the elasticity. Sent together; preferred over `se` when present. */
  low?: number | null;
  high?: number | null;
  interval?: number | null;
  n_obs: number;
  price_variation_pct: number;
  confidence: Confidence;
  confidence_explanation?: string;
  method?: string;
  shrinkage_weight?: number | null;
  prior_elasticity?: number | null;
  r2?: number | null;
  model_version: string;
  model_run_id?: string | null;
  fitted_at: string;
  window_start?: string | null;
  window_end?: string | null;
}

// ---------------------------------------------------------------------------
// expected_band.schema.json
// ---------------------------------------------------------------------------

export type BandKind = 'baseline' | 'counterfactual';

export interface ExpectedBand {
  contract_version: typeof CONTRACT_VERSION;
  shop_domain: string;
  variant_gid: string;
  day: string;
  expected_units: number;
  low: number;
  high: number;
  interval: number;
  band_kind: BandKind;
  rollout_id?: string | null;
  breach_probability?: number | null;
  model_version: string;
  model_run_id?: string | null;
  is_floored?: boolean;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// guardrails.schema.json
// ---------------------------------------------------------------------------

export type GuardrailMetric = 'units' | 'revenue' | 'profit';
export type GuardrailComparison = 'below_expected_pct' | 'below_absolute';
export type GuardrailScope = 'rollout' | 'product';
export type GuardrailAction = 'rollback_all' | 'pause';

export interface GuardrailRule {
  id: string;
  metric: GuardrailMetric;
  comparison: GuardrailComparison;
  /** Percentage points below expected. 30 means `actual < expected * 0.70`. */
  threshold_pct: number | null;
  absolute_floor?: number | null;
  consecutive_days: number;
  scope: GuardrailScope;
  action: GuardrailAction;
  min_expected_units?: number | null;
  /** Verbatim what the merchant read and agreed to. Never regenerate it. */
  sentence: string;
}

export interface Guardrails {
  contract_version: typeof CONTRACT_VERSION;
  auto_rollback: boolean;
  rules: GuardrailRule[];
  notes?: string;
}

/** Forgiving defaults, deliberately: the first rollout should not whipsaw. */
export function defaultGuardrails(): Guardrails {
  return {
    contract_version: CONTRACT_VERSION,
    auto_rollback: false,
    rules: [
      {
        id: 'units-35-2d',
        metric: 'units',
        comparison: 'below_expected_pct',
        threshold_pct: 35,
        consecutive_days: 2,
        scope: 'rollout',
        action: 'rollback_all',
        min_expected_units: DEFAULT_MIN_EXPECTED_UNITS,
        sentence:
          'If daily units fall more than 35% below expected for 2 days in a row, pause the rollout and alert me.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// proposal_request.schema.json
// ---------------------------------------------------------------------------

export interface ProposalRequest {
  contract_version: typeof CONTRACT_VERSION;
  name?: string;
  variant_gids: string[];
  change: {
    type: 'percent' | 'absolute';
    percent?: number;
    absolute_cents?: Cents;
    rounding?: Rounding;
  };
  horizon_days?: number;
  stages?: { fraction: number; hold_days: number }[];
  guardrails?: Guardrails;
  scheduled_start_at?: string | null;
  notify_emails?: string[];
}

// ---------------------------------------------------------------------------
// sync_progress.schema.json
// ---------------------------------------------------------------------------

export type SyncStage = 'queued' | 'catalog' | 'history' | 'aggregating' | 'done' | 'error';

export interface SyncProgress {
  contract_version: typeof CONTRACT_VERSION;
  stage: SyncStage;
  message: string;
  catalog: {
    ready: boolean;
    products_synced: number;
    products_total: number | null;
    ready_at?: string | null;
  };
  history: {
    ready: boolean;
    days_synced: number;
    days_target: number;
    orders_processed?: number;
    ready_at?: string | null;
  };
  eta_seconds?: number | null;
  error?: {
    code: 'auth_expired' | 'rate_limited' | 'scope_missing' | 'shopify_error' | 'internal';
    message: string;
    retryable: boolean;
  } | null;
  started_at: string;
  updated_at: string;
  finished_at?: string | null;
}

// ---------------------------------------------------------------------------
// journal_entry.schema.json
// ---------------------------------------------------------------------------

export type JournalSource = 'rollout' | 'rollback' | 'external' | 'kill_switch' | 'manual' | 'seed';
export type JournalActor = 'priceflag' | 'merchant' | 'shopify_admin' | 'system';
export type JournalStatus = 'applied' | 'failed' | 'skipped_noop';
export type CogsSource = 'shopify' | 'manual' | 'none';

export interface JournalEntryContract {
  contract_version: typeof CONTRACT_VERSION;
  id: string;
  variant_gid: string;
  product_gid: string;
  title?: string;
  sku?: string | null;
  rollout_id?: string | null;
  rollout_name?: string | null;
  stage_index?: number | null;
  source: JournalSource;
  actor: JournalActor;
  reason?: string;
  status: JournalStatus;
  before_price_cents: Cents;
  after_price_cents: Cents;
  before_compare_at_cents?: Cents | null;
  after_compare_at_cents?: Cents | null;
  currency?: string;
  error?: string | null;
  applied_at: string;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// price_recommendation.schema.json
// ---------------------------------------------------------------------------

/** Which constraints the nominal optimum is pressed against; ['none'] = interior. */
export type RecommendationBinding = 'margin_floor' | 'max_change' | 'inventory' | 'lattice_edge' | 'none';

/**
 * One constrained price suggestion for one variant, from the optimizer
 * (`model_runs.kind = 'recommendation'`). Posted to `/api/ml/ingest` and handed
 * untransformed to `pf_ingest_model_run`, which flattens it into the
 * `recommendations` table (`RecommendationRow` in `lib/types.ts`). Suggestions
 * never auto-apply — the merchant always approves (PRD v1.1).
 */
export interface PriceRecommendationContract {
  contract_version: typeof CONTRACT_VERSION;
  shop_domain: string;
  variant_gid: string;
  current_price_cents: Cents;
  recommended_price_cents: Cents;
  robust_price_cents: Cents;
  rounding: Rounding;
  elasticity: number;
  elasticity_low?: number | null;
  elasticity_high?: number | null;
  fit_model_version?: string | null;
  confidence: Confidence;
  expected: {
    nominal_profit_delta_cents_per_day: Cents;
    robust_profit_delta_cents_per_day: Cents;
    nominal_revenue_delta_cents_per_day: Cents;
    robust_revenue_delta_cents_per_day: Cents;
  };
  constraints: {
    margin_floor_pct?: number | null;
    max_change_pct?: number | null;
    inventory_cap_applied?: boolean;
    binding: RecommendationBinding[];
  };
  candidates_evaluated: number;
  baseline_units_per_day?: number;
  rationale: string;
  model_version: string;
  model_run_id?: string | null;
  computed_at: string;
}

// ---------------------------------------------------------------------------
// rollout_report.schema.json
// ---------------------------------------------------------------------------

export interface RolloutReport {
  contract_version: typeof CONTRACT_VERSION;
  rollout_id: string;
  generated_at: string;
  model_version: string;
  model_run_id?: string | null;
  window: { start_day: string; end_day: string; days: number };
  predicted: { expected: ForecastOutcome; low: ForecastOutcome; high: ForecastOutcome };
  realized: ForecastOutcome;
  in_range: boolean;
  elasticity_update?: {
    before: number | null;
    after: number;
    se_after?: number | null;
    direction?: 'less_sensitive' | 'more_sensitive' | 'as_expected';
  } | null;
  narrative: string;
  per_variant?: {
    variant_gid: string;
    realized_units: number;
    expected_units: number;
    realized_revenue_cents: Cents;
    realized_profit_cents?: Cents | null;
    elasticity_after?: number | null;
  }[];
}
