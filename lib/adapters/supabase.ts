/**
 * `SupabaseAdapter` — the real store. Server-only.
 *
 * Notes that are easy to get wrong and expensive to get wrong:
 *
 *   - **Numerics.** PostgREST serialises `numeric` as a JSON number, but a
 *     column can still arrive as a string through some paths. Everything numeric
 *     is coerced on the way in so the engine never does arithmetic on a string.
 *   - **The journal is append-only.** Upserts on it must be `ignoreDuplicates`
 *     (ON CONFLICT DO NOTHING); an `UPDATE` hits the guard trigger and throws.
 *   - **Locking is a row lease, not `pg_advisory_lock`.** Supabase pools
 *     connections, so a session lock cannot be held across HTTP calls. See
 *     `pf_acquire_rollout_lock` in the rollouts migration.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getServiceClient, unwrap, unwrapMaybe } from '../db/client';
import { nowIso, type DayString } from '../dates';
import type { Cents } from '../money';
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
  RecommendationRow,
  Rollout,
  RolloutCreate,
  RolloutEvent,
  RolloutEventCreate,
  RolloutPatch,
  RolloutReading,
  RolloutReadingUpsert,
  RolloutReportRow,
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
import type {
  AtomicModelIngestInput,
  AtomicModelIngestResult,
  AtomicOrderWebhookInput,
  AtomicOrderWebhookResult,
  CompliancePurgeResult,
  LockResult,
  Paged,
  StoreAdapter,
} from './types';

type Row = Record<string, unknown>;

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export class SupabaseAdapter implements StoreAdapter {
  readonly kind = 'supabase' as const;

  private readonly db: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.db = client ?? getServiceClient();
  }

  /**
   * Reachable *and* migrated.
   *
   * A real `select` rather than a `head` request: a HEAD does not consult the
   * schema cache the same way, so it can succeed against a database where the
   * tables do not exist yet — which reports healthy and then fails on the first
   * real query. PGRST205 ("table not found") is the signal that `db push` has not
   * run, and it deserves its own message.
   */
  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const { error } = await this.db.from('shops').select('id').limit(1);
      if (error) {
        if (error.code === 'PGRST205' || /schema cache/i.test(error.message)) {
          return {
            ok: false,
            detail:
              'connected, but the schema is missing — run `npx supabase db push` to apply supabase/migrations',
          };
        }
        return { ok: false, detail: error.message };
      }
      return { ok: true, detail: 'supabase reachable, schema present' };
    } catch (cause) {
      return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  // -- shops ---------------------------------------------------------------

  async getShopByDomain(shopDomain: string): Promise<Shop | null> {
    const result = await this.db
      .from('shops')
      .select('*')
      .eq('shop_domain', shopDomain.toLowerCase())
      .maybeSingle();
    const row = unwrapMaybe(result, `getShopByDomain(${shopDomain})`);
    return row ? mapShop(row as Row) : null;
  }

  async getShop(shopId: string): Promise<Shop | null> {
    const result = await this.db.from('shops').select('*').eq('id', shopId).maybeSingle();
    const row = unwrapMaybe(result, `getShop(${shopId})`);
    return row ? mapShop(row as Row) : null;
  }

  async listShops(): Promise<Shop[]> {
    const result = await this.db.from('shops').select('*').order('created_at', { ascending: true });
    return unwrap(result, 'listShops').map((row) => mapShop(row as Row));
  }

  async upsertShop(input: ShopUpsert): Promise<Shop> {
    const payload = { ...input, shop_domain: input.shop_domain.toLowerCase() };
    const result = await this.db
      .from('shops')
      .upsert(payload, { onConflict: 'shop_domain' })
      .select('*')
      .single();
    return mapShop(unwrap(result, `upsertShop(${payload.shop_domain})`) as Row);
  }

  async updateShop(shopId: string, patch: Partial<ShopUpsert>): Promise<Shop> {
    const result = await this.db.from('shops').update(patch).eq('id', shopId).select('*').single();
    return mapShop(unwrap(result, `updateShop(${shopId})`) as Row);
  }

  // -- catalog -------------------------------------------------------------

  async listProducts(shopId: string, query: ProductQuery = {}): Promise<Paged<Product>> {
    let builder = this.db
      .from('products')
      .select('*', { count: 'exact' })
      .eq('shop_id', shopId)
      .is('deleted_at', null);

    if (query.search) {
      const needle = `%${query.search.replace(/[%,]/g, '')}%`;
      builder = builder.or(
        [`title.ilike.${needle}`, `variant_title.ilike.${needle}`, `sku.ilike.${needle}`, `vendor.ilike.${needle}`].join(','),
      );
    }
    if (query.product_types?.length) builder = builder.in('product_type', query.product_types);
    if (query.vendors?.length) builder = builder.in('vendor', query.vendors);
    if (query.only_repriceable) {
      builder = builder
        .eq('status', 'ACTIVE')
        .eq('is_gift_card', false)
        .eq('requires_selling_plan', false)
        .eq('has_selling_plan', false)
        .gt('price_cents', 0);
    }
    if (query.missing_cogs) builder = builder.is('cogs_cents', null);

    switch (query.sort) {
      case 'price_asc':
        builder = builder.order('price_cents', { ascending: true });
        break;
      case 'price_desc':
        builder = builder.order('price_cents', { ascending: false });
        break;
      // `units_desc` needs order history; the catalog page sorts client-side for
      // that case rather than making this a join.
      default:
        builder = builder.order('title', { ascending: true }).order('variant_title', { ascending: true });
    }

    // Every paged ordering ends in a tenant-unique immutable key. Shopify can
    // legitimately contain thousands of variants with identical titles or
    // prices; OFFSET pagination without this tie-breaker can omit or duplicate
    // rows when Postgres chooses a different order for ties between requests.
    builder = builder.order('variant_gid', { ascending: true });

    const offset = query.offset ?? 0;
    if (query.limit !== undefined) builder = builder.range(offset, offset + query.limit - 1);

    const result = await builder;
    const rows = unwrap(result, `listProducts(${shopId})`);
    return { items: rows.map((row) => mapProduct(row as Row)), total: result.count ?? rows.length };
  }

  async getProductsByVariantGids(shopId: string, variantGids: readonly string[]): Promise<Product[]> {
    if (variantGids.length === 0) return [];
    const result = await this.db
      .from('products')
      .select('*')
      .eq('shop_id', shopId)
      .in('variant_gid', [...variantGids]);
    return unwrap(result, `getProductsByVariantGids(${shopId})`).map((row) => mapProduct(row as Row));
  }

  async upsertProducts(shopId: string, products: readonly ProductUpsert[]): Promise<number> {
    if (products.length === 0) return 0;
    const now = nowIso();
    const payload = products.map((product) => ({
      ...product,
      shop_id: shopId,
      last_synced_at: now,
      deleted_at: null,
    }));

    // Chunked so a 500-SKU store does not build one enormous request body.
    let written = 0;
    for (const chunk of chunked(payload, 200)) {
      const result = await this.db
        .from('products')
        .upsert(chunk, { onConflict: 'shop_id,variant_gid' })
        .select('id');
      written += unwrap(result, `upsertProducts(${shopId})`).length;
    }
    return written;
  }

  async setCogs(
    shopId: string,
    variantGid: string,
    cogsCents: Cents | null,
    source: 'shopify' | 'manual',
  ): Promise<Product> {
    const result = await this.db
      .from('products')
      .update({
        cogs_cents: cogsCents,
        // The migration's CHECK requires source and value to agree.
        cogs_source: cogsCents === null ? 'none' : source,
        cogs_updated_at: cogsCents === null ? null : nowIso(),
      })
      .eq('shop_id', shopId)
      .eq('variant_gid', variantGid)
      .select('*')
      .single();
    return mapProduct(unwrap(result, `setCogs(${variantGid})`) as Row);
  }

  async markProductsDeleted(shopId: string, variantGids: readonly string[]): Promise<number> {
    if (variantGids.length === 0) return 0;
    const result = await this.db
      .from('products')
      .update({ deleted_at: nowIso() })
      .eq('shop_id', shopId)
      .in('variant_gid', [...variantGids])
      .is('deleted_at', null)
      .select('id');
    return unwrap(result, `markProductsDeleted(${shopId})`).length;
  }

  // -- order history -------------------------------------------------------

  async getOrderDays(shopId: string, query: OrderDayQuery = {}): Promise<OrderDay[]> {
    // Supabase/PostgREST projects commonly cap one response at 1,000 rows. A
    // 180-day forecast crosses that with only six variants, so a single select
    // would silently train on incomplete history. Page on a deterministic
    // compound order until the server returns a short page.
    const pageSize = query.limit ?? 1000;
    const initialOffset = query.offset ?? 0;
    const rows: Row[] = [];
    for (let offset = initialOffset; ; offset += pageSize) {
      let builder = this.db.from('order_days').select('*').eq('shop_id', shopId);
      if (query.variant_gids?.length) builder = builder.in('variant_gid', [...query.variant_gids]);
      if (query.from_day) builder = builder.gte('day', query.from_day);
      if (query.to_day) builder = builder.lte('day', query.to_day);

      const result = await builder
        .order('day', { ascending: true })
        .order('variant_gid', { ascending: true })
        .range(offset, offset + pageSize - 1);
      const page = unwrap(result, `getOrderDays(${shopId})`) as Row[];
      rows.push(...page);
      if (query.limit !== undefined || page.length < pageSize) break;
    }
    return rows.map((row) => mapOrderDay(row));
  }

  async upsertOrderDays(shopId: string, rows: readonly OrderDayUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const payload = rows.map((row) => ({ ...row, shop_id: shopId }));

    let written = 0;
    for (const chunk of chunked(payload, 500)) {
      const result = await this.db
        .from('order_days')
        .upsert(chunk, { onConflict: 'shop_id,variant_gid,day' })
        .select('day');
      written += unwrap(result, `upsertOrderDays(${shopId})`).length;
    }
    return written;
  }

  async commitOrderDaySyncSnapshot(
    shopId: string,
    rows: readonly OrderDayUpsert[],
    snapshotStartedAt: string,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.db.rpc('pf_commit_order_day_sync_snapshot', {
      p_shop_id: shopId,
      p_rows: rows,
      p_snapshot_started_at: snapshotStartedAt,
    });
    return num(unwrap(result, `commitOrderDaySyncSnapshot(${shopId})`));
  }

  // -- rollouts ------------------------------------------------------------

  async createRollout(input: RolloutCreate): Promise<Rollout> {
    const result = await this.db.from('rollouts').insert(input).select('*').single();
    return mapRollout(unwrap(result, 'createRollout') as Row);
  }

  async createDraftRollout(
    input: RolloutCreate & Pick<Rollout, 'id'>,
    variants: readonly RolloutVariantCreate[],
  ): Promise<{ rollout: Rollout; variants: RolloutVariant[] }> {
    const result = await this.db.rpc('pf_create_rollout_draft', {
      p_rollout: input,
      p_variants: variants,
    });
    const payload = unwrap(result, 'createDraftRollout') as {
      rollout: Row;
      variants: Row[];
    };
    return {
      rollout: mapRollout(payload.rollout),
      variants: payload.variants.map(mapRolloutVariant),
    };
  }

  async getRollout(rolloutId: string): Promise<Rollout | null> {
    const result = await this.db.from('rollouts').select('*').eq('id', rolloutId).maybeSingle();
    const row = unwrapMaybe(result, `getRollout(${rolloutId})`);
    return row ? mapRollout(row as Row) : null;
  }

  async listRollouts(shopId: string, statuses?: readonly RolloutStatus[]): Promise<Rollout[]> {
    let builder = this.db.from('rollouts').select('*').eq('shop_id', shopId);
    if (statuses?.length) builder = builder.in('status', [...statuses]);
    // UUID is only a stable tie-breaker, not evidence of creation order. Callers
    // such as the kill switch must remain correct under either tied-row order.
    const result = await builder
      .order('created_at', { ascending: false })
      .order('creation_sequence', { ascending: false })
      .order('id', { ascending: false });
    return unwrap(result, `listRollouts(${shopId})`).map((row) => mapRollout(row as Row));
  }

  async listActiveRollouts(): Promise<Rollout[]> {
    const result = await this.db
      .from('rollouts')
      .select('*')
      .in('status', ['running', 'scheduled', 'paused'])
      .order('created_at', { ascending: true });
    return unwrap(result, 'listActiveRollouts').map((row) => mapRollout(row as Row));
  }

  async updateRollout(rolloutId: string, patch: RolloutPatch): Promise<Rollout> {
    const result = await this.db.from('rollouts').update(patch).eq('id', rolloutId).select('*').single();
    return mapRollout(unwrap(result, `updateRollout(${rolloutId})`) as Row);
  }

  async insertRolloutVariants(rows: readonly RolloutVariantCreate[]): Promise<number> {
    if (rows.length === 0) return 0;
    let written = 0;
    for (const chunk of chunked([...rows], 200)) {
      const result = await this.db
        .from('rollout_variants')
        .upsert(chunk, { onConflict: 'rollout_id,variant_gid' })
        .select('id');
      written += unwrap(result, 'insertRolloutVariants').length;
    }
    return written;
  }

  async getRolloutVariants(rolloutId: string): Promise<RolloutVariant[]> {
    const result = await this.db
      .from('rollout_variants')
      .select('*')
      .eq('rollout_id', rolloutId)
      .order('cohort_stage', { ascending: true })
      .order('variant_gid', { ascending: true });
    return unwrap(result, `getRolloutVariants(${rolloutId})`).map((row) => mapRolloutVariant(row as Row));
  }

  async listRolloutVariantsForShop(shopId: string): Promise<RolloutVariant[]> {
    const rows: RolloutVariant[] = [];
    for (let offset = 0; ; offset += 1000) {
      const result = await this.db
        .from('rollout_variants')
        .select('*')
        .eq('shop_id', shopId)
        .order('created_at', { ascending: true })
        // Batched inserts commonly share a timestamp. Without a unique
        // tie-breaker, OFFSET pages can duplicate one tied row and silently
        // omit another from the shop-wide rollback verification.
        .order('id', { ascending: true })
        .range(offset, offset + 999);
      const page = unwrap(result, `listRolloutVariantsForShop(${shopId})`);
      rows.push(...page.map((row) => mapRolloutVariant(row as Row)));
      if (page.length < 1000) break;
    }
    return rows;
  }

  async updateRolloutVariant(id: string, patch: Partial<RolloutVariant>): Promise<RolloutVariant> {
    const result = await this.db.from('rollout_variants').update(patch).eq('id', id).select('*').single();
    return mapRolloutVariant(unwrap(result, `updateRolloutVariant(${id})`) as Row);
  }

  async upsertRolloutReading(input: RolloutReadingUpsert): Promise<RolloutReading> {
    const result = await this.db
      .from('rollout_readings')
      .upsert(input, { onConflict: 'rollout_id,day' })
      .select('*')
      .single();
    return mapReading(unwrap(result, 'upsertRolloutReading') as Row);
  }

  async listRolloutReadings(rolloutId: string): Promise<RolloutReading[]> {
    const result = await this.db
      .from('rollout_readings')
      .select('*')
      .eq('rollout_id', rolloutId)
      .order('day', { ascending: true });
    return unwrap(result, `listRolloutReadings(${rolloutId})`).map((row) => mapReading(row as Row));
  }

  async appendRolloutEvent(event: RolloutEventCreate): Promise<RolloutEvent> {
    const result = await this.db
      .from('rollout_events')
      .insert({ ...event, at: event.at ?? nowIso() })
      .select('*')
      .single();
    return mapEvent(unwrap(result, 'appendRolloutEvent') as Row);
  }

  async listRolloutEvents(rolloutId: string, limit = 200): Promise<RolloutEvent[]> {
    const result = await this.db
      .from('rollout_events')
      .select('*')
      .eq('rollout_id', rolloutId)
      .order('at', { ascending: false })
      .limit(limit);
    return unwrap(result, `listRolloutEvents(${rolloutId})`).map((row) => mapEvent(row as Row));
  }

  async withRolloutLock<T>(rolloutId: string, fn: () => Promise<T>, ttlSeconds = 300): Promise<LockResult<T>> {
    const token = randomUUID();
    const acquire = await this.db.rpc('pf_acquire_rollout_lock', {
      p_rollout_id: rolloutId,
      p_token: token,
      p_ttl_seconds: ttlSeconds,
    });
    if (acquire.error) throw new Error(`pf_acquire_rollout_lock(${rolloutId}): ${acquire.error.message}`);
    if (acquire.data !== true) return { acquired: false };

    try {
      return { acquired: true, result: await fn() };
    } finally {
      // Best effort: if the release fails the lease still expires on its own,
      // which is the reason it has a TTL at all.
      await this.db.rpc('pf_release_rollout_lock', { p_rollout_id: rolloutId, p_token: token });
    }
  }

  // -- journal -------------------------------------------------------------

  async appendJournalEntries(shopId: string, entries: readonly JournalEntryCreate[]): Promise<JournalEntry[]> {
    if (entries.length === 0) return [];
    const payload = entries.map((entry) => ({ ...entry, shop_id: shopId }));

    const written: JournalEntry[] = [];
    for (const chunk of chunked(payload, 200)) {
      // ignoreDuplicates => ON CONFLICT DO NOTHING. An UPDATE here would hit the
      // append-only trigger, and re-recording a write we already made is exactly
      // what the idempotency key is for.
      const result = await this.db
        .from('journal_entries')
        .upsert(chunk, { onConflict: 'shop_id,idempotency_key', ignoreDuplicates: true })
        .select('*');
      for (const row of unwrap(result, `appendJournalEntries(${shopId})`)) {
        written.push(mapJournal(row as Row));
      }
    }
    return written;
  }

  async listJournalEntries(shopId: string, filter: JournalFilter = {}): Promise<Paged<JournalEntry>> {
    let builder = this.db.from('journal_entries').select('*', { count: 'exact' }).eq('shop_id', shopId);

    if (filter.variant_gids?.length) builder = builder.in('variant_gid', [...filter.variant_gids]);
    if (filter.rollout_id) builder = builder.eq('rollout_id', filter.rollout_id);
    if (filter.sources?.length) builder = builder.in('source', [...filter.sources]);
    if (filter.from_day) builder = builder.gte('applied_at', `${filter.from_day}T00:00:00Z`);
    if (filter.to_day) builder = builder.lte('applied_at', `${filter.to_day}T23:59:59.999Z`);

    builder = builder
      .order('creation_sequence', { ascending: false, nullsFirst: false })
      .order('applied_at', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    const offset = filter.offset ?? 0;
    if (filter.limit !== undefined) builder = builder.range(offset, offset + filter.limit - 1);

    const result = await builder;
    const rows = unwrap(result, `listJournalEntries(${shopId})`);
    return { items: rows.map((row) => mapJournal(row as Row)), total: result.count ?? rows.length };
  }

  async getLastJournaledPrice(shopId: string, variantGid: string): Promise<JournalEntry | null> {
    const result = await this.db
      .from('journal_entries')
      .select('*')
      .eq('shop_id', shopId)
      .eq('variant_gid', variantGid)
      .eq('status', 'applied')
      .order('creation_sequence', { ascending: false, nullsFirst: false })
      .order('applied_at', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = unwrapMaybe(result, `getLastJournaledPrice(${variantGid})`);
    return row ? mapJournal(row as Row) : null;
  }

  // -- webhooks ------------------------------------------------------------

  async recordWebhook(event: WebhookEventCreate): Promise<{ duplicate: boolean; record: WebhookEventRecord }> {
    const insert = await this.db.from('webhook_events').insert(event).select('*').single();

    if (insert.error) {
      // 23505 = unique violation on webhook_id. Shopify retries; this is the
      // dedupe working, not a failure.
      if (insert.error.code === '23505') {
        const existing = await this.db
          .from('webhook_events')
          .select('*')
          .eq('webhook_id', event.webhook_id)
          .single();
        const record = mapWebhook(unwrap(existing, 'recordWebhook(duplicate)') as Row);
        if (
          record.shop_id !== (event.shop_id ?? null) ||
          record.shop_domain !== event.shop_domain ||
          record.topic !== event.topic
        ) {
          throw new Error('webhook id is already bound to a different shop or topic');
        }
        return { duplicate: true, record };
      }
      throw new Error(`recordWebhook(${event.topic}): ${insert.error.message}`);
    }

    return { duplicate: false, record: mapWebhook(insert.data as Row) };
  }

  async markWebhookProcessed(
    webhookId: string,
    status: 'processed' | 'failed' | 'ignored',
    error?: string,
  ): Promise<void> {
    const existing = await this.db
      .from('webhook_events')
      .select('attempts')
      .eq('webhook_id', webhookId)
      .maybeSingle();
    const attempts = num((existing.data as Row | null)?.attempts, 0) + 1;

    const result = await this.db
      .from('webhook_events')
      .update({ status, processed_at: nowIso(), attempts, error: error ?? null })
      .eq('webhook_id', webhookId)
      .select('id');
    unwrap(result, `markWebhookProcessed(${webhookId})`);
  }

  async claimWebhook(webhookId: string): Promise<boolean> {
    const result = await this.db
      .from('webhook_events')
      .update({ status: 'processing', error: null, processed_at: null })
      .eq('webhook_id', webhookId)
      .in('status', ['received', 'failed'])
      .select('id');
    return unwrap(result, `claimWebhook(${webhookId})`).length === 1;
  }

  async ingestOrderWebhook(input: AtomicOrderWebhookInput): Promise<AtomicOrderWebhookResult> {
    const functionName = input.event.topic === 'refunds/create' ? 'pf_ingest_refund_webhook' : 'pf_ingest_order_webhook';
    const result = await this.db.rpc(functionName, {
      p_shop_id: input.event.shop_id,
      p_event: { ...input.event, payload: null },
      p_rows: input.rows,
    });
    const raw = unwrap(result, `${functionName}(${input.event.webhook_id})`) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('pf_ingest_order_webhook returned an invalid result');
    }
    const row = raw as Row;
    if (row.record === null || typeof row.record !== 'object' || Array.isArray(row.record)) {
      throw new Error('pf_ingest_order_webhook returned no event record');
    }
    return {
      duplicate: Boolean(row.duplicate),
      rows_written: num(row.rows_written),
      record: mapWebhook(row.record as Row),
    };
  }

  async purgeShopForCompliance(input: {
    shopId: string | null;
    shopDomain: string;
    webhookId: string;
    triggeredAt: string | null;
  }): Promise<CompliancePurgeResult> {
    const result = await this.db.rpc('pf_purge_shop_for_compliance', {
      p_shop_id: input.shopId,
      p_shop_domain: input.shopDomain,
      p_webhook_id: input.webhookId,
      p_triggered_at: input.triggeredAt,
    });
    const raw = unwrap(result, `purgeShopForCompliance(${input.shopDomain})`) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('pf_purge_shop_for_compliance returned an invalid result');
    }
    const row = raw as Row;
    return {
      duplicate: Boolean(row.duplicate),
      purged: Boolean(row.purged),
      shop_id: (row.shop_id as string | null) ?? null,
      shop_domain: String(row.shop_domain),
      webhook_id: String(row.webhook_id),
    };
  }

  // -- sync ----------------------------------------------------------------

  async createSyncRun(shopId: string, kind: SyncRun['kind'] = 'full'): Promise<SyncRun> {
    const result = await this.db
      .from('sync_runs')
      .insert({ shop_id: shopId, kind })
      .select('*')
      .single();
    return mapSyncRun(unwrap(result, `createSyncRun(${shopId})`) as Row);
  }

  async getLatestSyncRun(shopId: string): Promise<SyncRun | null> {
    const result = await this.db
      .from('sync_runs')
      .select('*')
      .eq('shop_id', shopId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = unwrapMaybe(result, `getLatestSyncRun(${shopId})`);
    return row ? mapSyncRun(row as Row) : null;
  }

  async updateSyncRun(syncRunId: string, patch: SyncRunPatch): Promise<SyncRun> {
    const result = await this.db.from('sync_runs').update(patch).eq('id', syncRunId).select('*').single();
    return mapSyncRun(unwrap(result, `updateSyncRun(${syncRunId})`) as Row);
  }

  // -- ML outputs ----------------------------------------------------------

  async getLatestFits(shopId: string, variantGids?: readonly string[]): Promise<Map<string, ElasticityFitRow>> {
    let builder = this.db.from('elasticity_fits').select('*').eq('shop_id', shopId);
    if (variantGids?.length) builder = builder.in('variant_gid', [...variantGids]);

    const result = await builder.order('fitted_at', { ascending: false });
    const latest = new Map<string, ElasticityFitRow>();
    for (const row of unwrap(result, `getLatestFits(${shopId})`)) {
      const fit = mapFit(row as Row);
      // Ordered newest-first, so the first row per variant wins.
      if (!latest.has(fit.variant_gid)) latest.set(fit.variant_gid, fit);
    }
    return latest;
  }

  async getLatestRecommendations(
    shopId: string,
    variantGids?: readonly string[],
  ): Promise<Map<string, RecommendationRow>> {
    let builder = this.db.from('recommendations').select('*').eq('shop_id', shopId);
    if (variantGids?.length) builder = builder.in('variant_gid', [...variantGids]);

    const result = await builder.order('computed_at', { ascending: false });
    const latest = new Map<string, RecommendationRow>();
    for (const row of unwrap(result, `getLatestRecommendations(${shopId})`)) {
      const recommendation = mapRecommendation(row as Row);
      // Ordered newest-first, so the first row per variant wins.
      if (!latest.has(recommendation.variant_gid)) latest.set(recommendation.variant_gid, recommendation);
    }
    return latest;
  }

  async getExpectedBands(
    shopId: string,
    query: { variantGids?: readonly string[]; fromDay: DayString; toDay: DayString; rolloutId?: string | null },
  ): Promise<ExpectedBandRow[]> {
    let builder = this.db
      .from('expected_bands')
      .select('*')
      .eq('shop_id', shopId)
      .gte('day', query.fromDay)
      .lte('day', query.toDay);

    if (query.variantGids?.length) builder = builder.in('variant_gid', [...query.variantGids]);
    if (query.rolloutId === null) builder = builder.is('rollout_id', null);
    else if (query.rolloutId !== undefined) builder = builder.eq('rollout_id', query.rolloutId);

    const result = await builder.order('day', { ascending: true }).order('generated_at', { ascending: false });
    return unwrap(result, `getExpectedBands(${shopId})`).map((row) => mapBand(row as Row));
  }

  async listModelRuns(shopId: string | null, limit = 50): Promise<ModelRun[]> {
    let builder = this.db.from('model_runs').select('*');
    if (shopId !== null) builder = builder.eq('shop_id', shopId);
    const result = await builder.order('started_at', { ascending: false }).limit(limit);
    return unwrap(result, 'listModelRuns').map((row) => mapModelRun(row as Row));
  }

  async getModelRunsByIds(shopId: string, ids: readonly string[]): Promise<ModelRun[]> {
    if (ids.length === 0) return [];
    const result = await this.db
      .from('model_runs')
      .select('*')
      .eq('shop_id', shopId)
      .in('id', [...ids]);
    return unwrap(result, `getModelRunsByIds(${shopId})`).map((row) => mapModelRun(row as Row));
  }

  async recordModelRun(
    input: Omit<ModelRun, 'id' | 'started_at' | 'created_at'> & { started_at?: string },
  ): Promise<ModelRun> {
    const result = await this.db.from('model_runs').insert(input).select('*').single();
    return mapModelRun(unwrap(result, 'recordModelRun') as Row);
  }

  async updateModelRun(id: string, patch: Partial<Omit<ModelRun, 'id'>>): Promise<ModelRun> {
    const result = await this.db.from('model_runs').update(patch).eq('id', id).select('*').single();
    return mapModelRun(unwrap(result, `updateModelRun(${id})`) as Row);
  }

  async ingestModelRunAtomic(input: AtomicModelIngestInput): Promise<AtomicModelIngestResult> {
    const result = await this.db.rpc('pf_ingest_model_run', {
      p_shop_id: input.shopId,
      p_ingest_key: input.ingestKey,
      p_run: input.run,
      p_fits: input.fits,
      p_bands: input.bands,
      p_reports: input.reports,
      p_recommendations: input.recommendations,
    });
    const raw = unwrap(result, `ingestModelRunAtomic(${input.shopId})`) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('pf_ingest_model_run returned an invalid result');
    }
    const row = raw as Row;
    return {
      model_run_id: String(row.model_run_id),
      fits_written: num(row.fits_written),
      bands_written: num(row.bands_written),
      reports_written: num(row.reports_written),
      recommendations_written: num(row.recommendations_written),
      rows_written: num(row.rows_written),
      deduplicated: Boolean(row.deduplicated),
    };
  }

  async listRolloutReports(shopId: string, rolloutId?: string): Promise<RolloutReportRow[]> {
    let builder = this.db.from('rollout_reports').select('*').eq('shop_id', shopId);
    if (rolloutId !== undefined) builder = builder.eq('rollout_id', rolloutId);
    const result = await builder.order('generated_at', { ascending: false });
    return unwrap(result, `listRolloutReports(${shopId})`).map((row) => mapRolloutReport(row as Row));
  }

  async upsertFits(shopId: string, fits: readonly Omit<ElasticityFitRow, 'id'>[]): Promise<number> {
    if (fits.length === 0) return 0;
    const result = await this.db
      .from('elasticity_fits')
      .upsert(
        fits.map((fit) => ({ ...fit, shop_id: shopId })),
        { onConflict: 'shop_id,variant_gid,model_version' },
      )
      .select('id');
    return unwrap(result, `upsertFits(${shopId})`).length;
  }

  /**
   * The uniqueness of a band involves `coalesce(rollout_id, …)`, so PostgREST
   * cannot infer the conflict target from a column list. Delete-then-insert per
   * batch gives the same result. (Lane C writing straight SQL can use the
   * expression form of ON CONFLICT — see `contracts/db/schema.md`.)
   */
  async upsertExpectedBands(shopId: string, bands: readonly Omit<ExpectedBandRow, 'id'>[]): Promise<number> {
    if (bands.length === 0) return 0;

    for (const chunk of chunked([...bands], 200)) {
      const days = [...new Set(chunk.map((band) => band.day))];
      const variants = [...new Set(chunk.map((band) => band.variant_gid))];
      const versions = [...new Set(chunk.map((band) => band.model_version))];

      const remove = await this.db
        .from('expected_bands')
        .delete()
        .eq('shop_id', shopId)
        .in('day', days)
        .in('variant_gid', variants)
        .in('model_version', versions)
        .select('id');
      if (remove.error) throw new Error(`upsertExpectedBands(delete): ${remove.error.message}`);

      const insert = await this.db
        .from('expected_bands')
        .insert(chunk.map((band) => ({ ...band, shop_id: shopId })))
        .select('id');
      unwrap(insert, `upsertExpectedBands(${shopId})`);
    }
    return bands.length;
  }
}

