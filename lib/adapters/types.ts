/**
 * `StoreAdapter` — the seam between the engine and where state lives.
 *
 * Two implementations:
 *   - `DemoAdapter` — a simulated store, file-backed. This is the permanent sales
 *     demo and the test harness; it needs no Shopify account and no network.
 *   - `SupabaseAdapter` — the real thing.
 *
 * Everything above this interface (forecast, evaluator, price writer) is written
 * against the interface alone, so the demo path and the real path exercise the
 * *same* engine code. A bug that only appears in one of them is a bug in an
 * adapter, not in the product.
 *
 * Rules for implementors:
 *   - Every method that touches shop data takes a `shopId`. There is no ambient
 *     current shop, because a cross-shop leak must require a visible mistake.
 *   - Writes that the engine may retry are idempotent (journal entries by
 *     `idempotency_key`, readings by `(rollout_id, day)`, webhooks by
 *     `webhook_id`).
 *   - Money in and out is integer cents. Adapters never round.
 */

import type { DayString } from '../dates';
import type { Cents } from '../money';
import type { Confidence } from '../contracts';
import type {
  ElasticityFitRow,
  ExpectedBandRow,
  JournalEntry,
  JournalEntryCreate,
  JournalFilter,
  ModelRun,
  OrderDay,
  OrderDayQuery,
  OrderDayUpsert,
  Product,
  ProductQuery,
  ProductUpsert,
  Rollout,
  RolloutCreate,
  RolloutEvent,
  RolloutEventCreate,
  RolloutPatch,
  RolloutReading,
  RolloutReadingUpsert,
  RolloutStatus,
  RolloutVariant,
  RolloutVariantCreate,
  Shop,
  ShopUpsert,
  SyncRun,
  SyncRunPatch,
  WebhookEventCreate,
  WebhookEventRecord,
} from '../types';

export type AdapterKind = 'demo' | 'supabase';

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface LockResult<T> {
  acquired: boolean;
  /** Present only when `acquired` is true. */
  result?: T;
}

export interface StoreAdapter {
  readonly kind: AdapterKind;

  /** Cheap reachability check for `GET /api/health`. */
  ping(): Promise<{ ok: boolean; detail?: string }>;

  // -- shops ---------------------------------------------------------------
  getShopByDomain(shopDomain: string): Promise<Shop | null>;
  getShop(shopId: string): Promise<Shop | null>;
  listShops(): Promise<Shop[]>;
  upsertShop(input: ShopUpsert): Promise<Shop>;
  updateShop(shopId: string, patch: Partial<ShopUpsert>): Promise<Shop>;

  // -- catalog -------------------------------------------------------------
  listProducts(shopId: string, query?: ProductQuery): Promise<Paged<Product>>;
  getProductsByVariantGids(shopId: string, variantGids: readonly string[]): Promise<Product[]>;
  upsertProducts(shopId: string, products: readonly ProductUpsert[]): Promise<number>;
  setCogs(shopId: string, variantGid: string, cogsCents: Cents | null, source: 'shopify' | 'manual'): Promise<Product>;
  /** Marks variants absent from a full sync as deleted rather than dropping rows. */
  markProductsDeleted(shopId: string, variantGids: readonly string[]): Promise<number>;

  // -- order history -------------------------------------------------------
  getOrderDays(shopId: string, query?: OrderDayQuery): Promise<OrderDay[]>;
  upsertOrderDays(shopId: string, rows: readonly OrderDayUpsert[]): Promise<number>;

  // -- rollouts ------------------------------------------------------------
  createRollout(input: RolloutCreate): Promise<Rollout>;
  getRollout(rolloutId: string): Promise<Rollout | null>;
  listRollouts(shopId: string, statuses?: readonly RolloutStatus[]): Promise<Rollout[]>;
  /** Active across every shop — what the evaluator cron iterates. */
  listActiveRollouts(): Promise<Rollout[]>;
  updateRollout(rolloutId: string, patch: RolloutPatch): Promise<Rollout>;

  insertRolloutVariants(rows: readonly RolloutVariantCreate[]): Promise<number>;
  getRolloutVariants(rolloutId: string): Promise<RolloutVariant[]>;
  updateRolloutVariant(id: string, patch: Partial<RolloutVariant>): Promise<RolloutVariant>;

  /** Idempotent on `(rollout_id, day)` — a same-day re-run updates, never duplicates. */
  upsertRolloutReading(row: RolloutReadingUpsert): Promise<RolloutReading>;
  listRolloutReadings(rolloutId: string): Promise<RolloutReading[]>;

  appendRolloutEvent(event: RolloutEventCreate): Promise<RolloutEvent>;
  listRolloutEvents(rolloutId: string, limit?: number): Promise<RolloutEvent[]>;

  /**
   * Serialise evaluation of one rollout. Returns `acquired: false` rather than
   * throwing or waiting: two evaluators disagreeing about a stage advance is the
   * problem, and the loser has nothing useful to do but skip this tick.
   */
  withRolloutLock<T>(rolloutId: string, fn: () => Promise<T>, ttlSeconds?: number): Promise<LockResult<T>>;

  // -- journal -------------------------------------------------------------
  /** Append-only. Entries whose `idempotency_key` already exists are skipped. */
  appendJournalEntries(shopId: string, entries: readonly JournalEntryCreate[]): Promise<JournalEntry[]>;
  listJournalEntries(shopId: string, filter?: JournalFilter): Promise<Paged<JournalEntry>>;
  /** Latest applied price per variant according to the journal — the recovery read. */
  getLastJournaledPrice(shopId: string, variantGid: string): Promise<JournalEntry | null>;

  // -- webhooks ------------------------------------------------------------
  /** `duplicate: true` means this webhook id has been seen; do not process again. */
  recordWebhook(event: WebhookEventCreate): Promise<{ duplicate: boolean; record: WebhookEventRecord }>;
  markWebhookProcessed(webhookId: string, status: 'processed' | 'failed' | 'ignored', error?: string): Promise<void>;

  // -- sync ----------------------------------------------------------------
  createSyncRun(shopId: string, kind?: SyncRun['kind']): Promise<SyncRun>;
  getLatestSyncRun(shopId: string): Promise<SyncRun | null>;
  updateSyncRun(syncRunId: string, patch: SyncRunPatch): Promise<SyncRun>;

  // -- ML outputs (written by Lane C, read here) ---------------------------
  getLatestFits(shopId: string, variantGids?: readonly string[]): Promise<Map<string, ElasticityFitRow>>;
  getExpectedBands(
    shopId: string,
    query: { variantGids?: readonly string[]; fromDay: DayString; toDay: DayString; rolloutId?: string | null },
  ): Promise<ExpectedBandRow[]>;
  listModelRuns(shopId: string | null, limit?: number): Promise<ModelRun[]>;

  /** Test/seed only: lets the demo adapter stand in for Lane C's writes. */
  upsertFits?(shopId: string, fits: readonly Omit<ElasticityFitRow, 'id'>[]): Promise<number>;
  upsertExpectedBands?(shopId: string, bands: readonly Omit<ExpectedBandRow, 'id'>[]): Promise<number>;
}

/** Confidence tier of a fit as stored, before any staleness demotion. */
export function fitConfidence(fit: ElasticityFitRow | undefined): Confidence {
  return fit?.confidence ?? 'assumption';
}
