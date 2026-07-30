/**
 * `DemoAdapter` — the simulated store. Server-only.
 *
 * This ships permanently: it is the sales demo (the whole loop with no Shopify
 * account) and the test harness (a deterministic store the smoke test can drive).
 * It persists to a JSON file so that state survives a restart, because a demo
 * that forgets the rollout you started is not a demo of this product.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated state file behind. Reads and writes deep-copy, so a caller holding a
 * returned object cannot reach in and mutate the store.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { getDemoStatePath } from '../config';
import { nowIso, type DayString } from '../dates';
import type { Cents } from '../money';
import { parseMoneyToCents } from '../money';
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
import { DEMO_SHOP_DOMAIN, generateDemoStore } from '../demo/generator';
import DEMO_FITS from '../demo/elasticity-fits.json';
import type { LockResult, Paged, StoreAdapter } from './types';

const STATE_VERSION = 2;

interface DemoState {
  version: number;
  shops: Shop[];
  products: Product[];
  orderDays: OrderDay[];
  rollouts: Rollout[];
  rolloutVariants: RolloutVariant[];
  readings: RolloutReading[];
  events: RolloutEvent[];
  journal: JournalEntry[];
  webhooks: WebhookEventRecord[];
  syncRuns: SyncRun[];
  fits: ElasticityFitRow[];
  bands: ExpectedBandRow[];
  modelRuns: ModelRun[];
  locks: Record<string, { token: string; until: string }>;
}

function emptyState(): DemoState {
  return {
    version: STATE_VERSION,
    shops: [],
    products: [],
    orderDays: [],
    rollouts: [],
    rolloutVariants: [],
    readings: [],
    events: [],
    journal: [],
    webhooks: [],
    syncRuns: [],
    fits: [],
    bands: [],
    modelRuns: [],
    locks: {},
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export interface DemoAdapterOptions {
  /** Where to persist. Ignored when `persist` is false. */
  statePath?: string;
  /** false = in-memory only, for tests that want a clean store every run. */
  persist?: boolean;
  /** Seed the demo catalog and 180 days of history when the store is empty. */
  autoSeed?: boolean;
  seed?: number;
}

export class DemoAdapter implements StoreAdapter {
  readonly kind = 'demo' as const;

  private state: DemoState;
  private readonly statePath: string | null;
  private readonly autoSeed: boolean;
  private readonly seedValue: number | undefined;

  constructor(options: DemoAdapterOptions = {}) {
    const persist = options.persist ?? true;
    this.statePath = persist ? resolve(options.statePath ?? getDemoStatePath()) : null;
    this.autoSeed = options.autoSeed ?? true;
    this.seedValue = options.seed;
    this.state = this.load();

    if (this.autoSeed && this.state.shops.length === 0) {
      this.seedDemoStore();
    }
  }

  /** In-memory adapter for tests: deterministic, no file IO, no cleanup. */
  static ephemeral(seed?: number): DemoAdapter {
    return new DemoAdapter({ persist: false, autoSeed: true, seed });
  }

  // -- persistence ---------------------------------------------------------

