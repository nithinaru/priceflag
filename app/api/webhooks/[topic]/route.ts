/**
 * `POST /api/webhooks/<topic>` — the single webhook sink.
 *
 * Order of operations is a security property:
 *
 *   1. Read the **raw body**. Parsing first and re-serialising would change key
 *      order and whitespace, and the HMAC would never match.
 *   2. Verify the HMAC. An unverified body is attacker-controlled input, and this
 *      endpoint mutates order history that auto-rollback depends on.
 *   3. De-duplicate on `X-Shopify-Webhook-Id`. Shopify retries; retries are not
 *      rare. A duplicate `orders/create` would inflate a day's units and make a
 *      healthy rollout look like it was outperforming.
 *   4. Only then act.
 *
 * After a verified HMAC this always returns 2xx, even when handling fails. A
 * non-2xx makes Shopify retry for days and eventually disable the subscription;
 * the failure is recorded on the row instead, where it can be retried on our
 * terms.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { env } from '@/lib/config';
import { dayInTimeZone } from '@/lib/dates';
import { buildExternalChangeEntry } from '@/lib/engine/journal';
import { parseMoneyToCents, type Cents } from '@/lib/money';
import { verifyWebhookHmac } from '@/lib/shopify/hmac';
import type { StoreAdapter } from '@/lib/adapters/types';
import type { OrderDayUpsert, Shop } from '@/lib/types';

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
  const webhookId = request.headers.get('x-shopify-webhook-id') ?? `${topic}:${Date.now()}`;
  const adapter = getAdapter();

  const { duplicate } = await adapter.recordWebhook({
    shop_domain: shopDomain,
    topic,
    webhook_id: webhookId,
    api_version: request.headers.get('x-shopify-api-version'),
    triggered_at: request.headers.get('x-shopify-triggered-at'),
    // GDPR payloads are never retained.
    payload: GDPR_TOPICS.has(topic) ? null : safeParse(rawBody),
  });

  if (duplicate) {
    return NextResponse.json({ ok: true, deduplicated: true });
  }

  try {
    await handle(adapter, topic, shopDomain, safeParse(rawBody));
    await adapter.markWebhookProcessed(webhookId, 'processed');
  } catch (cause) {
    await adapter.markWebhookProcessed(webhookId, 'failed', cause instanceof Error ? cause.message : String(cause));
    // Still 2xx — see the header comment.
    return NextResponse.json({ ok: false, recorded: true });
  }

  return NextResponse.json({ ok: true });
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
  shopDomain: string,
  payload: Record<string, unknown> | null,
): Promise<void> {
  if (GDPR_TOPICS.has(topic)) {
    // Acknowledged and recorded. `shop/redact` is a manual, audited operation —
    // it deletes a merchant's entire price history, so it is not something a
    // webhook handler should do unattended.
    return;
  }

  const shop = shopDomain === '' ? null : await adapter.getShopByDomain(shopDomain);
  if (shop === null || payload === null) return;

  switch (topic) {
    case 'orders/create':
    case 'orders/updated':
      await applyOrder(adapter, shop, payload);
      return;
    case 'products/update':
      await detectExternalPriceChange(adapter, shop, payload);
      return;
    case 'app/uninstalled':
      // Clear the token, keep the shop and its journal: a merchant who reinstalls
      // keeps their price history, and the journal is the recovery path.
      await adapter.updateShop(shop.id, { access_token_enc: null, uninstalled_at: new Date().toISOString() });
      return;
    default:
      return;
  }
}

/** Fold one order into `order_days`, additively and in shop-local time. */
async function applyOrder(
  adapter: StoreAdapter,
  shop: Shop,
  payload: Record<string, unknown>,
): Promise<void> {
  const createdAt = typeof payload.created_at === 'string' ? payload.created_at : new Date().toISOString();
  const day = dayInTimeZone(new Date(createdAt), shop.timezone);
  const lineItems = Array.isArray(payload.line_items) ? (payload.line_items as Record<string, unknown>[]) : [];
  if (lineItems.length === 0) return;

  // Read-modify-write on the day's existing row. The REST webhook payload is one
  // order, but the table's grain is the day.
  const existing = await adapter.getOrderDays(shop.id, { from_day: day, to_day: day });
  const byVariant = new Map(existing.map((row) => [row.variant_gid, row]));
  const rows = new Map<string, OrderDayUpsert>();

  for (const item of lineItems) {
    const variantId = item.variant_id;
    if (variantId === null || variantId === undefined) continue;
    const variantGid = `gid://shopify/ProductVariant/${String(variantId)}`;

    const quantity = Number(item.quantity ?? 0);
    const price: Cents = parseMoneyToCents(String(item.price ?? '0'));
    const discount: Cents = Array.isArray(item.discount_allocations)
      ? (item.discount_allocations as Record<string, unknown>[]).reduce(
          (sum, allocation) =>
            sum + parseMoneyToCents(String((allocation.amount_set as Record<string, never> | undefined) ? '0' : (allocation.amount ?? '0'))),
          0,
        )
      : 0;

    const gross = price * quantity;
    const previous = rows.get(variantGid) ?? toUpsert(byVariant.get(variantGid), variantGid, day);

    previous.units += quantity;
    previous.orders += 1;
    previous.gross_revenue_cents += gross;
    previous.discount_cents += discount;
    previous.net_revenue_cents = previous.gross_revenue_cents - previous.discount_cents - previous.refund_cents;
    const netUnits = Math.max(1, previous.units - previous.refund_units);
    previous.realized_unit_price_cents = Math.round(previous.net_revenue_cents / netUnits);
    previous.on_promo = previous.discount_cents > 0;
    previous.source = 'webhook';

    rows.set(variantGid, previous);
  }

  if (rows.size > 0) await adapter.upsertOrderDays(shop.id, [...rows.values()]);
}

function toUpsert(
  existing: { variant_gid: string; day: string } | undefined,
  variantGid: string,
  day: string,
): OrderDayUpsert {
  if (existing !== undefined) {
    const row = existing as unknown as OrderDayUpsert;
    return { ...row };
  }
  return {
    variant_gid: variantGid,
    product_gid: null,
    day,
    units: 0,
    orders: 0,
    gross_revenue_cents: 0,
    discount_cents: 0,
    refund_units: 0,
    refund_cents: 0,
    net_revenue_cents: 0,
    realized_unit_price_cents: null,
    list_price_cents: null,
    had_stockout: false,
    on_promo: false,
    source: 'webhook',
  };
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
    if (known === undefined || known.price_cents === livePrice) continue;

    // Is this our own write landing back as a webhook? If the journal's newest
    // applied entry already says this price, it was us, and re-journalling it as
    // `external` would pause our own rollout.
    const last = await adapter.getLastJournaledPrice(shop.id, variantGid);
    const ours = last !== null && last.after_price_cents === livePrice && last.source !== 'external';

    await adapter.upsertProducts(shop.id, [
      { ...known, price_cents: livePrice, compare_at_cents: known.compare_at_cents } as never,
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
        after_compare_at_cents: known.compare_at_cents,
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
        paused_reason: `The price of ${known.title} was changed outside Priceflag.`,
      });
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'paused_external_change',
        actor: 'shopify_admin',
        message: `Paused: the price of ${known.title} was changed outside Priceflag, so results would no longer mean what we predicted.`,
        data: { variant_gid: variantGid, found_price_cents: livePrice },
      });
    }
  }
}
