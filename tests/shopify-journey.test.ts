import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import { NextRequest } from 'next/server';

import { GET as startOAuth } from '../app/api/auth/route';
import { GET as completeOAuth } from '../app/api/auth/callback/route';
import { PATCH as setCogs } from '../app/api/products/[variantId]/cogs/route';
import { POST as forecast } from '../app/api/forecast/route';
import { POST as createRollout } from '../app/api/rollouts/route';
import { POST as confirmRollout } from '../app/api/rollouts/[id]/confirm/route';
import { POST as rollbackRollout } from '../app/api/rollouts/[id]/rollback/route';
import { POST as receiveWebhook } from '../app/api/webhooks/[topic]/route';
import { DemoAdapter, setAdapter } from '../lib/adapters';
import { CONTRACT_VERSION, type Guardrails } from '../lib/contracts';
import { signOAuthParams, signWebhookBody } from '../lib/shopify/hmac';
import { OAUTH_STATE_COOKIE } from '../lib/shopify/oauth';
import { setPostResponseSchedulerForTests } from '../lib/shopify/post-response';
import { webhookTopicToken } from '../lib/shopify/webhooks';
import type { Rollout, RolloutVariant } from '../lib/types';

const SHOP = 'priceflag-journey-dev.myshopify.com';
const APP_ORIGIN = 'https://priceflag-journey.test';
const PRODUCT_ID = 41001;
const PRODUCT_GID = `gid://shopify/Product/${PRODUCT_ID}`;
const VARIANT_IDS = Array.from({ length: 8 }, (_, index) => 42001 + index);
const VARIANT_GIDS = VARIANT_IDS.map((id) => `gid://shopify/ProductVariant/${id}`);
const BASELINE_CENTS = VARIANT_IDS.map((_, index) => 2_000 + index * 100);
const MANUAL_COGS_CENTS = 975;

interface LiveVariant {
  productGid: string;
  priceCents: number;
  compareAtCents: number | null;
}

interface ShopifyBoundary {
  fetch: typeof fetch;
  live: Map<string, LiveVariant>;
  writes: { requests: number; variants: number };
  webhookRegistrations: { reads: number; writes: number };
}