  private load(): DemoState {
    if (this.statePath === null || !existsSync(this.statePath)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<DemoState>;
      if (parsed.version !== STATE_VERSION) {
        // No migration path for a demo store: regenerating is cheap and correct,
        // and silently reading a stale shape would be worse.
        return emptyState();
      }
      return { ...emptyState(), ...parsed, version: STATE_VERSION };
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    if (this.statePath === null) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    // Rename is atomic on the same filesystem, so a reader never sees a partial file.
    renameSync(temporary, this.statePath);
  }

  /** Wipe everything. Only the demo adapter gets to have this. */
  reset(options: { seed?: boolean } = {}): void {
    this.state = emptyState();
    if (options.seed ?? this.autoSeed) this.seedDemoStore();
    else this.save();
  }

  /** Load the generated demo store: shop, catalog, 180 days of history, journal. */
  seedDemoStore(seed?: number): Shop {
    const store = generateDemoStore({ seed: seed ?? this.seedValue });
    const now = nowIso();

    const shop: Shop = {
      id: randomUUID(),
      shop_domain: store.shop.shop_domain,
      name: store.shop.name ?? null,
      email: store.shop.email ?? null,
      access_token_enc: null,
      scopes: store.shop.scopes ?? null,
      api_version: store.shop.api_version ?? '2026-07',
      currency: store.shop.currency ?? 'USD',
      timezone: store.shop.timezone ?? 'UTC',
      plan_name: store.shop.plan_name ?? null,
      mode: 'demo',
      kill_switch_engaged_at: null,
      kill_switch_reason: null,
      notify_emails: store.shop.notify_emails ?? [],
      installed_at: store.shop.installed_at ?? now,
      uninstalled_at: null,
      created_at: now,
      updated_at: now,
    };

    this.state.shops = [shop];
    this.state.products = store.products.map((product) => ({
      ...product,
      id: randomUUID(),
      shop_id: shop.id,
      first_synced_at: now,
      last_synced_at: now,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }));
    this.state.orderDays = store.orderDays.map((row) => ({
      ...row,
      shop_id: shop.id,
      created_at: now,
      updated_at: now,
    }));

    // Seed the journal from the generated price history so the price trail is
    // complete from day one — the journal is meant to be the whole story.
    this.state.journal = store.priceHistory.map((change) => ({
      id: randomUUID(),
      shop_id: shop.id,
      variant_gid: change.variant_gid,
      product_gid: change.product_gid,
      title: change.title,
      sku: change.sku,
      rollout_id: null,
      stage_index: null,
      source: 'seed' as const,
      actor: 'system' as const,
      reason: 'Price change from before the store was connected.',
      status: 'applied' as const,
      before_price_cents: change.before_price_cents,
      after_price_cents: change.after_price_cents,
      before_compare_at_cents: null,
      after_compare_at_cents: null,
      currency: shop.currency,
      idempotency_key: null,
      error: null,
      shopify_user_errors: null,
      applied_at: `${change.day}T12:00:00.000Z`,
      created_at: now,
    }));

    const syncRun: SyncRun = {
      id: randomUUID(),
      shop_id: shop.id,
      kind: 'full',
      stage: 'done',
      message: `Loaded ${this.state.products.length} products and ${store.window.days} days of order history.`,
      products_total: this.state.products.length,
      products_synced: this.state.products.length,
      days_target: store.window.days,
      days_synced: store.window.days,
      orders_processed: this.state.orderDays.reduce((sum, row) => sum + row.orders, 0),
      catalog_ready_at: now,
      history_ready_at: now,
      eta_seconds: 0,
      error_code: null,
      error_message: null,
      error_retryable: null,
      cursor: {},
      started_at: now,
      finished_at: now,
      created_at: now,
      updated_at: now,
    };
    this.state.syncRuns = [syncRun];

    this.save();
    return clone(shop);
  }

  /** Ground truth for the generated store — Lane C's harness fixture. */
  demoTruth(seed?: number): ReturnType<typeof generateDemoStore>['truth'] {
    return generateDemoStore({ seed: seed ?? this.seedValue }).truth;
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    return {
      ok: true,
      detail: this.statePath === null ? 'in-memory demo store' : `demo store at ${this.statePath}`,
    };
  }

  // -- shops ---------------------------------------------------------------

  async getShopByDomain(shopDomain: string): Promise<Shop | null> {
    const shop = this.state.shops.find((row) => row.shop_domain === shopDomain.toLowerCase());
    return shop ? clone(shop) : null;
  }

  async getShop(shopId: string): Promise<Shop | null> {
    const shop = this.state.shops.find((row) => row.id === shopId);
    return shop ? clone(shop) : null;
  }

  async listShops(): Promise<Shop[]> {
    return clone(this.state.shops);
  }

  async upsertShop(input: ShopUpsert): Promise<Shop> {
    const domain = input.shop_domain.toLowerCase();
    const now = nowIso();
    const existing = this.state.shops.find((row) => row.shop_domain === domain);

    if (existing) {
      Object.assign(existing, stripUndefined(input), { shop_domain: domain, updated_at: now });
      this.save();
      return clone(existing);
    }

    const shop: Shop = {
      id: randomUUID(),
      name: null,
      email: null,
      access_token_enc: null,
      scopes: null,
      api_version: '2026-07',
      currency: 'USD',
      timezone: 'UTC',
      plan_name: null,
      mode: 'demo',
      kill_switch_engaged_at: null,
      kill_switch_reason: null,
      notify_emails: [],
      installed_at: now,
      uninstalled_at: null,
      created_at: now,
      updated_at: now,
      ...stripUndefined(input),
      shop_domain: domain,
    };
    this.state.shops.push(shop);
    this.save();
    return clone(shop);
  }

  async updateShop(shopId: string, patch: Partial<ShopUpsert>): Promise<Shop> {
    const shop = this.state.shops.find((row) => row.id === shopId);
    if (!shop) throw new Error(`unknown shop ${shopId}`);
    Object.assign(shop, stripUndefined(patch), { updated_at: nowIso() });
    this.save();
    return clone(shop);
  }

  // -- catalog -------------------------------------------------------------

  async listProducts(shopId: string, query: ProductQuery = {}): Promise<Paged<Product>> {
    let items = this.state.products.filter((row) => row.shop_id === shopId && row.deleted_at === null);

    if (query.search) {
      const needle = query.search.toLowerCase();
      items = items.filter((row) =>
        [row.title, row.variant_title, row.sku, row.vendor].some(
          (field) => field !== null && field !== undefined && field.toLowerCase().includes(needle),
        ),
      );
    }
    if (query.product_types?.length) {
      items = items.filter((row) => row.product_type !== null && query.product_types?.includes(row.product_type));
    }
    if (query.vendors?.length) {
      items = items.filter((row) => row.vendor !== null && query.vendors?.includes(row.vendor));
    }
    if (query.only_repriceable) {
      items = items.filter(
        (row) =>
          !row.is_gift_card &&
          !row.requires_selling_plan &&
          !row.has_selling_plan &&
          row.status === 'ACTIVE' &&
          row.price_cents > 0,
      );
    }
    if (query.missing_cogs) {
      items = items.filter((row) => row.cogs_cents === null);
    }

    const total = items.length;

    const unitsByVariant = new Map<string, number>();
    if (query.sort === 'units_desc') {
      for (const row of this.state.orderDays) {
        if (row.shop_id !== shopId) continue;
        unitsByVariant.set(row.variant_gid, (unitsByVariant.get(row.variant_gid) ?? 0) + row.units);
      }
    }

    items.sort((a, b) => {
      switch (query.sort) {
        case 'price_asc':
          return a.price_cents - b.price_cents;
        case 'price_desc':
          return b.price_cents - a.price_cents;
        case 'units_desc':
          return (unitsByVariant.get(b.variant_gid) ?? 0) - (unitsByVariant.get(a.variant_gid) ?? 0);
        default:
          return `${a.title}${a.variant_title ?? ''}`.localeCompare(`${b.title}${b.variant_title ?? ''}`);
      }
    });

    const offset = query.offset ?? 0;
    const limit = query.limit ?? items.length;
    return { items: clone(items.slice(offset, offset + limit)), total };
  }

  async getProductsByVariantGids(shopId: string, variantGids: readonly string[]): Promise<Product[]> {
    const wanted = new Set(variantGids);
    return clone(
      this.state.products.filter((row) => row.shop_id === shopId && wanted.has(row.variant_gid)),
    );
  }

  async upsertProducts(shopId: string, products: readonly ProductUpsert[]): Promise<number> {
    const now = nowIso();
    for (const input of products) {
      const existing = this.state.products.find(
        (row) => row.shop_id === shopId && row.variant_gid === input.variant_gid,
      );
      if (existing) {
        Object.assign(existing, stripUndefined(input), { last_synced_at: now, updated_at: now, deleted_at: null });
      } else {
        this.state.products.push({
          ...input,
          id: randomUUID(),
          shop_id: shopId,
          first_synced_at: now,
          last_synced_at: now,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        });
      }
    }
    this.save();
    return products.length;
  }

  async setCogs(
    shopId: string,
    variantGid: string,
    cogsCents: Cents | null,
    source: 'shopify' | 'manual',
  ): Promise<Product> {
    const product = this.state.products.find(
      (row) => row.shop_id === shopId && row.variant_gid === variantGid,
    );
    if (!product) throw new Error(`unknown variant ${variantGid}`);

    product.cogs_cents = cogsCents;
    // Clearing a cost sets the source back to `none`; the constraint in the
    // migration says the two must agree, so keep them agreeing here too.
    product.cogs_source = cogsCents === null ? 'none' : source;
    product.cogs_updated_at = cogsCents === null ? null : nowIso();
    product.updated_at = nowIso();
    this.save();
    return clone(product);
  }

  async markProductsDeleted(shopId: string, variantGids: readonly string[]): Promise<number> {
    const wanted = new Set(variantGids);
    let count = 0;
    for (const product of this.state.products) {
      if (product.shop_id === shopId && wanted.has(product.variant_gid) && product.deleted_at === null) {
        product.deleted_at = nowIso();
        product.updated_at = product.deleted_at;
        count += 1;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  // -- order history -------------------------------------------------------

  async getOrderDays(shopId: string, query: OrderDayQuery = {}): Promise<OrderDay[]> {
    const wanted = query.variant_gids ? new Set(query.variant_gids) : null;
    const rows = this.state.orderDays.filter((row) => {
      if (row.shop_id !== shopId) return false;
      if (wanted && !wanted.has(row.variant_gid)) return false;
      if (query.from_day && row.day < query.from_day) return false;
      if (query.to_day && row.day > query.to_day) return false;
      return true;
    });
    rows.sort((a, b) => (a.day === b.day ? a.variant_gid.localeCompare(b.variant_gid) : a.day.localeCompare(b.day)));
    return clone(rows);
  }

  async upsertOrderDays(shopId: string, rows: readonly OrderDayUpsert[]): Promise<number> {
    const now = nowIso();
    for (const input of rows) {
      const existing = this.state.orderDays.find(
        (row) => row.shop_id === shopId && row.variant_gid === input.variant_gid && row.day === input.day,
      );
      if (existing) Object.assign(existing, input, { shop_id: shopId, updated_at: now });
      else this.state.orderDays.push({ ...input, shop_id: shopId, created_at: now, updated_at: now });
    }
    this.save();
    return rows.length;
  }

  // -- rollouts ------------------------------------------------------------

  async createRollout(input: RolloutCreate): Promise<Rollout> {
    const now = nowIso();
    const rollout: Rollout = {
      ...input,
      id: randomUUID(),
      stage_entered_at: input.stage_entered_at ?? null,
      eval_lock_token: null,
      eval_locked_until: null,
      last_evaluated_at: null,
      last_evaluated_day: null,
      created_at: now,
      updated_at: now,
    };
    this.state.rollouts.push(rollout);
    this.save();
    return clone(rollout);
  }

  async getRollout(rolloutId: string): Promise<Rollout | null> {
    const rollout = this.state.rollouts.find((row) => row.id === rolloutId);
    return rollout ? clone(rollout) : null;
  }

  async listRollouts(shopId: string, statuses?: readonly RolloutStatus[]): Promise<Rollout[]> {
    const rows = this.state.rollouts.filter(
      (row) => row.shop_id === shopId && (!statuses || statuses.includes(row.status)),
    );
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return clone(rows);
  }

  async listActiveRollouts(): Promise<Rollout[]> {
    const active: RolloutStatus[] = ['running', 'scheduled', 'paused'];
    return clone(this.state.rollouts.filter((row) => active.includes(row.status)));
  }

  async updateRollout(rolloutId: string, patch: RolloutPatch): Promise<Rollout> {
    const rollout = this.state.rollouts.find((row) => row.id === rolloutId);
    if (!rollout) throw new Error(`unknown rollout ${rolloutId}`);
    Object.assign(rollout, stripUndefined(patch), { updated_at: nowIso() });
    this.save();
    return clone(rollout);
  }

  async insertRolloutVariants(rows: readonly RolloutVariantCreate[]): Promise<number> {
    const now = nowIso();
    for (const input of rows) {
      const existing = this.state.rolloutVariants.find(
        (row) => row.rollout_id === input.rollout_id && row.variant_gid === input.variant_gid,
      );
      if (existing) {
        Object.assign(existing, stripUndefined(input), { updated_at: now });
        continue;
      }
      this.state.rolloutVariants.push({
        applied_price_cents: null,
        applied_at: null,
        reverted_at: null,
        ...input,
        id: randomUUID(),
        created_at: now,
        updated_at: now,
      });
    }
    this.save();
    return rows.length;
  }

  async getRolloutVariants(rolloutId: string): Promise<RolloutVariant[]> {
    const rows = this.state.rolloutVariants.filter((row) => row.rollout_id === rolloutId);
    rows.sort((a, b) =>
      a.cohort_stage === b.cohort_stage ? a.variant_gid.localeCompare(b.variant_gid) : a.cohort_stage - b.cohort_stage,
    );
    return clone(rows);
  }

  async updateRolloutVariant(id: string, patch: Partial<RolloutVariant>): Promise<RolloutVariant> {
    const row = this.state.rolloutVariants.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`unknown rollout variant ${id}`);
    Object.assign(row, stripUndefined(patch), { updated_at: nowIso() });
    this.save();
    return clone(row);
  }

  async upsertRolloutReading(input: RolloutReadingUpsert): Promise<RolloutReading> {
    const existing = this.state.readings.find(
      (row) => row.rollout_id === input.rollout_id && row.day === input.day,
    );
    if (existing) {
      // Same (rollout, day) updates in place: this is what makes a second
      // evaluation on the same day a no-op rather than a double count.
      Object.assign(existing, input);
      this.save();
      return clone(existing);
    }
    const reading: RolloutReading = { ...input, id: randomUUID(), created_at: nowIso() };
    this.state.readings.push(reading);
    this.save();
    return clone(reading);
  }

  async listRolloutReadings(rolloutId: string): Promise<RolloutReading[]> {
    const rows = this.state.readings.filter((row) => row.rollout_id === rolloutId);
    rows.sort((a, b) => a.day.localeCompare(b.day));
    return clone(rows);
  }

  async appendRolloutEvent(event: RolloutEventCreate): Promise<RolloutEvent> {
    const row: RolloutEvent = {
      ...event,
      id: randomUUID(),
      at: event.at ?? nowIso(),
      created_at: nowIso(),
    };
    this.state.events.push(row);
    this.save();
    return clone(row);
  }

  async listRolloutEvents(rolloutId: string, limit = 200): Promise<RolloutEvent[]> {
    const rows = this.state.events.filter((row) => row.rollout_id === rolloutId);
    rows.sort((a, b) => b.at.localeCompare(a.at));
    return clone(rows.slice(0, limit));
  }

  async withRolloutLock<T>(rolloutId: string, fn: () => Promise<T>, ttlSeconds = 300): Promise<LockResult<T>> {
    const existing = this.state.locks[rolloutId];
    const now = Date.now();
    if (existing && Date.parse(existing.until) > now) return { acquired: false };

    const token = randomUUID();
    this.state.locks[rolloutId] = { token, until: new Date(now + ttlSeconds * 1000).toISOString() };
    this.save();

    try {
      return { acquired: true, result: await fn() };
    } finally {
      // Only clear our own lease — a lease that expired and was retaken by
      // another evaluator must not be released from under it.
      if (this.state.locks[rolloutId]?.token === token) {
        delete this.state.locks[rolloutId];
        this.save();
      }
    }
  }

  // -- journal -------------------------------------------------------------

  async appendJournalEntries(shopId: string, entries: readonly JournalEntryCreate[]): Promise<JournalEntry[]> {
    const written: JournalEntry[] = [];
    const now = nowIso();

    for (const entry of entries) {
      if (entry.idempotency_key !== null && entry.idempotency_key !== undefined) {
        const duplicate = this.state.journal.find(
          (row) => row.shop_id === shopId && row.idempotency_key === entry.idempotency_key,
        );
        // Same intended write, already recorded. Skipping is the whole point.
        if (duplicate) continue;
      }
      const row: JournalEntry = { ...entry, id: randomUUID(), shop_id: shopId, created_at: entry.created_at ?? now };
      this.state.journal.push(row);
      written.push(row);
    }

    if (written.length > 0) this.save();
    return clone(written);
  }

  async listJournalEntries(shopId: string, filter: JournalFilter = {}): Promise<Paged<JournalEntry>> {
    const wanted = filter.variant_gids ? new Set(filter.variant_gids) : null;
    let rows = this.state.journal.filter((row) => {
      if (row.shop_id !== shopId) return false;
      if (wanted && !wanted.has(row.variant_gid)) return false;
      if (filter.rollout_id && row.rollout_id !== filter.rollout_id) return false;
      if (filter.sources?.length && !filter.sources.includes(row.source)) return false;
      if (filter.from_day && row.applied_at.slice(0, 10) < filter.from_day) return false;
      if (filter.to_day && row.applied_at.slice(0, 10) > filter.to_day) return false;
      return true;
    });

    rows.sort((a, b) => b.applied_at.localeCompare(a.applied_at));
    const total = rows.length;
    const offset = filter.offset ?? 0;
    rows = rows.slice(offset, offset + (filter.limit ?? rows.length));
    return { items: clone(rows), total };
  }

  async getLastJournaledPrice(shopId: string, variantGid: string): Promise<JournalEntry | null> {
    const rows = this.state.journal
      .filter((row) => row.shop_id === shopId && row.variant_gid === variantGid && row.status === 'applied')
      .sort((a, b) => b.applied_at.localeCompare(a.applied_at));
    return rows.length > 0 ? clone(rows[0] as JournalEntry) : null;
  }

  // -- webhooks ------------------------------------------------------------

  async recordWebhook(
    event: WebhookEventCreate,
  ): Promise<{ duplicate: boolean; record: WebhookEventRecord }> {
    const existing = this.state.webhooks.find((row) => row.webhook_id === event.webhook_id);
    if (existing) return { duplicate: true, record: clone(existing) };

    const record: WebhookEventRecord = {
      shop_id: null,
      api_version: null,
      triggered_at: null,
      status: 'received',
      attempts: 0,
      error: null,
      processed_at: null,
      payload: null,
      ...event,
      id: randomUUID(),
      received_at: nowIso(),
      created_at: nowIso(),
    };
    this.state.webhooks.push(record);
    this.save();
    return { duplicate: false, record: clone(record) };
  }

  async markWebhookProcessed(
    webhookId: string,
    status: 'processed' | 'failed' | 'ignored',
    error?: string,
  ): Promise<void> {
    const record = this.state.webhooks.find((row) => row.webhook_id === webhookId);
    if (!record) return;
    record.status = status;
    record.processed_at = nowIso();
    record.attempts += 1;
    record.error = error ?? null;
    this.save();
  }

  // -- sync ----------------------------------------------------------------

  async createSyncRun(shopId: string, kind: SyncRun['kind'] = 'full'): Promise<SyncRun> {
    const now = nowIso();
    const run: SyncRun = {
      id: randomUUID(),
      shop_id: shopId,
      kind,
      stage: 'queued',
      message: 'Getting ready…',
      products_total: null,
      products_synced: 0,
      days_target: 180,
      days_synced: 0,
      orders_processed: 0,
      catalog_ready_at: null,
      history_ready_at: null,
      eta_seconds: null,
      error_code: null,
      error_message: null,
      error_retryable: null,
      cursor: {},
      started_at: now,
      finished_at: null,
      created_at: now,
      updated_at: now,
    };
    this.state.syncRuns.push(run);
    this.save();
    return clone(run);
  }

  async getLatestSyncRun(shopId: string): Promise<SyncRun | null> {
    // Ties on started_at are broken by insertion order, later wins. Two runs can
    // land in the same millisecond, and a sort alone would then return whichever
    // the stable sort happened to keep — meaning a fresh sync could report the
    // previous run's progress.
    let latest: SyncRun | null = null;
    for (const row of this.state.syncRuns) {
      if (row.shop_id !== shopId) continue;
      if (latest === null || row.started_at >= latest.started_at) latest = row;
    }
    return latest === null ? null : clone(latest);
  }

  async updateSyncRun(syncRunId: string, patch: SyncRunPatch): Promise<SyncRun> {
    const run = this.state.syncRuns.find((row) => row.id === syncRunId);
    if (!run) throw new Error(`unknown sync run ${syncRunId}`);
    Object.assign(run, stripUndefined(patch), { updated_at: nowIso() });
    this.save();
    return clone(run);
  }

  // -- ML outputs ----------------------------------------------------------

  async getLatestFits(shopId: string, variantGids?: readonly string[]): Promise<Map<string, ElasticityFitRow>> {
    const wanted = variantGids ? new Set(variantGids) : null;
    const latest = new Map<string, ElasticityFitRow>();

    for (const fit of this.state.fits) {
      if (fit.shop_id !== shopId) continue;
      if (wanted && !wanted.has(fit.variant_gid)) continue;
      const current = latest.get(fit.variant_gid);
      if (!current || fit.fitted_at > current.fitted_at) latest.set(fit.variant_gid, clone(fit));
    }

    // REQ-A-006: demo mode could never reach a fitted range, so the band A3
    // renders could not be seen without a database. These come from a real run of
    // Lane C's fitter over the demo store's OBSERVABLE columns
    // (scripts/seed-demo-fits.ts) — never from `generateDemoStore().truth`, which
    // would be the ground-truth leak CLAUDE.md forbids.
    //
    // Applied only where nothing was written explicitly: a fit that a caller
    // stored is real intent and must always win over the built-in fixture,
    // regardless of timestamps.
    for (const fit of demoFits(shopId)) {
      if (wanted && !wanted.has(fit.variant_gid)) continue;
      if (!latest.has(fit.variant_gid)) latest.set(fit.variant_gid, fit);
    }

    return latest;
  }

  async getExpectedBands(
    shopId: string,
    query: { variantGids?: readonly string[]; fromDay: DayString; toDay: DayString; rolloutId?: string | null },
  ): Promise<ExpectedBandRow[]> {
    const wanted = query.variantGids ? new Set(query.variantGids) : null;
    const rows = this.state.bands.filter((row) => {
      if (row.shop_id !== shopId) return false;
      if (wanted && !wanted.has(row.variant_gid)) return false;
      if (row.day < query.fromDay || row.day > query.toDay) return false;
      if (query.rolloutId !== undefined && row.rollout_id !== query.rolloutId) return false;
      return true;
    });
    rows.sort((a, b) => (a.day === b.day ? a.variant_gid.localeCompare(b.variant_gid) : a.day.localeCompare(b.day)));
    return clone(rows);
  }

  async listModelRuns(shopId: string | null, limit = 50): Promise<ModelRun[]> {
    const rows = this.state.modelRuns
      .filter((row) => (shopId === null ? true : row.shop_id === shopId))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
    return clone(rows.slice(0, limit));
  }

  async recordModelRun(
    input: Omit<ModelRun, 'id' | 'started_at' | 'created_at'> & { started_at?: string },
  ): Promise<ModelRun> {
    const row: ModelRun = {
      ...input,
      id: randomUUID(),
      started_at: input.started_at ?? nowIso(),
      created_at: nowIso(),
    };
    this.state.modelRuns.push(row);
    this.save();
    return clone(row);
  }

  async updateModelRun(id: string, patch: Partial<Omit<ModelRun, 'id'>>): Promise<ModelRun> {
    const row = this.state.modelRuns.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`unknown model run ${id}`);
    Object.assign(row, stripUndefined(patch));
    this.save();
    return clone(row);
  }

  /** Stands in for Lane C's writes so the fitted path is testable without Python. */
  async upsertFits(shopId: string, fits: readonly Omit<ElasticityFitRow, 'id'>[]): Promise<number> {
    for (const fit of fits) {
      const existing = this.state.fits.find(
        (row) =>
          row.shop_id === shopId &&
          row.variant_gid === fit.variant_gid &&
          row.model_version === fit.model_version,
      );
      if (existing) Object.assign(existing, fit, { shop_id: shopId });
      else this.state.fits.push({ ...fit, shop_id: shopId, id: randomUUID() });
    }
    this.save();
    return fits.length;
  }

  async upsertExpectedBands(shopId: string, bands: readonly Omit<ExpectedBandRow, 'id'>[]): Promise<number> {
    for (const band of bands) {
      const existing = this.state.bands.find(
        (row) =>
          row.shop_id === shopId &&
          row.variant_gid === band.variant_gid &&
          row.day === band.day &&
          row.band_kind === band.band_kind &&
          row.model_version === band.model_version &&
          (row.rollout_id ?? null) === (band.rollout_id ?? null),
      );
      if (existing) Object.assign(existing, band, { shop_id: shopId });
      else this.state.bands.push({ ...band, shop_id: shopId, id: randomUUID() });
    }
    this.save();
    return bands.length;
  }

  /** Test helper: the demo shop, seeding it first if the store is empty. */
  async demoShop(): Promise<Shop> {
    const shop = await this.getShopByDomain(DEMO_SHOP_DOMAIN);
    return shop ?? this.seedDemoStore();
  }

  /** Test helper: parse a money string the way the seed data does. */
  static cents(value: string): Cents {
    return parseMoneyToCents(value);
  }
}

/**
 * The committed fixture from `scripts/seed-demo-fits.ts`, as adapter rows.
 *
 * `fitted_at` is rewritten to "now" on read: the fixture is generated once and
 * committed, but the staleness rule (R32) would demote it to `partial` and then
 * `assumption` as the file aged, so demo mode would silently stop demonstrating
 * the very tier this exists to show.
 */
function demoFits(shopId: string): ElasticityFitRow[] {
  const now = nowIso();
  return (DEMO_FITS as unknown as Record<string, unknown>[]).map((fit, index) => ({
    id: `demo-fit-${index}`,
    shop_id: shopId,
    variant_gid: String(fit.variant_gid),
    elasticity: Number(fit.elasticity),
    se: fit.se === null || fit.se === undefined ? null : Number(fit.se),
    // Lane C's `fits_contract_rows` deliberately does not emit credible bounds,
    // so the served range falls back to `elasticity ± z·se`.
    low: fit.low === null || fit.low === undefined ? null : Number(fit.low),
    high: fit.high === null || fit.high === undefined ? null : Number(fit.high),
    interval_nominal: fit.interval === null || fit.interval === undefined ? null : Number(fit.interval),
    n_obs: Number(fit.n_obs ?? 0),
    price_variation_pct: Number(fit.price_variation_pct ?? 0),
    confidence: fit.confidence as ElasticityFitRow['confidence'],
    confidence_explanation: (fit.confidence_explanation as string | null) ?? null,
    method: (fit.method as string | null) ?? null,
    shrinkage_weight: fit.shrinkage_weight === null || fit.shrinkage_weight === undefined ? null : Number(fit.shrinkage_weight),
    prior_elasticity: fit.prior_elasticity === null || fit.prior_elasticity === undefined ? null : Number(fit.prior_elasticity),
    r2: null,
    model_version: String(fit.model_version ?? 'demo'),
    model_run_id: null,
    window_start: (fit.window_start as string | null) ?? null,
    window_end: (fit.window_end as string | null) ?? null,
    fitted_at: now,
  }));
}

/** `Object.assign` with an explicit `undefined` would blank a column; drop those keys. */
function stripUndefined<T extends object>(input: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (output as Record<string, unknown>)[key] = value;
  }
  return output;
}
