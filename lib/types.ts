/**
 * Domain types. These map 1:1 onto the tables in `supabase/migrations/` and are
 * what every adapter speaks, so the rest of the engine never sees a raw database
 * row or a Shopify API payload.
 *
 * Naming follows the contract conventions: `*_cents` is an integer, `*_pct` is a
 * plain percentage number, `*_gid` is a full Shopify global id, `day` is
 * `YYYY-MM-DD` in the shop's timezone, `*_at` is an ISO 8601 UTC string.
 */

import type { Cents, Rounding } from './money';
import type { DayString } from './dates';
import type {
  BandKind,
  CogsSource,
  Confidence,
  ExclusionReason,
  ForecastResult,
  Guardrails,
  JournalActor,
  JournalSource,
  JournalStatus,
  RolloutReport,
  StageSpec,
} from './contracts';

export type Mode = 'demo' | 'real';

/**
 * Re-exported so consumers have one import for the domain: the enums live in
 * `contracts.ts` because the JSON Schemas are their source of truth.
 */
export type {
  BandKind,
  CogsSource,
  Confidence,
  ExclusionReason,
  Guardrails,
  GuardrailRule,
  JournalActor,
  JournalSource,
  JournalStatus,
  StageSpec,
} from './contracts';

// ---------------------------------------------------------------------------
// shops
// ---------------------------------------------------------------------------

