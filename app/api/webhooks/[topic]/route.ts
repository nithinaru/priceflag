/**
 * `POST /api/webhooks/<topic>` — the single webhook sink.
 *
 * Order of operations is a security property:
 *
 *   1. Read the **raw body**. Parsing first and re-serialising would change key
 *      order and whitespace, and the HMAC would never match.
 *   2. Verify the HMAC. An unverified body is attacker-controlled input, and this
 *      endpoint mutates order history that rollout guardrails depend on.
 *   3. De-duplicate on `X-Shopify-Webhook-Id`. Shopify retries; retries are not
 *      rare. A duplicate `orders/create` would inflate a day's units and make a
 *      healthy rollout look like it was outperforming.
 *   4. Only then act.
 *
 * A handler failure returns a retriable non-2xx. Order ingestion is one
 * transaction, and generic failures are explicitly claimable again, so a retry
 * cannot be mistaken for a completed event or permanently acknowledged as lost.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { env } from '@/lib/config';
import { dayInTimeZone } from '@/lib/dates';
import { buildExternalChangeEntry } from '@/lib/engine/journal';
import { ROLLBACK_IN_PROGRESS_PREFIX } from '@/lib/engine/rollout';
import { parseMoneyToCents, roundCents, type Cents } from '@/lib/money';
import { verifyWebhookHmac } from '@/lib/shopify/hmac';
import type { StoreAdapter } from '@/lib/adapters/types';
import type { OrderDayUpsert, Shop, WebhookEventRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Topics that must never store a payload. */
const GDPR_TOPICS = new Set(['customers/data_request', 'customers/redact', 'shop/redact']);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ topic: string }> },
): Promise<NextResponse> {
  const { topic: topicParam } = await context.params;
  // Shopify topics contain a slash; the route segment carries it as `--`.
  const topic = topicParam.replace(/--/g, '/');

  const secret = env('SHOPIFY_API_SECRET');
  if (secret === undefined) {
    return NextResponse.json({ error: 'webhooks are not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const headerHmac = request.headers.get('x-shopify-hmac-sha256');

  if (!verifyWebhookHmac(rawBody, headerHmac, secret)) {
    // 401 is correct here: this did not come from Shopify.
    return NextResponse.json({ error: 'invalid hmac' }, { status: 401 });
  }

  const shopDomain = (request.headers.get('x-shopify-shop-domain') ?? '').toLowerCase();
  const webhookId = request.headers.get('x-shopify-webhook-id');
  if (shopDomain === '' || webhookId === null || webhookId.trim() === '') {
    // Dedupe is part of order-count correctness. Inventing an id here would
    // turn a retry into a second order, so reject malformed deliveries before
    // recording or processing anything.
    return NextResponse.json({ error: 'missing Shopify webhook identity headers' }, { status: 400 });
  }
  const adapter = getAdapter();
  const payload = safeParse(rawBody);
  const shop = await adapter.getShopByDomain(shopDomain);

  if (topic === 'shop/redact') {
    try {
      const result = await adapter.purgeShopForCompliance({
        shopId: shop?.id ?? null,
        shopDomain,
        webhookId,
        triggeredAt: request.headers.get('x-shopify-triggered-at'),
      });
      return NextResponse.json({ ok: true, ...result, audited: true });
    } catch {
      return NextResponse.json(
        { ok: false, retryable: true, error: 'compliance purge could not be verified' },
        { status: 500 },
      );
    }
  }

  if (shop === null) {
    return NextResponse.json({ ok: false, retryable: true, error: 'unknown Shopify shop' }, { status: 404 });
  }

  if (topic === 'orders/create') {
    try {
      const result = await adapter.ingestOrderWebhook({
        event: {
          shop_domain: shopDomain,
          shop_id: shop.id,
          topic,
          webhook_id: webhookId,
          api_version: request.headers.get('x-shopify-api-version'),
          triggered_at: request.headers.get('x-shopify-triggered-at'),
          payload: null,
        },
        rows: orderRows(shop, payload),
      });
      return NextResponse.json({ ok: true, deduplicated: result.duplicate, rows_written: result.rows_written });
    } catch {
      // The event row and order deltas share a transaction, so a 5xx leaves no
      // partial count behind. Shopify can safely retry this same webhook ID.
      return NextResponse.json(
        { ok: false, retryable: true, error: 'order webhook was not committed' },
        { status: 500 },
      );
    }
  }

  let record: WebhookEventRecord;
  try {
    ({ record } = await adapter.recordWebhook({
      shop_domain: shopDomain,
      shop_id: shop.id,
      topic,
      webhook_id: webhookId,
      api_version: request.headers.get('x-shopify-api-version'),
      triggered_at: request.headers.get('x-shopify-triggered-at'),
      // Order and privacy payloads can contain customer identity. Product updates
      // are the only payload retained because their variant prices are needed for
      // conflict diagnosis and contain no customer fields.
      payload: topic === 'products/update' ? payload : null,
    }));
  } catch {
    return NextResponse.json(
      { ok: false, retryable: true, error: 'webhook identity could not be recorded' },
      { status: 500 },
    );
  }

  if (record.status === 'processed' || record.status === 'ignored') {
    return NextResponse.json({ ok: true, deduplicated: true });
  }
  let claimed = false;
  try {
    claimed = await adapter.claimWebhook(webhookId);
  } catch {
    return NextResponse.json(
      { ok: false, retryable: true, error: 'webhook processing could not be claimed' },
      { status: 500 },
    );
  }
  if (!claimed) {
    // Another delivery owns the processing claim. A non-2xx asks Shopify to
    // retry later; it must not race the in-flight handler.
    return NextResponse.json({ ok: false, retryable: true, error: 'webhook is already processing' }, { status: 503 });
  }

  try {
    const disposition = await handle(adapter, topic, shop, payload);
    await adapter.markWebhookProcessed(webhookId, disposition);
    return NextResponse.json({
      ok: true,
      ...(GDPR_TOPICS.has(topic)
        ? { no_customer_identity_stored: true, evidence: 'order_days contains aggregate variant/day measures only' }
        : {}),
    });
  } catch (cause) {
    await adapter.markWebhookProcessed(webhookId, 'failed', cause instanceof Error ? cause.message : String(cause));
    return NextResponse.json(
      { ok: false, retryable: true, error: 'webhook processing failed' },
      { status: 500 },
    );
  }
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function handle(
  adapter: StoreAdapter,
  topic: string,
  shop: Shop,
  payload: Record<string, unknown> | null,
): Promise<'processed' | 'ignored'> {
  if (GDPR_TOPICS.has(topic)) {
    // Orders and these webhook payloads are never stored. There is therefore no
    // customer identity to return or redact; the aggregate fact is audited.
    return 'ignored';
  }
  if (payload === null) return 'ignored';

  switch (topic) {
    case 'products/update':
      await detectExternalPriceChange(adapter, shop, payload);
      return 'processed';
    case 'app/uninstalled':
      // Clear the token, keep the shop and its journal: a merchant who reinstalls
      // keeps their price history, and the journal is the recovery path.
      await adapter.updateShop(shop.id, { access_token_enc: null, uninstalled_at: new Date().toISOString() });
      return 'processed';
    default:
      // orders/updated is deliberately ignored: without storing order IDs, an
      // update cannot be reconciled without double-counting the original.
      return 'ignored';
  }
}

/** One Shopify order → one additive row per distinct variant. */
function orderRows(shop: Shop, payload: Record<string, unknown> | null): OrderDayUpsert[] {
  if (payload === null || payload.test === true) return [];
  const createdAt = typeof payload.created_at === 'string' ? payload.created_at : new Date().toISOString();
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) throw new Error('order created_at is invalid');
  const day = dayInTimeZone(created, shop.timezone);
  const lineItems = Array.isArray(payload.line_items) ? (payload.line_items as Record<string, unknown>[]) : [];
  const grouped = new Map<
    string,
    { units: number; gross: Cents; discount: Cents; product_gid: string | null }
  >();

  for (const item of lineItems) {
    const variantId = item.variant_id;
    if (variantId === null || variantId === undefined) continue;
    const variantGid = `gid://shopify/ProductVariant/${String(variantId)}`;

    const quantity = Number(item.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('order line quantity must be a positive integer');
    const price: Cents = parseMoneyToCents(String(item.price ?? '0'));
    const discount: Cents = Array.isArray(item.discount_allocations)
      ? (item.discount_allocations as Record<string, unknown>[]).reduce(
          (sum, allocation) => sum + discountAllocationCents(allocation),
          0,
        )
      : 0;

    const gross = price * quantity;
    if (discount > gross) throw new Error('order line discount exceeds its gross value');
    const previous = grouped.get(variantGid) ?? {
      units: 0,
      gross: 0,
      discount: 0,
      product_gid:
        item.product_id === null || item.product_id === undefined
          ? null
          : `gid://shopify/Product/${String(item.product_id)}`,
    };
    previous.units += quantity;
    previous.gross += gross;
    previous.discount += discount;
    grouped.set(variantGid, previous);
  }

  return [...grouped].map(([variant_gid, aggregate]) => {
    const net = aggregate.gross - aggregate.discount;
    return {
      variant_gid,
      product_gid: aggregate.product_gid,
      day,
      units: aggregate.units,
      // This is one order, even if Shopify split the same variant into several
      // line items because of discount allocations or fulfillment grouping.
      orders: 1,
      gross_revenue_cents: aggregate.gross,
      discount_cents: aggregate.discount,
      refund_units: 0,
      refund_cents: 0,
      net_revenue_cents: net,
      realized_unit_price_cents: roundCents(net / aggregate.units),
      list_price_cents: roundCents(aggregate.gross / aggregate.units),
      had_stockout: false,
      on_promo: aggregate.discount > 0,
      source: 'webhook',
    };
  });
}

function discountAllocationCents(allocation: Record<string, unknown>): Cents {
  if (allocation.amount !== null && allocation.amount !== undefined) {
    return parseMoneyToCents(String(allocation.amount));
  }
  const amountSet = (allocation.amount_set ?? allocation.amountSet) as Record<string, unknown> | undefined;
  const shopMoney = (amountSet?.shop_money ?? amountSet?.shopMoney) as Record<string, unknown> | undefined;
  const amount = shopMoney?.amount;
  return amount === null || amount === undefined ? 0 : parseMoneyToCents(String(amount));
}

/**
 * R4: a price that moved without us.
 *
 * Journalled as `external`, and any rollout touching the variant is paused. The
 * alternative — carrying on — would attribute somebody's manual promo to our own
 * price change, poisoning both the guardrails and the post-rollout report.
 */
async function detectExternalPriceChange(
  adapter: StoreAdapter,
  shop: Shop,
  payload: Record<string, unknown>,
): Promise<void> {
  const variants = Array.isArray(payload.variants) ? (payload.variants as Record<string, unknown>[]) : [];
  if (variants.length === 0) return;

  const productGid = `gid://shopify/Product/${String(payload.id ?? '')}`;

  for (const variant of variants) {
    const variantGid = `gid://shopify/ProductVariant/${String(variant.id ?? '')}`;
    const livePrice = parseMoneyToCents(String(variant.price ?? '0'));

    const stored = await adapter.getProductsByVariantGids(shop.id, [variantGid]);
    const known = stored[0];
    if (known === undefined) continue;
    // Shopify normally includes compare_at_price in products/update. Preserve
    // the stored value if a test/legacy payload omits the field entirely, but
    // treat an explicit null as clearing it.
    const hasCompareAt = Object.prototype.hasOwnProperty.call(variant, 'compare_at_price');
    const compareAtValue = variant.compare_at_price;
    const liveCompareAt = !hasCompareAt
      ? known.compare_at_cents
      : compareAtValue === null || compareAtValue === undefined
        ? null
        : parseMoneyToCents(String(compareAtValue));
    if (known.price_cents === livePrice && known.compare_at_cents === liveCompareAt) continue;

    // Is this our own write landing back as a webhook? If the journal's newest
    // applied entry already says this price, it was us, and re-journalling it as
    // `external` would pause our own rollout.
    const last = await adapter.getLastJournaledPrice(shop.id, variantGid);
    const journalSaysOurs =
      last !== null &&
      last.after_price_cents === livePrice &&
      last.after_compare_at_cents === liveCompareAt &&
      last.source !== 'external';
    // Shopify can deliver products/update before our post-mutation journal row
    // is visible. A running rollout has already frozen the exact target and live
    // cohort before applyStage calls Shopify, so that state is a safe second
    // signal for a forward write. Baselines are accepted only while the rollout
    // holds the explicit rollback-in-progress state, so a genuine merchant
    // restore is not hidden.
    const rolloutSaysOurs = await isExpectedPriceflagWrite(
      adapter,
      shop,
      variantGid,
      livePrice,
      liveCompareAt,
    );
    const ours = journalSaysOurs || rolloutSaysOurs;

    await adapter.upsertProducts(shop.id, [
      { ...known, price_cents: livePrice, compare_at_cents: liveCompareAt } as never,
    ]);

    if (ours) continue;

    await adapter.appendJournalEntries(shop.id, [
      buildExternalChangeEntry({
        variant_gid: variantGid,
        product_gid: productGid,
        title: known.title,
        sku: known.sku,
        before_price_cents: known.price_cents,
        after_price_cents: livePrice,
        before_compare_at_cents: known.compare_at_cents,
        after_compare_at_cents: liveCompareAt,
        currency: shop.currency,
      }),
    ]);

    // Pause any rollout that touches this variant.
    for (const rollout of await adapter.listRollouts(shop.id, ['running', 'scheduled'])) {
      const affected = (await adapter.getRolloutVariants(rollout.id)).some(
        (row) => row.variant_gid === variantGid && !row.excluded,
      );
      if (!affected) continue;

      await adapter.updateRollout(rollout.id, {
        status: 'paused',
        paused_reason: `The pricing of ${known.title} was changed outside Priceflag.`,
      });
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'paused_external_change',
        actor: 'shopify_admin',
        message: `Paused: the price or compare-at price of ${known.title} was changed outside Priceflag, so results would no longer mean what we predicted.`,
        data: {
          variant_gid: variantGid,
          found_price_cents: livePrice,
          found_compare_at_cents: liveCompareAt,
        },
      });
    }
  }
}

async function isExpectedPriceflagWrite(
  adapter: StoreAdapter,
  shop: Shop,
  variantGid: string,
  livePrice: Cents,
  liveCompareAt: Cents | null,
): Promise<boolean> {
  for (const rollout of await adapter.listRollouts(shop.id, ['running', 'paused'])) {
    const planned = (await adapter.getRolloutVariants(rollout.id)).find(
      (row) => !row.excluded && row.variant_gid === variantGid,
    );
    if (planned === undefined) continue;

    const expectedForward =
      rollout.status === 'running' &&
      planned.cohort_stage <= rollout.current_stage &&
      planned.target_price_cents === livePrice &&
      planned.target_compare_at_cents === liveCompareAt;
    const expectedRollback =
      rollout.status === 'paused' &&
      rollout.paused_reason?.startsWith(ROLLBACK_IN_PROGRESS_PREFIX) === true &&
      planned.baseline_price_cents === livePrice &&
      planned.baseline_compare_at_cents === liveCompareAt;
    if (expectedForward || expectedRollback) return true;
  }
  return false;
}