function jsonRequest(path: string, body: unknown, token: string, method = 'POST'): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function sessionToken(shop: string, apiKey: string, apiSecret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: apiKey,
      sub: 'synthetic-operator',
      exp: now + 300,
      nbf: now - 5,
      iat: now,
      jti: randomBytes(12).toString('hex'),
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function installShopifyBoundary(accessToken: string): ShopifyBoundary {
  const live = new Map<string, LiveVariant>();
  VARIANT_GIDS.forEach((gid, index) => {
    live.set(gid, {
      productGid: PRODUCT_GID,
      priceCents: BASELINE_CENTS[index] as number,
      compareAtCents: null,
    });
  });
  const writes = { requests: 0, variants: 0 };
  const webhookRegistrations = { reads: 0, writes: 0 };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      const requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      assert.equal(requestBody.code, 'synthetic-one-time-code');
      return Response.json({
        access_token: accessToken,
        scope: 'read_products,write_products,read_orders,read_all_orders',
      });
    }

    assert.equal(url, `https://${SHOP}/admin/api/2026-07/graphql.json`);
    const operation = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, any>;
    };
    const query = operation.query;

    if (query.includes('PriceflagWebhookSubscriptions')) {
      webhookRegistrations.reads += 1;
      return Response.json({ data: { webhookSubscriptions: { nodes: [] } } });
    }
    if (query.includes('PriceflagWebhookSubscriptionCreate')) {
      webhookRegistrations.writes += 1;
      return Response.json({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: { id: `gid://shopify/WebhookSubscription/${webhookRegistrations.writes}` },
            userErrors: [],
          },
        },
      });
    }
    if (query.includes('PriceflagShop')) {
      return Response.json({
        data: {
          shop: {
            name: 'Priceflag Synthetic Development Store',
            myshopifyDomain: SHOP,
            ianaTimezone: 'UTC',
            currencyCode: 'USD',
            contactEmail: null,
            plan: { displayName: 'Development' },
          },
        },
      });
    }
    if (query.includes('PriceflagCounts')) {
      return Response.json({
        data: {
          productsCount: { count: 1 },
          ordersCount: { count: 1, precision: 'EXACT' },
        },
      });
    }
    if (query.includes('PriceflagProducts')) {
      return Response.json({
        data: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: PRODUCT_GID,
                title: 'Synthetic Journey Product',
                status: 'ACTIVE',
                vendor: 'Priceflag Test Fixtures',
                productType: 'Development Fixture',
                tags: ['synthetic', 'development-store-only'],
                isGiftCard: false,
                requiresSellingPlan: false,
                sellingPlanGroupsCount: { count: 0 },
                featuredMedia: null,
                variants: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: VARIANT_GIDS.map((gid, index) => ({
                    id: gid,
                    title: `Synthetic Variant ${index + 1}`,
                    sku: `PF-JOURNEY-${index + 1}`,
                    price: ((BASELINE_CENTS[index] as number) / 100).toFixed(2),
                    compareAtPrice: null,
                    inventoryQuantity: 50,
                    availableForSale: true,
                    sellingPlanGroupsCount: { count: 0 },
                    inventoryItem: {
                      id: `gid://shopify/InventoryItem/${43001 + index}`,
                      unitCost: { amount: (8 + index / 10).toFixed(2) },
                    },
                  })),
                },
              },
            ],
          },
        },
      });
    }
    if (query.includes('PriceflagOrders')) {
      return Response.json({
        data: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'gid://shopify/Order/44001',
                createdAt: '2026-08-01T12:00:00Z',
                test: false,
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: VARIANT_GIDS.map((gid, index) => ({
                    id: `gid://shopify/LineItem/${45001 + index}`,
                    quantity: 2,
                    variant: { id: gid },
                    originalTotalSet: {
                      shopMoney: { amount: (((BASELINE_CENTS[index] as number) * 2) / 100).toFixed(2) },
                    },
                    discountedTotalSet: {
                      shopMoney: { amount: (((BASELINE_CENTS[index] as number) * 2 - 125) / 100).toFixed(2) },
                    },
                  })),
                },
                refunds: [
                  {
                    id: 'gid://shopify/Refund/46001',
                    createdAt: '2026-08-02T12:00:00Z',
                    refundLineItems: {
                      nodes: [
                        {
                          quantity: 1,
                          subtotalSet: { shopMoney: { amount: '20.00' } },
                          lineItem: { variant: { id: VARIANT_GIDS[0] } },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      });
    }
    if (query.includes('PriceflagVariantPrices')) {
      return Response.json({
        data: {
          nodes: (operation.variables.ids as string[]).map((gid) => {
            const current = live.get(gid);
            if (current === undefined) return null;
            return {
              id: gid,
              price: (current.priceCents / 100).toFixed(2),
              compareAtPrice:
                current.compareAtCents === null ? null : (current.compareAtCents / 100).toFixed(2),
              product: { id: current.productGid },
            };
          }),
        },
      });
    }
    if (query.includes('PriceflagVariantsBulkUpdate')) {
      writes.requests += 1;
      const inputs = operation.variables.variants as {
        id: string;
        price: string;
        compareAtPrice?: string | null;
      }[];
      writes.variants += inputs.length;
      for (const input of inputs) {
        const current = live.get(input.id);
        assert(current, `write referenced unknown synthetic variant ${input.id}`);
        current.priceCents = Math.round(Number(input.price) * 100);
        if (Object.hasOwn(input, 'compareAtPrice')) {
          current.compareAtCents =
            input.compareAtPrice === null ? null : Math.round(Number(input.compareAtPrice) * 100);
        }
      }
      return Response.json({
        data: {
          productVariantsBulkUpdate: {
            productVariants: inputs.map((input) => {
              const current = live.get(input.id) as LiveVariant;
              return {
                id: input.id,
                price: (current.priceCents / 100).toFixed(2),
                compareAtPrice:
                  current.compareAtCents === null ? null : (current.compareAtCents / 100).toFixed(2),
              };
            }),
            userErrors: [],
          },
        },
      });
    }

    throw new Error('unexpected Shopify boundary operation');
  };

  return { fetch: fetchImpl as typeof fetch, live, writes, webhookRegistrations };
}

function webhook(
  topic: string,
  payload: unknown,
  webhookId: string,
  webhookSecret: string,
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const headers = new Headers({
    'content-type': 'application/json',
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': SHOP,
    'x-shopify-webhook-id': webhookId,
    'x-shopify-hmac-sha256': signWebhookBody(raw, webhookSecret),
    'x-shopify-api-version': '2026-07',
    'x-shopify-triggered-at': '2026-08-11T18:00:00Z',
  });
  const segment = topic.replace(/\//g, '--');
  const token = webhookTopicToken(webhookSecret, topic, SHOP);
  return receiveWebhook(
    new NextRequest(`${APP_ORIGIN}/api/webhooks/${segment}?pf_topic_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers,
      body: raw,
    }),
    { params: Promise.resolve({ topic: segment }) },
  );
}

const guardrails: Guardrails = {
  contract_version: CONTRACT_VERSION,
  auto_rollback: false,
  rules: [
    {
      id: 'journey-units-pause',
      metric: 'units',
      comparison: 'below_expected_pct',
      threshold_pct: 30,
      consecutive_days: 2,
      scope: 'rollout',
      action: 'pause',
      sentence: 'Pause if units fall more than 30% below expected for two days.',
    },
  ],
};

function proposal(includeGuardrails: boolean): Record<string, unknown> {
  return {
    contract_version: CONTRACT_VERSION,
    name: 'Credential-free Shopify journey',
    variant_gids: VARIANT_GIDS,
    change: { type: 'percent', percent: 10, rounding: 'none' },
    ...(includeGuardrails ? { guardrails: structuredClone(guardrails) } : {}),
  };
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const adapter = new DemoAdapter({ persist: false, autoSeed: false });
  setAdapter(adapter);

  const apiKey = randomBytes(16).toString('hex');
  const apiSecret = randomBytes(32).toString('hex');
  const accessToken = randomBytes(24).toString('base64url');
  const encryptionKey = randomBytes(32).toString('base64');
  const boundary = installShopifyBoundary(accessToken);
  globalThis.fetch = boundary.fetch;

  Object.assign(process.env, {
    PRICEFLAG_MODE: 'real',
    SHOPIFY_API_KEY: apiKey,
    SHOPIFY_API_SECRET: apiSecret,
    SHOPIFY_APP_HANDLE: 'priceflag-journey-test',
    SHOPIFY_SCOPES: 'read_products,write_products,read_orders,read_all_orders',
    SHOPIFY_API_VERSION: '2026-07',
    APP_URL: APP_ORIGIN,
    ENCRYPTION_KEY: encryptionKey,
  });

  try {
    // 1. Install and complete OAuth through the real route implementation.
    console.log('[journey] install and OAuth');
    const start = await startOAuth(new NextRequest(`${APP_ORIGIN}/api/auth?shop=${SHOP}`));
    assert.equal(start.status, 307);
    const state = start.cookies.get(OAUTH_STATE_COOKIE)?.value;
    assert(state, 'OAuth start did not mint a state cookie');
    const authorize = new URL(start.headers.get('location') as string);
    assert.equal(authorize.hostname, SHOP);
    assert.equal(authorize.searchParams.get('state'), state);

    const callbackParams = new URLSearchParams({
      code: 'synthetic-one-time-code',
      shop: SHOP,
      state,
      timestamp: '1786471200',
    });
    callbackParams.set('hmac', signOAuthParams(callbackParams, apiSecret));
    const scheduled: Promise<void>[] = [];
    setPostResponseSchedulerForTests((task) => scheduled.push(Promise.resolve().then(task)));
    const callback = await completeOAuth(
      new NextRequest(`${APP_ORIGIN}/api/auth/callback?${callbackParams.toString()}`, {
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
      }),
    );
    assert.equal(callback.status, 307);
    assert.equal(scheduled.length, 1, 'OAuth callback did not schedule post-install work');
    await Promise.all(scheduled);
    console.log('[journey] background sync complete');

    const shop = await adapter.getShopByDomain(SHOP);
    assert(shop, 'OAuth callback did not persist the installed shop');
    assert.equal(shop.mode, 'real');
    assert(shop.access_token_enc, 'OAuth callback did not store encrypted write authority');
    assert.notEqual(shop.access_token_enc, accessToken, 'OAuth token was stored in plaintext');
    assert.equal(boundary.webhookRegistrations.reads, 1);
    assert.equal(boundary.webhookRegistrations.writes, 4);

    // 2. The callback's real background sync imports the full synthetic shape.
    const syncRun = await adapter.getLatestSyncRun(shop.id);
    assert.equal(syncRun?.stage, 'done');
    assert.equal(syncRun?.products_synced, 8);
    assert.equal(syncRun?.orders_processed, 1);
    const syncedProducts = await adapter.listProducts(shop.id, {});
    assert.equal(syncedProducts.total, 8);
    assert(syncedProducts.items.every((product) => product.cogs_source === 'shopify'));
    const syncedDays = await adapter.getOrderDays(shop.id, {});
    assert(syncedDays.some((row) => row.discount_cents > 0), 'discounts were not aggregated');
    assert(syncedDays.some((row) => row.refund_cents > 0), 'refunds were not aggregated');

    const token = sessionToken(SHOP, apiKey, apiSecret);

    // 3. Enter COGS through the real merchant route.
    console.log('[journey] COGS and forecast');
    const cogsResponse = await setCogs(
      jsonRequest(
        `/api/products/${encodeURIComponent(VARIANT_GIDS[0] as string)}/cogs`,
        { cogs_cents: MANUAL_COGS_CENTS },
        token,
        'PATCH',
      ),
      { params: Promise.resolve({ variantId: VARIANT_GIDS[0] as string }) },
    );
    assert.equal(cogsResponse.status, 200);
    const [costed] = await adapter.getProductsByVariantGids(shop.id, [VARIANT_GIDS[0] as string]);
    assert.equal(costed?.cogs_cents, MANUAL_COGS_CENTS);
    assert.equal(costed?.cogs_source, 'manual');

    // 4. Forecast through the real shared engine route.
    const forecastResponse = await forecast(jsonRequest('/api/forecast', proposal(false), token));
    assert.equal(forecastResponse.status, 200);
    const forecastBody = await responseJson(forecastResponse);
    assert.equal(forecastBody.contract_version, CONTRACT_VERSION);
    assert.equal(forecastBody.products.length, 8);

    // 5. Create the real atomic draft and prove frozen baselines + safe guardrails.
    console.log('[journey] draft and first cohort');
    const draftResponse = await createRollout(jsonRequest('/api/rollouts', proposal(true), token));
    const draftBody = await responseJson(draftResponse);
    assert.equal(draftResponse.status, 201, JSON.stringify(draftBody));
    const rolloutId = draftBody.rollout.id as string;
    let rollout = await adapter.getRollout(rolloutId);
    assert.equal(rollout?.status, 'draft');
    assert.equal(rollout?.guardrails.auto_rollback, false);
    const frozen = await adapter.getRolloutVariants(rolloutId);
    assert.equal(frozen.length, 8);
    frozen.forEach((variant) => {
      const sourceIndex = VARIANT_GIDS.indexOf(variant.variant_gid);
      assert.notEqual(sourceIndex, -1);
      assert.equal(variant.baseline_price_cents, BASELINE_CENTS[sourceIndex]);
    });

    // 6. Confirm only the first 25% cohort; retry is idempotent.
    const confirmRequest = () =>
      jsonRequest(`/api/rollouts/${rolloutId}/confirm`, { confirm: true, scheduled_start_at: null }, token);
    const confirmed = await confirmRollout(confirmRequest(), { params: Promise.resolve({ id: rolloutId }) });
    assert.equal(confirmed.status, 200, JSON.stringify(await responseJson(confirmed.clone())));
    rollout = await adapter.getRollout(rolloutId);
    assert.equal(rollout?.status, 'running');
    assert.equal(rollout?.current_stage, 0);
    assert.equal(rollout?.guardrails.auto_rollback, false);
    const firstCohort = frozen.filter((variant) => !variant.excluded && variant.cohort_stage === 0);
    assert.equal(firstCohort.length, 2);
    assert.equal(boundary.writes.requests, 1);
    assert.equal(boundary.writes.variants, 2);
    await confirmRollout(confirmRequest(), { params: Promise.resolve({ id: rolloutId }) });
    assert.equal(boundary.writes.requests, 1, 'confirmation retry repeated a Shopify write');

    // Mirror Shopify's products/update echo for Priceflag's own stage write.
    const ownWritePayload = {
      id: PRODUCT_ID,
      variants: firstCohort.map((variant) => ({
        id: Number(variant.variant_gid.split('/').at(-1)),
        price: (variant.target_price_cents / 100).toFixed(2),
        compare_at_price: null,
      })),
    };
    assert.equal((await webhook('products/update', ownWritePayload, 'journey-own-write', apiSecret)).status, 200);

    // 7. A signed order webhook updates aggregates exactly once.
    console.log('[journey] signed order webhook');
    const orderVariant = firstCohort[0] as RolloutVariant;
    const orderDay = '2026-08-11';
    const beforeOrder = (await adapter.getOrderDays(shop.id, {
      variant_gids: [orderVariant.variant_gid],
      from_day: orderDay,
      to_day: orderDay,
    }))[0];
    const orderPayload = {
      id: 47001,
      created_at: `${orderDay}T18:00:00Z`,
      test: false,
      line_items: [
        {
          variant_id: Number(orderVariant.variant_gid.split('/').at(-1)),
          product_id: PRODUCT_ID,
          quantity: 2,
          price: (orderVariant.target_price_cents / 100).toFixed(2),
          discount_allocations: [{ amount: '1.50' }],
        },
      ],
    };
    const orderDelivery = await webhook('orders/create', orderPayload, 'journey-order', apiSecret);
    assert.equal(orderDelivery.status, 200);
    const afterOrder = (await adapter.getOrderDays(shop.id, {
      variant_gids: [orderVariant.variant_gid],
      from_day: orderDay,
      to_day: orderDay,
    }))[0];
    assert.equal(afterOrder?.units, (beforeOrder?.units ?? 0) + 2);
    assert.equal(afterOrder?.discount_cents, (beforeOrder?.discount_cents ?? 0) + 150);
    const duplicateOrder = await webhook('orders/create', orderPayload, 'journey-order', apiSecret);
    assert.equal(duplicateOrder.status, 200);
    const afterDuplicate = (await adapter.getOrderDays(shop.id, {
      variant_gids: [orderVariant.variant_gid],
      from_day: orderDay,
      to_day: orderDay,
    }))[0];
    assert.equal(afterDuplicate?.units, afterOrder?.units, 'duplicate webhook inflated units');

    // 8-10. Merchant restores one live cohort SKU externally. The signed
    // webhook journals and pauses, and Priceflag performs no compensating write.
    console.log('[journey] external edit and pause');
    const externalVariant = firstCohort[0] as RolloutVariant;
    const externalLive = boundary.live.get(externalVariant.variant_gid) as LiveVariant;
    externalLive.priceCents = externalVariant.baseline_price_cents;
    const writesBeforeExternal = boundary.writes.requests;
    const externalPayload = {
      id: PRODUCT_ID,
      variants: [
        {
          id: Number(externalVariant.variant_gid.split('/').at(-1)),
          price: (externalVariant.baseline_price_cents / 100).toFixed(2),
          compare_at_price: null,
        },
      ],
    };
    const externalDelivery = await webhook('products/update', externalPayload, 'journey-external-edit', apiSecret);
    assert.equal(externalDelivery.status, 200);
    rollout = await adapter.getRollout(rolloutId);
    assert.equal(rollout?.status, 'paused');
    assert.match(rollout?.paused_reason ?? '', /outside Priceflag/);
    assert.equal(rollout?.guardrails.auto_rollback, false);
    assert.equal(boundary.writes.requests, writesBeforeExternal, 'Priceflag overwrote the merchant edit');
    const externalJournal = await adapter.listJournalEntries(shop.id, {
      variant_gids: [externalVariant.variant_gid],
      sources: ['external'],
    });
    assert.equal(externalJournal.total, 1);
    assert.equal(externalJournal.items[0]?.after_price_cents, externalVariant.baseline_price_cents);
    const externalEvents = await adapter.listRolloutEvents(rolloutId);
    assert(externalEvents.some((event) => event.type === 'paused_external_change'));
    await webhook('products/update', externalPayload, 'journey-external-edit', apiSecret);
    assert.equal(
      (await adapter.listJournalEntries(shop.id, { sources: ['external'] })).total,
      1,
      'duplicate product webhook duplicated the external journal',
    );

    // 11-12. Explicit rollback restores the other live cohort SKU from its
    // frozen value, leaves the merchant-restored SKU untouched, and re-reads all.
    console.log('[journey] manual rollback and verification');
    const rollbackRequest = () =>
      jsonRequest(
        `/api/rollouts/${rolloutId}/rollback`,
        { confirm: true, reason: 'Credential-free journey verification.' },
        token,
      );
    const rolledBackResponse = await rollbackRollout(rollbackRequest(), {
      params: Promise.resolve({ id: rolloutId }),
    });
    const rolledBackBody = await responseJson(rolledBackResponse);
    assert.equal(rolledBackResponse.status, 200, JSON.stringify(rolledBackBody));
    assert.equal(rolledBackBody.ok, true);
    assert.equal(boundary.writes.requests, writesBeforeExternal + 1);
    assert.equal(boundary.writes.variants, 3);
    for (const variant of frozen) {
      assert.equal(boundary.live.get(variant.variant_gid)?.priceCents, variant.baseline_price_cents);
    }
    rollout = await adapter.getRollout(rolloutId);
    assert.equal(rollout?.status, 'rolled_back');
    assert.equal(rollout?.guardrails.auto_rollback, false);
    const writesAfterRollback = boundary.writes.requests;
    const rollbackRetry = await rollbackRollout(rollbackRequest(), {
      params: Promise.resolve({ id: rolloutId }),
    });
    assert.equal(rollbackRetry.status, 200);
    assert.equal(boundary.writes.requests, writesAfterRollback, 'rollback retry repeated a Shopify write');
    const rollbackJournal = await adapter.listJournalEntries(shop.id, {
      rollout_id: rolloutId,
      sources: ['rollback'],
    });
    assert.equal(rollbackJournal.total, 1, 'rollback journal was not idempotent');

    // Shopify echoes the successful rollback as products/update. Exercise the
    // real handler so the catalog converges before creating later work.
    const rollbackEcho = {
      id: PRODUCT_ID,
      variants: firstCohort.map((variant) => ({
        id: Number(variant.variant_gid.split('/').at(-1)),
        price: (variant.baseline_price_cents / 100).toFixed(2),
        compare_at_price: null,
      })),
    };
    assert.equal((await webhook('products/update', rollbackEcho, 'journey-rollback-echo', apiSecret)).status, 200);

    // 13-14. Create scheduled active work, then uninstall via the signed route.
    console.log('[journey] uninstall cleanup');
    const secondDraftResponse = await createRollout(jsonRequest('/api/rollouts', proposal(true), token));
    const secondDraftBody = await responseJson(secondDraftResponse);
    assert.equal(secondDraftResponse.status, 201, JSON.stringify(secondDraftBody));
    const scheduledId = secondDraftBody.rollout.id as string;
    const scheduledResponse = await confirmRollout(
      jsonRequest(
        `/api/rollouts/${scheduledId}/confirm`,
        { confirm: true, scheduled_start_at: '2099-01-01T12:00:00.000Z' },
        token,
      ),
      { params: Promise.resolve({ id: scheduledId }) },
    );
    assert.equal(scheduledResponse.status, 200, JSON.stringify(await responseJson(scheduledResponse.clone())));
    const scheduledBeforeUninstall = await adapter.getRollout(scheduledId);
    assert.equal(scheduledBeforeUninstall?.status, 'scheduled');
    assert.equal(scheduledBeforeUninstall?.guardrails.auto_rollback, false);

    const uninstallPayload = { myshopify_domain: SHOP };
    const uninstallResponse = await webhook('app/uninstalled', uninstallPayload, 'journey-uninstall', apiSecret);
    assert.equal(uninstallResponse.status, 200);
    const stopped = await adapter.getRollout(scheduledId);
    assert.equal(stopped?.status, 'paused');
    assert.match(stopped?.paused_reason ?? '', /uninstalled/i);
    assert.equal(stopped?.guardrails.auto_rollback, false);
    const uninstalledShop = await adapter.getShop(shop.id);
    assert(uninstalledShop?.uninstalled_at, 'uninstall did not stamp the shop');
    assert.equal(uninstalledShop?.access_token_enc, null, 'uninstall retained Shopify write authority');
    const writesAfterUninstall = boundary.writes.requests;
    const duplicateUninstall = await webhook('app/uninstalled', uninstallPayload, 'journey-uninstall', apiSecret);
    assert.equal(duplicateUninstall.status, 200);
    assert.equal(boundary.writes.requests, writesAfterUninstall);

    const allRollouts = await adapter.listRollouts(shop.id);
    assert(allRollouts.every((item: Rollout) => item.guardrails.auto_rollback === false));
    assert(allRollouts.every((item: Rollout) => !['draft', 'running', 'scheduled'].includes(item.status)));

    console.log(
      'Shopify journey: OAuth, background sync, COGS, forecast, draft, cohort, signed webhooks, external pause, verified manual rollback, idempotency and uninstall passed.',
    );
  } finally {
    globalThis.fetch = originalFetch;
    setPostResponseSchedulerForTests(null);
    setAdapter(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

void main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