export interface Shop {
  id: string;
  shop_domain: string;
  name: string | null;
  email: string | null;
  /** Never leaves the server; adapters strip it from anything API-facing. */
  access_token_enc: string | null;
  scopes: string | null;
  api_version: string;
  currency: string;
  /** IANA name. Every day boundary in the system comes from this. */
  timezone: string;
  plan_name: string | null;
  mode: Mode;
  kill_switch_engaged_at: string | null;
  kill_switch_reason: string | null;
  notify_emails: string[];
  installed_at: string | null;
  uninstalled_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ShopUpsert = Partial<Omit<Shop, 'id' | 'created_at' | 'updated_at'>> &
  Pick<Shop, 'shop_domain'>;

/** Shop without the token — the only shape an API route may return. */
export type PublicShop = Omit<Shop, 'access_token_enc'>;

export function toPublicShop(shop: Shop): PublicShop {
  const { access_token_enc: _omitted, ...rest } = shop;
  return rest;
}

// ---------------------------------------------------------------------------
// products (one row per VARIANT — see the migration comment)
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  shop_id: string;
  product_gid: string;
  variant_gid: string;
  inventory_item_gid: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  image_url: string | null;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  price_cents: Cents;
  compare_at_cents: Cents | null;
  currency: string;
  /** null = genuinely unknown. Never substitute a guess (R3). */
  cogs_cents: Cents | null;
  cogs_source: CogsSource;
  cogs_updated_at: string | null;
  is_gift_card: boolean;
  requires_selling_plan: boolean;
  has_selling_plan: boolean;
  inventory_quantity: number | null;
  available_for_sale: boolean;
  first_synced_at: string;
  last_synced_at: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ProductUpsert = Omit<
  Product,
  'id' | 'shop_id' | 'created_at' | 'updated_at' | 'first_synced_at' | 'last_synced_at' | 'deleted_at'
> &
  Partial<Pick<Product, 'deleted_at' | 'last_synced_at'>>;

/**
 * v1 never reprices gift cards or subscription products, and never touches a
 * variant that is not live (R22). One function so the rule cannot drift between
 * the forecast, the writer, and the UI.
 */
export function exclusionReasonFor(product: Product): ExclusionReason {
  if (product.is_gift_card) return 'gift_card';
  if (product.requires_selling_plan || product.has_selling_plan) return 'subscription';
  if (product.status !== 'ACTIVE' || product.deleted_at !== null) return 'not_active';
  if (product.price_cents <= 0) return 'zero_price';
  return null;
}

export function isRepriceable(product: Product): boolean {
  return exclusionReasonFor(product) === null;
}

// ---------------------------------------------------------------------------
// order_days
// ---------------------------------------------------------------------------

export interface OrderDay {
  shop_id: string;
  variant_gid: string;
  day: DayString;
  product_gid: string | null;
  units: number;
  orders: number;
  gross_revenue_cents: Cents;
  discount_cents: Cents;
  refund_units: number;
  refund_cents: Cents;
  net_revenue_cents: Cents;
  realized_unit_price_cents: Cents | null;
  /** The list price the shopper saw. Lane C's elasticity regressor. */
  list_price_cents: Cents | null;
  had_stockout: boolean;
  on_promo: boolean;
  source: 'sync' | 'webhook' | 'seed';
  created_at?: string;
  updated_at?: string;
}

export type OrderDayUpsert = Omit<OrderDay, 'shop_id' | 'created_at' | 'updated_at'>;

// ---------------------------------------------------------------------------
// rollouts
// ---------------------------------------------------------------------------

export type RolloutStatus =
  | 'draft'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'rolled_back'
  | 'cancelled';

export type RolloutEndReason =
  | 'completed'
  | 'guardrail_breach'
  | 'manual_rollback'
  | 'kill_switch'
  | 'external_change'
  | 'cancelled';

export interface Rollout {
  id: string;
  shop_id: string;
  name: string;
  status: RolloutStatus;
  change_type: 'percent' | 'absolute';
  change_pct: number | null;
  change_absolute_cents: Cents | null;
  rounding: Rounding;
  horizon_days: number;
  stages: StageSpec[];
  /** -1 = nothing live yet. */
  current_stage: number;
  stage_entered_at: string | null;
  guardrails: Guardrails;
  /** The forecast as of proposal time, so the report can be honest (R20/R30). */
  forecast: ForecastResult | null;
  scheduled_start_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  ended_reason: RolloutEndReason | null;
  paused_reason: string | null;
  notify_emails: string[];
  eval_lock_token: string | null;
  eval_locked_until: string | null;
  last_evaluated_at: string | null;
  last_evaluated_day: DayString | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type RolloutCreate = Omit<
  Rollout,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'eval_lock_token'
  | 'eval_locked_until'
  | 'last_evaluated_at'
  | 'last_evaluated_day'
  | 'stage_entered_at'
> &
  Partial<Pick<Rollout, 'stage_entered_at'>>;

export type RolloutPatch = Partial<
  Omit<Rollout, 'id' | 'shop_id' | 'created_at' | 'updated_at'>
>;

/** Baselines captured at creation — the single source of truth for rollback (R12). */
export interface RolloutVariant {
  id: string;
  rollout_id: string;
  shop_id: string;
  variant_gid: string;
  product_gid: string;
  title: string;
  sku: string | null;
  baseline_price_cents: Cents;
  baseline_compare_at_cents: Cents | null;
  target_price_cents: Cents;
  target_compare_at_cents: Cents | null;
  compare_at_action: 'keep' | 'clear' | 'none';
  baseline_units_per_day: number | null;
  cogs_cents_at_creation: Cents | null;
  /** Stage index from which this variant carries the new price. */
  cohort_stage: number;
  applied_price_cents: Cents | null;
  applied_at: string | null;
  reverted_at: string | null;
  excluded: boolean;
  exclusion_reason: ExclusionReason | 'external_change';
  created_at: string;
  updated_at: string;
}

export type RolloutVariantCreate = Omit<
  RolloutVariant,
  'id' | 'created_at' | 'updated_at' | 'applied_price_cents' | 'applied_at' | 'reverted_at'
> &
  Partial<Pick<RolloutVariant, 'applied_price_cents' | 'applied_at' | 'reverted_at'>>;

export type EvaluationDecision = 'none' | 'hold' | 'advance' | 'rollback' | 'pause' | 'complete';

export interface RolloutReading {
  id: string;
  rollout_id: string;
  shop_id: string;
  day: DayString;
  stage_index: number;
  actual_units: number;
  actual_orders: number;
  actual_revenue_cents: Cents;
  actual_profit_cents: Cents | null;
  expected_units: number;
  expected_low: number;
  expected_high: number;
  expected_source: 'model' | 'bracket';
  interval_nominal: number;
  model_version: string | null;
  band_stale: boolean;
  band_floored: boolean;
  breach_probability: number | null;
  breach: boolean;
  breach_rule_id: string | null;
  breach_reason: string | null;
  breach_streak: number;
  decision: EvaluationDecision;
  evaluated_at: string;
  created_at?: string;
}

export type RolloutReadingUpsert = Omit<RolloutReading, 'id' | 'created_at'>;

export type RolloutEventType =
  | 'created'
  | 'scheduled'
  | 'started'
  | 'stage_advanced'
  | 'held'
  | 'breach_detected'
  | 'auto_rollback'
  | 'manual_rollback'
  | 'kill_switch'
  | 'paused_external_change'
  | 'resumed'
  | 'completed'
  | 'cancelled'
  | 'price_write_failed'
  | 'evaluated'
  | 'note';

export interface RolloutEvent {
  id: string;
  rollout_id: string;
  shop_id: string;
  type: RolloutEventType;
  /** One sentence a merchant can read (R25). */
  message: string;
  actor: JournalActor;
  data: Record<string, unknown>;
  at: string;
  created_at?: string;
}

export type RolloutEventCreate = Omit<RolloutEvent, 'id' | 'created_at' | 'at'> &
  Partial<Pick<RolloutEvent, 'at'>>;

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

export interface JournalEntry {
  id: string;
  shop_id: string;
  variant_gid: string;
  product_gid: string;
  title: string;
  sku: string | null;
  rollout_id: string | null;
  stage_index: number | null;
  source: JournalSource;
  actor: JournalActor;
  reason: string | null;
  status: JournalStatus;
  before_price_cents: Cents;
  after_price_cents: Cents;
  before_compare_at_cents: Cents | null;
  after_compare_at_cents: Cents | null;
  currency: string;
  /** Same key = same intended write. Makes a retried stage safe (R12). */
  idempotency_key: string | null;
  error: string | null;
  shopify_user_errors: unknown;
  applied_at: string;
  created_at: string;
}

export type JournalEntryCreate = Omit<JournalEntry, 'id' | 'shop_id' | 'created_at'> &
  Partial<Pick<JournalEntry, 'created_at'>>;

export interface JournalFilter {
  variant_gids?: string[];
  rollout_id?: string;
  sources?: JournalSource[];
  from_day?: DayString;
  to_day?: DayString;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// webhooks & sync
// ---------------------------------------------------------------------------

export interface WebhookEventRecord {
  id: string;
  shop_domain: string;
  shop_id: string | null;
  topic: string;
  /** X-Shopify-Webhook-Id. The dedupe key. */
  webhook_id: string;
  api_version: string | null;
  triggered_at: string | null;
  received_at: string;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored' | 'duplicate';
  attempts: number;
  error: string | null;
  processed_at: string | null;
  payload: unknown;
  created_at?: string;
}

export type WebhookEventCreate = Pick<WebhookEventRecord, 'shop_domain' | 'topic' | 'webhook_id'> &
  Partial<Omit<WebhookEventRecord, 'id' | 'created_at' | 'received_at'>>;

export interface SyncRun {
  id: string;
  shop_id: string;
  kind: 'full' | 'catalog' | 'history' | 'baseline';
  stage: 'queued' | 'catalog' | 'history' | 'aggregating' | 'done' | 'error';
  message: string;
  products_total: number | null;
  products_synced: number;
  days_target: number;
  days_synced: number;
  orders_processed: number;
  catalog_ready_at: string | null;
  history_ready_at: string | null;
  eta_seconds: number | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: boolean | null;
  cursor: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SyncRunPatch = Partial<Omit<SyncRun, 'id' | 'shop_id' | 'created_at' | 'updated_at'>>;

// ---------------------------------------------------------------------------
// ML rows (written by Lane C, read here)
// ---------------------------------------------------------------------------

export interface ElasticityFitRow {
  id: string;
  shop_id: string;
  variant_gid: string;
  elasticity: number;
  se: number | null;
  /** Explicit credible bounds from Lane C; preferred over `se` when both present. */
  low: number | null;
  high: number | null;
  interval_nominal: number | null;
  n_obs: number;
  price_variation_pct: number;
  confidence: Confidence;
  confidence_explanation: string | null;
  method: string | null;
  shrinkage_weight: number | null;
  prior_elasticity: number | null;
  r2: number | null;
  model_version: string;
  model_run_id: string | null;
  window_start: DayString | null;
  window_end: DayString | null;
  fitted_at: string;
  created_at?: string;
}

export interface ExpectedBandRow {
  id: string;
  shop_id: string;
  variant_gid: string;
  day: DayString;
  expected_units: number;
  low: number;
  high: number;
  interval_nominal: number;
  band_kind: BandKind;
  rollout_id: string | null;
  breach_probability: number | null;
  is_floored: boolean;
  model_version: string;
  model_run_id: string | null;
  generated_at: string;
  created_at?: string;
}

export interface ModelRun {
  id: string;
  shop_id: string | null;
  kind: 'elasticity' | 'baseline' | 'counterfactual' | 'report';
  model_version: string;
  git_sha: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'rejected';
  gate_passed: boolean | null;
  incumbent_version: string | null;
  metrics: Record<string, unknown>;
  rows_written: number;
  /** Deterministic digest of the accepted request; makes response-loss retries idempotent. */
  ingest_key?: string | null;
  fits_written?: number;
  bands_written?: number;
  reports_written?: number;
  notes: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  created_at?: string;
}

/** Database representation of a validated rollout report contract. */
export interface RolloutReportRow extends RolloutReport {
  id: string;
  shop_id: string;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// query shapes
// ---------------------------------------------------------------------------

export interface ProductQuery {
  search?: string;
  product_types?: string[];
  vendors?: string[];
  /** Hide gift cards / subscription / inactive variants (R22). */
  only_repriceable?: boolean;
  missing_cogs?: boolean;
  sort?: 'title' | 'price_asc' | 'price_desc' | 'units_desc';
  limit?: number;
  offset?: number;
}

export interface OrderDayQuery {
  variant_gids?: string[];
  from_day?: DayString;
  to_day?: DayString;
}
