import assert from 'node:assert/strict';

import { NextRequest } from 'next/server';

import { POST } from '../app/api/webhooks/[topic]/route';
import { DemoAdapter, setAdapter } from '../lib/adapters';
import { DEMO_SHOP_DOMAIN } from '../lib/demo/generator';
import { signWebhookBody } from '../lib/shopify/hmac';
import type { AdminGraphqlClient } from '../lib/shopify/client';
import type { ShopCredentials } from '../lib/shopify/credentials';
import {
  reconcileWebhooks,
  REQUIRED_WEBHOOK_TOPICS,
  webhookCallbackUrl,
  webhookTopicToken,
} from '../lib/shopify/webhooks';
import { makeRolloutCreate } from './integration/_harness';

const SECRET = 'webhook-test-secret';
process.env.SHOPIFY_API_SECRET = SECRET;

const adapter = DemoAdapter.ephemeral(91);
setAdapter(adapter);

function delivery(
  topic: string,
  payload: unknown,
  webhookId: string,
  options: {
    shop?: string;
    hmac?: string | null;
    includeIdentity?: boolean;
    topicHeader?: string;
    tokenTopic?: string;
    tokenShop?: string;
  } = {},
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-shopify-topic', options.topicHeader ?? topic);
  const includeIdentity = options.includeIdentity ?? true;
  if (includeIdentity) {
    headers.set('x-shopify-shop-domain', options.shop ?? DEMO_SHOP_DOMAIN);
    headers.set('x-shopify-webhook-id', webhookId);
  }
  if (options.hmac !== null) headers.set('x-shopify-hmac-sha256', options.hmac ?? signWebhookBody(raw, SECRET));
  return POST(
    new NextRequest(
      `http://localhost/api/webhooks/${topic.replace(/\//g, '--')}?pf_topic_token=${encodeURIComponent(
        webhookTopicToken(
          SECRET,
          options.tokenTopic ?? topic,
          ['customers/data_request', 'customers/redact', 'shop/redact'].includes(topic)
            ? undefined
            : (options.tokenShop ?? options.shop ?? DEMO_SHOP_DOMAIN),
        ),
      )}`,
      {
      method: 'POST',
      headers,
      body: raw,
      },
    ),
    { params: Promise.resolve({ topic: topic.replace(/\//g, '--') }) },
  );
}

function order(variantId: string, productId: string, lines = 1): Record<string, unknown> {
  return {
    id: 8001,
    created_at: '2099-01-01T12:00:00Z',
    test: false,
    line_items: Array.from({ length: lines }, (_, index) => ({
      variant_id: variantId,
      product_id: productId,
      quantity: index === 0 ? 2 : 1,
      price: '10.00',
      discount_allocations:
        index === 0
          ? [{ amount_set: { shop_money: { amount: '1.25' } } }]
          : [{ amount: '0.75' }],
    })),
  };
}

function refund(
  variantId: string,
  productId: string,
  amount = '8.75',
  createdAt = '2099-01-02T12:00:00Z',
): Record<string, unknown> {
  return {
    id: 9001,
    created_at: createdAt,
    refund_line_items: [
      {
        quantity: 1,
        subtotal_set: { shop_money: { amount } },
        line_item: { variant_id: variantId, product_id: productId },
      },
    ],
  };
}

async function main(): Promise<void> {
  assert.deepEqual(
    REQUIRED_WEBHOOK_TOPICS.map((topic) => topic.topicPath),
    ['orders/create', 'refunds/create', 'products/update', 'app/uninstalled'],
    'the install registrar covers the required operational topics exactly',
  );
  const callback = new URL(
    webhookCallbackUrl(
      'https://priceflag-app.vercel.app/',
      'orders--create',
      'orders/create',
      SECRET,
      DEMO_SHOP_DOMAIN,
    ),
  );
  assert.equal(callback.origin + callback.pathname, 'https://priceflag-app.vercel.app/api/webhooks/orders--create');
  assert.equal(
    callback.searchParams.get('pf_topic_token'),
    webhookTopicToken(SECRET, 'orders/create', DEMO_SHOP_DOMAIN),
  );

  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fakeClient = {
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      calls.push({ query, variables });
      if (query.includes('PriceflagWebhookSubscriptions')) {
        return {
          webhookSubscriptions: {
            nodes: [
              {
                id: 'gid://shopify/WebhookSubscription/1',
                topic: 'ORDERS_CREATE',
                uri: webhookCallbackUrl(
                  'https://app.test',
                  'orders--create',
                  'orders/create',
                  SECRET,
                  DEMO_SHOP_DOMAIN,
                ),
              },
              {
                id: 'gid://shopify/WebhookSubscription/1-duplicate',
                topic: 'ORDERS_CREATE',
                uri: 'https://old.test/api/webhooks/orders--create',
              },
              {
                id: 'gid://shopify/WebhookSubscription/2',
                topic: 'PRODUCTS_UPDATE',
                uri: 'https://old.test/api/webhooks/products--update',
              },
              {
                id: 'gid://shopify/WebhookSubscription/2-duplicate',
                topic: 'PRODUCTS_UPDATE',
                uri: 'https://older.test/api/webhooks/products--update',
              },
            ],
          },
        } as T;
      }
      if (query.includes('PriceflagWebhookSubscriptionDelete')) {
        return {
          webhookSubscriptionDelete: {
            deletedWebhookSubscriptionId: String(variables.id),
            userErrors: [],
          },
        } as T;
      }
      if (query.includes('PriceflagWebhookSubscriptionUpdate')) {
        return {
          webhookSubscriptionUpdate: {
            webhookSubscription: { id: String(variables.id) },
            userErrors: [],
          },
        } as T;
      }
      return {
        webhookSubscriptionCreate: {
          webhookSubscription: { id: 'gid://shopify/WebhookSubscription/3' },
          userErrors: [],
        },
      } as T;
    },
  } as unknown as AdminGraphqlClient;
  const credentials = {
    shopDomain: DEMO_SHOP_DOMAIN,
    accessToken: 'not-used-by-injected-client',
    apiVersion: '2026-07',
    source: 'oauth_stored',
  } satisfies ShopCredentials;
  const reconciled = await reconcileWebhooks(credentials, 'https://app.test/', {
    client: fakeClient,
    webhookSecret: SECRET,
  });
  assert.deepEqual(reconciled, {
    created: ['REFUNDS_CREATE', 'APP_UNINSTALLED'],
    updated: ['PRODUCTS_UPDATE'],
    ok: ['ORDERS_CREATE'],
    deleted: [
      'gid://shopify/WebhookSubscription/1-duplicate',
      'gid://shopify/WebhookSubscription/2-duplicate',
    ],
  });
  assert.equal(calls.length, 6, 'one read, two duplicate deletes, one repoint, and two creates');
  assert.deepEqual(calls[1]?.variables, { id: 'gid://shopify/WebhookSubscription/1-duplicate' });
  assert.deepEqual(calls[2]?.variables, {
    topic: 'REFUNDS_CREATE',
    webhookSubscription: {
      uri: webhookCallbackUrl(
        'https://app.test',
        'refunds--create',
        'refunds/create',
        SECRET,
        DEMO_SHOP_DOMAIN,
      ),
      format: 'JSON',
    },
  });
  assert.deepEqual(calls[3]?.variables, {
    id: 'gid://shopify/WebhookSubscription/2',
    webhookSubscription: {
      uri: webhookCallbackUrl(
        'https://app.test',
        'products--update',
        'products/update',
        SECRET,
        DEMO_SHOP_DOMAIN,
      ),
    },
  });
  assert.deepEqual(calls[4]?.variables, { id: 'gid://shopify/WebhookSubscription/2-duplicate' });
  assert.deepEqual(calls[5]?.variables, {
    topic: 'APP_UNINSTALLED',
    webhookSubscription: {
      uri: webhookCallbackUrl(
        'https://app.test',
        'app--uninstalled',
        'app/uninstalled',
        SECRET,
        DEMO_SHOP_DOMAIN,
      ),
      format: 'JSON',
    },
  });

  const shop = await adapter.getShopByDomain(DEMO_SHOP_DOMAIN);
  assert(shop);
  const product = (await adapter.listProducts(shop.id, { limit: 1 })).items[0];
  assert(product);
  const variantId = product.variant_gid.split('/').at(-1) as string;
  const productId = product.product_gid.split('/').at(-1) as string;
  const other = await adapter.upsertShop({ shop_domain: 'other-webhook-test.myshopify.com', timezone: 'UTC' });

  assert.equal((await delivery('orders/create', order(variantId, productId), 'bad-hmac', { hmac: 'wrong' })).status, 401);
  assert.equal(
    (
      await delivery('shop/redact', order(variantId, productId), 'topic-replay', {
        topicHeader: 'orders/create',
      })
    ).status,
    400,
    'a valid body signature for one topic cannot be replayed at a destructive endpoint',
  );
  assert.equal(
    (
      await delivery(
        'shop/redact',
        {
          shop_id: 1,
          shop_domain: DEMO_SHOP_DOMAIN,
          customer: { id: 99 },
          orders_to_redact: [1],
        },
        'relabel-customer-redact',
        {
          topicHeader: 'shop/redact',
          tokenTopic: 'customers/redact',
        },
      )
    ).status,
    401,
    'changing both the route and header cannot reuse another topic capability',
  );
  assert.equal(
    (await delivery('orders/create', order(variantId, productId), 'missing-id', { includeIdentity: false })).status,
    400,
  );

  const first = await delivery('orders/create', order(variantId, productId, 2), 'order-1');
  assert.equal(first.status, 200);
  const firstRow = (await adapter.getOrderDays(shop.id, { from_day: '2099-01-01', to_day: '2099-01-01' }))[0];
  assert(firstRow);
  assert.equal(firstRow.units, 3);
  assert.equal(firstRow.orders, 1, 'same variant twice in one order counts as one distinct order');
  assert.equal(firstRow.gross_revenue_cents, 3000);
  assert.equal(firstRow.discount_cents, 200, 'amount_set and legacy amount discounts are both parsed');

  const refunded = await delivery('refunds/create', refund(variantId, productId), 'refund-1');
  assert.equal(refunded.status, 200);
  const refundRow = (await adapter.getOrderDays(shop.id, { from_day: '2099-01-02', to_day: '2099-01-02' }))[0];
  assert(refundRow);
  assert.equal(refundRow.units, 0);
  assert.equal(refundRow.orders, 0);
  assert.equal(refundRow.refund_units, 1);
  assert.equal(refundRow.refund_cents, 875);
  assert.equal(refundRow.net_revenue_cents, -875, 'post-order refund did not reduce live net revenue');
  const refundRetry = await delivery('refunds/create', refund(variantId, productId), 'refund-1');
  assert.equal(refundRetry.status, 200);
  assert.equal((await refundRetry.json()).deduplicated, true);
  const dedupedRefundRow = (await adapter.getOrderDays(shop.id, { from_day: '2099-01-02', to_day: '2099-01-02' }))[0];
  assert.equal(dedupedRefundRow?.refund_cents, 875, 'a retried refund was counted twice');

  const highValueRefund = await delivery(
    'refunds/create',
    refund(variantId, productId, '50.00', '2099-01-01T18:00:00Z'),
    'refund-high-value',
  );
  assert.equal(highValueRefund.status, 200);
  const mixedRow = (await adapter.getOrderDays(shop.id, { from_day: '2099-01-01', to_day: '2099-01-01' }))[0];
  assert(mixedRow);
  assert.equal(mixedRow.units - mixedRow.refund_units, 2);
  assert(mixedRow.net_revenue_cents < 0, 'the regression fixture did not create negative mixed-day revenue');
  assert.equal(
    mixedRow.realized_unit_price_cents,
    null,
    'negative mixed-day revenue was represented as an invalid negative realized price',
  );

  const retry = await delivery('orders/create', order(variantId, productId, 2), 'order-1');
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).deduplicated, true);

  const sameIdConcurrent = await Promise.all([
    delivery('orders/create', order(variantId, productId), 'order-2'),
    delivery('orders/create', order(variantId, productId), 'order-2'),
  ]);
  assert(sameIdConcurrent.every((response) => response.status === 200));

  const distinctConcurrent = await Promise.all([
    delivery('orders/create', order(variantId, productId), 'order-3'),
    delivery('orders/create', order(variantId, productId), 'order-4'),
  ]);
  assert(distinctConcurrent.every((response) => response.status === 200));
  const concurrentRow = (await adapter.getOrderDays(shop.id, { from_day: '2099-01-01', to_day: '2099-01-01' }))[0];
  assert(concurrentRow);
  assert.equal(concurrentRow.orders, 4, 'one original + one deduped concurrent + two distinct concurrent orders');

  const collision = await delivery('orders/create', order(variantId, productId), 'order-1', {
    shop: other.shop_domain,
  });
  assert.equal(collision.status, 500, 'a webhook ID cannot be rebound across shops');

  const invalid = order(variantId, productId);
  (invalid.line_items as Record<string, unknown>[])[0]!.discount_allocations = [{ amount: '99.00' }];
  assert.equal((await delivery('orders/create', invalid, 'order-retry')).status, 500);
  assert.equal((await delivery('orders/create', order(variantId, productId), 'order-retry')).status, 200);

  const now = new Date().toISOString();
  const rollout = await adapter.createRollout(
    makeRolloutCreate({
      shop_id: shop.id,
      status: 'running',
      current_stage: 0,
      started_at: now,
      stage_entered_at: now,
      guardrails: { contract_version: '1.0.0', auto_rollback: false, rules: [] },
    }),
  );
  await adapter.insertRolloutVariants([
    {
      rollout_id: rollout.id,
      shop_id: shop.id,
      variant_gid: product.variant_gid,
      product_gid: product.product_gid,
      title: product.title,
      sku: product.sku,
      baseline_price_cents: product.price_cents,
      baseline_compare_at_cents: product.compare_at_cents,
      target_price_cents: product.price_cents + 100,
      target_compare_at_cents: product.compare_at_cents,
      compare_at_action: 'keep',
      baseline_units_per_day: 1,
      cogs_cents_at_creation: product.cogs_cents,
      cohort_stage: 0,
      excluded: false,
      exclusion_reason: null,
    },
  ]);
  const merchantEdit = await delivery(
    'products/update',
    { id: productId, variants: [{ id: variantId, price: '77.77' }] },
    'product-edit-1',
  );
  assert.equal(merchantEdit.status, 200);
  assert.equal((await adapter.getRollout(rollout.id))?.status, 'paused');
  assert((await adapter.listJournalEntries(shop.id, { sources: ['external'] })).total > 0);
  assert.equal(
    (
      await delivery(
        'products/update',
        { id: productId, variants: [{ id: variantId, price: '88.88' }] },
        'product-edit-1',
        { shop: other.shop_domain },
      )
    ).status,
    500,
    'a generic webhook ID cannot be rebound across shops',
  );

  const compareProduct = (await adapter.listProducts(shop.id, { limit: 2 })).items[1];
  assert(compareProduct);
  const compareVariantId = compareProduct.variant_gid.split('/').at(-1) as string;
  const compareProductId = compareProduct.product_gid.split('/').at(-1) as string;
  const compareRollout = await adapter.createRollout(
    makeRolloutCreate({
      shop_id: shop.id,
      status: 'running',
      current_stage: 0,
      started_at: now,
      stage_entered_at: now,
      guardrails: { contract_version: '1.0.0', auto_rollback: false, rules: [] },
    }),
  );
  await adapter.insertRolloutVariants([
    {
      rollout_id: compareRollout.id,
      shop_id: shop.id,
      variant_gid: compareProduct.variant_gid,
      product_gid: compareProduct.product_gid,
      title: compareProduct.title,
      sku: compareProduct.sku,
      baseline_price_cents: compareProduct.price_cents,
      baseline_compare_at_cents: compareProduct.compare_at_cents,
      target_price_cents: compareProduct.price_cents + 100,
      target_compare_at_cents: compareProduct.compare_at_cents,
      compare_at_action: 'keep',
      baseline_units_per_day: 1,
      cogs_cents_at_creation: compareProduct.cogs_cents,
      cohort_stage: 0,
      excluded: false,
      exclusion_reason: null,
    },
  ]);
  const compareOnlyPayload = {
    id: compareProductId,
    variants: [
      {
        id: compareVariantId,
        price: (compareProduct.price_cents / 100).toFixed(2),
        compare_at_price: ((compareProduct.price_cents + 500) / 100).toFixed(2),
      },
    ],
  };
  const busyDelivery = await adapter.withRolloutLock(compareRollout.id, async () =>
    delivery('products/update', compareOnlyPayload, 'product-edit-compare-at'),
  );
  assert(busyDelivery.acquired);
  assert.equal(busyDelivery.result?.status, 500, 'a busy evaluator lease must make Shopify retry the external edit');
  assert.equal((await adapter.getRollout(compareRollout.id))?.status, 'running');
  assert.equal(
    (await adapter.getProductsByVariantGids(shop.id, [compareProduct.variant_gid]))[0]?.compare_at_cents,
    compareProduct.compare_at_cents,
    'a failed pause must not upsert away the external difference needed by the retry',
  );

  const compareOnlyEdit = await delivery(
    'products/update',
    compareOnlyPayload,
    'product-edit-compare-at',
  );
  assert.equal(compareOnlyEdit.status, 200);
  assert.equal(
    (await adapter.getRollout(compareRollout.id))?.status,
    'paused',
    'a compare-at-only merchant edit must pause the rollout',
  );

  const uninstallRunning = await adapter.createRollout(
    makeRolloutCreate({
      shop_id: shop.id,
      status: 'running',
      current_stage: 0,
      started_at: now,
      stage_entered_at: now,
      guardrails: { contract_version: '1.0.0', auto_rollback: false, rules: [] },
    }),
  );
  const uninstallScheduled = await adapter.createRollout(
    makeRolloutCreate({
      shop_id: shop.id,
      status: 'scheduled',
      scheduled_start_at: '2099-01-02T12:00:00.000Z',
      guardrails: { contract_version: '1.0.0', auto_rollback: false, rules: [] },
    }),
  );
  const uninstallDraft = await adapter.createRollout(
    makeRolloutCreate({
      shop_id: shop.id,
      status: 'draft',
      guardrails: { contract_version: '1.0.0', auto_rollback: false, rules: [] },
    }),
  );
  const uninstallPayload = { myshopify_domain: DEMO_SHOP_DOMAIN };
  const reboundUninstall = await delivery('app/uninstalled', uninstallPayload, 'uninstall-rebound-token', {
    shop: other.shop_domain,
    tokenShop: DEMO_SHOP_DOMAIN,
  });
  assert.equal(reboundUninstall.status, 401, 'an uninstall callback capability cannot cross shops');
  const mismatchedUninstallBody = await delivery(
    'app/uninstalled',
    uninstallPayload,
    'uninstall-rebound-body',
    { shop: other.shop_domain },
  );
  assert.equal(mismatchedUninstallBody.status, 400, 'the signed uninstall shop must match its header');

  const uninstall = await delivery('app/uninstalled', uninstallPayload, 'uninstall-1');
  assert.equal(uninstall.status, 200);
  assert.equal((await adapter.getRollout(uninstallRunning.id))?.status, 'paused');
  assert.equal((await adapter.getRollout(uninstallScheduled.id))?.status, 'paused');
  assert.equal((await adapter.getRollout(uninstallDraft.id))?.status, 'cancelled');
  assert(
    (await adapter.listRolloutEvents(uninstallRunning.id)).some(
      (event) => event.type === 'note' && event.data.action === 'app_uninstalled',
    ),
    'uninstall pause was not journalled on the rollout',
  );
  const uninstalledShop = await adapter.getShop(shop.id);
  assert.equal(uninstalledShop?.access_token_enc, null);
  assert(uninstalledShop?.uninstalled_at !== null, 'uninstall did not revoke shop state');

  const privacy = await delivery('customers/data_request', { customer: { email: 'never-store@example.com' } }, 'privacy-1');
  const privacyBody = await privacy.json();
  assert.equal(privacy.status, 200);
  assert.equal(privacyBody.no_customer_identity_stored, true);

  const redactPayload = { shop_id: 1, shop_domain: DEMO_SHOP_DOMAIN };
  assert.equal(
    (
      await delivery('shop/redact', redactPayload, 'cross-shop-redact-replay', {
        shop: other.shop_domain,
      })
    ).status,
    400,
    'a signed redact payload cannot be rebound to another shop through an unsigned header',
  );
  const purge = await delivery('shop/redact', redactPayload, 'purge-1');
  assert.equal(purge.status, 200);
  assert.equal((await purge.json()).audited, true);
  assert.equal(await adapter.getShopByDomain(DEMO_SHOP_DOMAIN), null);
  assert(await adapter.getShopByDomain(other.shop_domain), 'purge must not cross shop scope');
  assert.equal((await adapter.listJournalEntries(shop.id)).total, 0);
  assert.equal((await adapter.getOrderDays(shop.id)).length, 0);
  assert.equal((await delivery('shop/redact', redactPayload, 'purge-1')).status, 200, 'purge retries dedupe');

  setAdapter(null);
  console.log('Webhook integrity: HMAC, identity, dedupe, merchant edits, uninstall pause and purge passed.');
}

void main();