// ---------------------------------------------------------------------------
// row mappers
// ---------------------------------------------------------------------------

function mapShop(row: Row): Shop {
  return {
    id: String(row.id),
    shop_domain: String(row.shop_domain),
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    access_token_enc: (row.access_token_enc as string | null) ?? null,
    scopes: (row.scopes as string | null) ?? null,
    api_version: String(row.api_version ?? '2026-07'),
    currency: String(row.currency ?? 'USD'),
    timezone: String(row.timezone ?? 'UTC'),
    plan_name: (row.plan_name as string | null) ?? null,
    mode: (row.mode as Shop['mode']) ?? 'real',
    kill_switch_engaged_at: (row.kill_switch_engaged_at as string | null) ?? null,
    kill_switch_reason: (row.kill_switch_reason as string | null) ?? null,
    notify_emails: (row.notify_emails as string[] | null) ?? [],
    installed_at: (row.installed_at as string | null) ?? null,
    uninstalled_at: (row.uninstalled_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapProduct(row: Row): Product {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    product_gid: String(row.product_gid),
    variant_gid: String(row.variant_gid),
    inventory_item_gid: (row.inventory_item_gid as string | null) ?? null,
    title: String(row.title ?? ''),
    variant_title: (row.variant_title as string | null) ?? null,
    sku: (row.sku as string | null) ?? null,
    vendor: (row.vendor as string | null) ?? null,
    product_type: (row.product_type as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    image_url: (row.image_url as string | null) ?? null,
    status: (row.status as Product['status']) ?? 'ACTIVE',
    price_cents: num(row.price_cents),
    compare_at_cents: numOrNull(row.compare_at_cents),
    currency: String(row.currency ?? 'USD'),
    cogs_cents: numOrNull(row.cogs_cents),
    cogs_source: (row.cogs_source as Product['cogs_source']) ?? 'none',
    cogs_updated_at: (row.cogs_updated_at as string | null) ?? null,
    is_gift_card: Boolean(row.is_gift_card),
    requires_selling_plan: Boolean(row.requires_selling_plan),
    has_selling_plan: Boolean(row.has_selling_plan),
    inventory_quantity: numOrNull(row.inventory_quantity),
    available_for_sale: row.available_for_sale === undefined ? true : Boolean(row.available_for_sale),
    first_synced_at: String(row.first_synced_at ?? row.created_at),
    last_synced_at: String(row.last_synced_at ?? row.created_at),
    deleted_at: (row.deleted_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapOrderDay(row: Row): OrderDay {
  return {
    shop_id: String(row.shop_id),
    variant_gid: String(row.variant_gid),
    day: String(row.day) as DayString,
    product_gid: (row.product_gid as string | null) ?? null,
    units: num(row.units),
    orders: num(row.orders),
    gross_revenue_cents: num(row.gross_revenue_cents),
    discount_cents: num(row.discount_cents),
    refund_units: num(row.refund_units),
    refund_cents: num(row.refund_cents),
    net_revenue_cents: num(row.net_revenue_cents),
    realized_unit_price_cents: numOrNull(row.realized_unit_price_cents),
    list_price_cents: numOrNull(row.list_price_cents),
    had_stockout: Boolean(row.had_stockout),
    on_promo: Boolean(row.on_promo),
    source: (row.source as OrderDay['source']) ?? 'sync',
    created_at: (row.created_at as string | undefined) ?? undefined,
    updated_at: (row.updated_at as string | undefined) ?? undefined,
  };
}

function mapRollout(row: Row): Rollout {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    name: String(row.name),
    status: row.status as RolloutStatus,
    change_type: row.change_type as Rollout['change_type'],
    change_pct: numOrNull(row.change_pct),
    change_absolute_cents: numOrNull(row.change_absolute_cents),
    rounding: (row.rounding as Rollout['rounding']) ?? 'none',
    horizon_days: num(row.horizon_days, 90),
    stages: (row.stages as Rollout['stages']) ?? [],
    current_stage: num(row.current_stage, -1),
    stage_entered_at: (row.stage_entered_at as string | null) ?? null,
    guardrails: row.guardrails as Rollout['guardrails'],
    forecast: (row.forecast as Rollout['forecast']) ?? null,
    scheduled_start_at: (row.scheduled_start_at as string | null) ?? null,
    started_at: (row.started_at as string | null) ?? null,
    ended_at: (row.ended_at as string | null) ?? null,
    ended_reason: (row.ended_reason as Rollout['ended_reason']) ?? null,
    paused_reason: (row.paused_reason as string | null) ?? null,
    notify_emails: (row.notify_emails as string[] | null) ?? [],
    eval_lock_token: (row.eval_lock_token as string | null) ?? null,
    eval_locked_until: (row.eval_locked_until as string | null) ?? null,
    last_evaluated_at: (row.last_evaluated_at as string | null) ?? null,
    last_evaluated_day: (row.last_evaluated_day as DayString | null) ?? null,
    created_by: String(row.created_by ?? 'merchant'),
    creation_sequence: row.creation_sequence == null ? undefined : num(row.creation_sequence),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapRolloutVariant(row: Row): RolloutVariant {
  return {
    id: String(row.id),
    rollout_id: String(row.rollout_id),
    shop_id: String(row.shop_id),
    variant_gid: String(row.variant_gid),
    product_gid: String(row.product_gid),
    title: String(row.title ?? ''),
    sku: (row.sku as string | null) ?? null,
    baseline_price_cents: num(row.baseline_price_cents),
    baseline_compare_at_cents: numOrNull(row.baseline_compare_at_cents),
    target_price_cents: num(row.target_price_cents),
    target_compare_at_cents: numOrNull(row.target_compare_at_cents),
    compare_at_action: (row.compare_at_action as RolloutVariant['compare_at_action']) ?? 'none',
    baseline_units_per_day: numOrNull(row.baseline_units_per_day),
    cogs_cents_at_creation: numOrNull(row.cogs_cents_at_creation),
    cohort_stage: num(row.cohort_stage),
    applied_price_cents: numOrNull(row.applied_price_cents),
    applied_at: (row.applied_at as string | null) ?? null,
    reverted_at: (row.reverted_at as string | null) ?? null,
    excluded: Boolean(row.excluded),
    exclusion_reason: (row.exclusion_reason as RolloutVariant['exclusion_reason']) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapReading(row: Row): RolloutReading {
  return {
    id: String(row.id),
    rollout_id: String(row.rollout_id),
    shop_id: String(row.shop_id),
    day: String(row.day) as DayString,
    stage_index: num(row.stage_index),
    actual_units: num(row.actual_units),
    actual_orders: num(row.actual_orders),
    actual_revenue_cents: num(row.actual_revenue_cents),
    actual_profit_cents: numOrNull(row.actual_profit_cents),
    expected_units: num(row.expected_units),
    expected_low: num(row.expected_low),
    expected_high: num(row.expected_high),
    counterfactual_units: numOrNull(row.counterfactual_units),
    counterfactual_revenue_cents: numOrNull(row.counterfactual_revenue_cents),
    counterfactual_profit_cents: numOrNull(row.counterfactual_profit_cents),
    expected_revenue_cents: numOrNull(row.expected_revenue_cents),
    expected_profit_cents: numOrNull(row.expected_profit_cents),
    expected_revenue_low_cents: numOrNull(row.expected_revenue_low_cents),
    expected_revenue_high_cents: numOrNull(row.expected_revenue_high_cents),
    expected_profit_low_cents: numOrNull(row.expected_profit_low_cents),
    expected_profit_high_cents: numOrNull(row.expected_profit_high_cents),
    expected_source: (row.expected_source as RolloutReading['expected_source']) ?? 'bracket',
    interval_nominal: num(row.interval_nominal, 0.8),
    model_version: (row.model_version as string | null) ?? null,
    band_stale: Boolean(row.band_stale),
    band_floored: Boolean(row.band_floored),
    breach_probability: numOrNull(row.breach_probability),
    breach: Boolean(row.breach),
    breach_rule_id: (row.breach_rule_id as string | null) ?? null,
    breach_reason: (row.breach_reason as string | null) ?? null,
    breach_streak: num(row.breach_streak),
    decision: (row.decision as RolloutReading['decision']) ?? 'none',
    evaluated_at: String(row.evaluated_at),
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapEvent(row: Row): RolloutEvent {
  return {
    id: String(row.id),
    rollout_id: String(row.rollout_id),
    shop_id: String(row.shop_id),
    type: row.type as RolloutEvent['type'],
    message: String(row.message),
    actor: (row.actor as RolloutEvent['actor']) ?? 'system',
    data: (row.data as Record<string, unknown>) ?? {},
    at: String(row.at),
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapJournal(row: Row): JournalEntry {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    variant_gid: String(row.variant_gid),
    product_gid: String(row.product_gid),
    title: String(row.title ?? ''),
    sku: (row.sku as string | null) ?? null,
    rollout_id: (row.rollout_id as string | null) ?? null,
    stage_index: numOrNull(row.stage_index),
    source: row.source as JournalEntry['source'],
    actor: row.actor as JournalEntry['actor'],
    reason: (row.reason as string | null) ?? null,
    status: row.status as JournalEntry['status'],
    before_price_cents: num(row.before_price_cents),
    after_price_cents: num(row.after_price_cents),
    before_compare_at_cents: numOrNull(row.before_compare_at_cents),
    after_compare_at_cents: numOrNull(row.after_compare_at_cents),
    currency: String(row.currency ?? 'USD'),
    idempotency_key: (row.idempotency_key as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    shopify_user_errors: row.shopify_user_errors ?? null,
    applied_at: String(row.applied_at),
    creation_sequence: row.creation_sequence == null ? undefined : num(row.creation_sequence),
    created_at: String(row.created_at),
  };
}

function mapWebhook(row: Row): WebhookEventRecord {
  return {
    id: String(row.id),
    shop_domain: String(row.shop_domain),
    shop_id: (row.shop_id as string | null) ?? null,
    topic: String(row.topic),
    webhook_id: String(row.webhook_id),
    api_version: (row.api_version as string | null) ?? null,
    triggered_at: (row.triggered_at as string | null) ?? null,
    received_at: String(row.received_at),
    status: (row.status as WebhookEventRecord['status']) ?? 'received',
    attempts: num(row.attempts),
    error: (row.error as string | null) ?? null,
    processed_at: (row.processed_at as string | null) ?? null,
    payload: row.payload ?? null,
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapSyncRun(row: Row): SyncRun {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    kind: (row.kind as SyncRun['kind']) ?? 'full',
    stage: (row.stage as SyncRun['stage']) ?? 'queued',
    message: String(row.message ?? ''),
    products_total: numOrNull(row.products_total),
    products_synced: num(row.products_synced),
    days_target: num(row.days_target, 180),
    days_synced: num(row.days_synced),
    orders_processed: num(row.orders_processed),
    catalog_ready_at: (row.catalog_ready_at as string | null) ?? null,
    history_ready_at: (row.history_ready_at as string | null) ?? null,
    eta_seconds: numOrNull(row.eta_seconds),
    error_code: (row.error_code as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    error_retryable: (row.error_retryable as boolean | null) ?? null,
    cursor: (row.cursor as Record<string, unknown>) ?? {},
    started_at: String(row.started_at),
    finished_at: (row.finished_at as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapFit(row: Row): ElasticityFitRow {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    variant_gid: String(row.variant_gid),
    elasticity: num(row.elasticity),
    se: numOrNull(row.se),
    low: numOrNull(row.low),
    high: numOrNull(row.high),
    interval_nominal: numOrNull(row.interval_nominal),
    n_obs: num(row.n_obs),
    price_variation_pct: num(row.price_variation_pct),
    confidence: row.confidence as ElasticityFitRow['confidence'],
    confidence_explanation: (row.confidence_explanation as string | null) ?? null,
    method: (row.method as string | null) ?? null,
    shrinkage_weight: numOrNull(row.shrinkage_weight),
    prior_elasticity: numOrNull(row.prior_elasticity),
    r2: numOrNull(row.r2),
    model_version: String(row.model_version),
    model_run_id: (row.model_run_id as string | null) ?? null,
    window_start: (row.window_start as DayString | null) ?? null,
    window_end: (row.window_end as DayString | null) ?? null,
    fitted_at: String(row.fitted_at),
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapRecommendation(row: Row): RecommendationRow {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    variant_gid: String(row.variant_gid),
    current_price_cents: num(row.current_price_cents) as Cents,
    recommended_price_cents: num(row.recommended_price_cents) as Cents,
    robust_price_cents: num(row.robust_price_cents) as Cents,
    rounding: (row.rounding as RecommendationRow['rounding']) ?? 'none',
    elasticity: num(row.elasticity),
    elasticity_low: numOrNull(row.elasticity_low),
    elasticity_high: numOrNull(row.elasticity_high),
    fit_model_version: (row.fit_model_version as string | null) ?? null,
    confidence: row.confidence as RecommendationRow['confidence'],
    nominal_profit_delta_cents_per_day: num(row.nominal_profit_delta_cents_per_day) as Cents,
    robust_profit_delta_cents_per_day: num(row.robust_profit_delta_cents_per_day) as Cents,
    nominal_revenue_delta_cents_per_day: num(row.nominal_revenue_delta_cents_per_day) as Cents,
    robust_revenue_delta_cents_per_day: num(row.robust_revenue_delta_cents_per_day) as Cents,
    margin_floor_pct: numOrNull(row.margin_floor_pct),
    max_change_pct: numOrNull(row.max_change_pct),
    inventory_cap_applied: Boolean(row.inventory_cap_applied),
    binding: (row.binding as RecommendationRow['binding']) ?? [],
    candidates_evaluated: num(row.candidates_evaluated),
    baseline_units_per_day: numOrNull(row.baseline_units_per_day),
    rationale: String(row.rationale ?? ''),
    model_version: String(row.model_version),
    model_run_id: (row.model_run_id as string | null) ?? null,
    computed_at: String(row.computed_at),
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapBand(row: Row): ExpectedBandRow {
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    variant_gid: String(row.variant_gid),
    day: String(row.day) as DayString,
    expected_units: num(row.expected_units),
    low: num(row.low),
    high: num(row.high),
    interval_nominal: num(row.interval_nominal, 0.8),
    band_kind: (row.band_kind as ExpectedBandRow['band_kind']) ?? 'baseline',
    rollout_id: (row.rollout_id as string | null) ?? null,
    breach_probability: numOrNull(row.breach_probability),
    is_floored: Boolean(row.is_floored),
    model_version: String(row.model_version),
    model_run_id: (row.model_run_id as string | null) ?? null,
    generated_at: String(row.generated_at),
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapModelRun(row: Row): ModelRun {
  return {
    id: String(row.id),
    shop_id: (row.shop_id as string | null) ?? null,
    kind: row.kind as ModelRun['kind'],
    model_version: String(row.model_version),
    git_sha: (row.git_sha as string | null) ?? null,
    status: row.status as ModelRun['status'],
    gate_passed: (row.gate_passed as boolean | null) ?? null,
    incumbent_version: (row.incumbent_version as string | null) ?? null,
    metrics: (row.metrics as Record<string, unknown>) ?? {},
    rows_written: num(row.rows_written),
    ingest_key: (row.ingest_key as string | null) ?? null,
    fits_written: num(row.fits_written),
    bands_written: num(row.bands_written),
    reports_written: num(row.reports_written),
    recommendations_written: num(row.recommendations_written),
    notes: (row.notes as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    started_at: String(row.started_at),
    finished_at: (row.finished_at as string | null) ?? null,
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function mapRolloutReport(row: Row): RolloutReportRow {
  const update = (row.elasticity_update as RolloutReportRow['elasticity_update']) ?? (
    row.elasticity_after === null || row.elasticity_after === undefined
      ? null
      : {
          before: numOrNull(row.elasticity_before),
          after: num(row.elasticity_after),
        }
  );
  return {
    id: String(row.id),
    shop_id: String(row.shop_id),
    contract_version: '1.0.0',
    rollout_id: String(row.rollout_id),
    generated_at: String(row.generated_at),
    model_version: String(row.model_version),
    model_run_id: (row.model_run_id as string | null) ?? null,
    window: {
      start_day: String(row.window_start),
      end_day: String(row.window_end),
      days: num(row.window_days),
    },
    predicted: row.predicted as RolloutReportRow['predicted'],
    realized: row.realized as RolloutReportRow['realized'],
    in_range: Boolean(row.in_range),
    elasticity_update: update,
    narrative: String(row.narrative),
    per_variant: (row.per_variant as RolloutReportRow['per_variant']) ?? [],
    created_at: (row.created_at as string | undefined) ?? undefined,
  };
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size) as T[];
}
