import { createHmac } from 'node:crypto';

import { DemoAdapter, setAdapter } from '../lib/adapters';
import { SupabaseAdapter } from '../lib/adapters/supabase';
import { CONTRACT_VERSION, type Guardrails, type RolloutReport } from '../lib/contracts';
import { DEMO_SHOP_DOMAIN } from '../lib/demo/generator';
import { encryptSecret } from '../lib/crypto';
import type { ProductUpsert, Rollout, RolloutVariant } from '../lib/types';
import { POST as forecast } from '../app/api/forecast/route';
import { GET as listRollouts, POST as createRollout } from '../app/api/rollouts/route';
import { GET as getRollout } from '../app/api/rollouts/[id]/route';
import { POST as confirmRollout } from '../app/api/rollouts/[id]/confirm/route';
import { POST as pauseRollout } from '../app/api/rollouts/[id]/pause/route';
import { POST as rollback } from '../app/api/rollouts/[id]/rollback/route';
import { POST as cancelRollout } from '../app/api/rollouts/[id]/cancel/route';
import { GET as getRolloutReport } from '../app/api/rollouts/[id]/report/route';
import { GET as journal } from '../app/api/journal/route';
import { POST as killSwitch, DELETE as releaseKillSwitch } from '../app/api/kill-switch/route';
import { POST as sync } from '../app/api/sync/route';
import { GET as syncStatus } from '../app/api/sync/status/route';
import { PATCH as setCogs } from '../app/api/products/[variantId]/cogs/route';
import { GET as listProducts } from '../app/api/products/route';
import { GET as getShopSettings, PATCH as updateShopSettings } from '../app/api/shop/route';
import { GET as getLive } from '../app/api/live/route';
import { POST as reconcileWebhookSubscriptions } from '../app/api/webhook-subscriptions/route';

const API_KEY = 'merchant-api-test-key';
const API_SECRET = 'merchant-api-test-secret';
const OTHER_SHOP = 'other-merchant.myshopify.com';
const CHAIN_SHOP = 'chain-safety.myshopify.com';
const originalFetch = globalThis.fetch;

interface TestCase {
  name: string;
  run: () => Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function token(shop: string, overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: API_KEY,
      sub: 'merchant-user-1',
      exp: now + 60,
      nbf: now - 5,
      iat: now,
      jti: `jti-${shop}`,
      ...overrides,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', API_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function request(path: string, body: unknown, bearer?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request(`https://priceflag.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function authGet(path: string, bearer?: string): Request {
  return new Request(`https://priceflag.test${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
  });
}

function patchRequest(path: string, body: unknown, bearer?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request(`https://priceflag.test${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

function deleteRequest(path: string, body: unknown, bearer?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request(`https://priceflag.test${path}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

const guardrails: Guardrails = {
  contract_version: CONTRACT_VERSION,
  auto_rollback: false,
  rules: [
    {
      id: 'units-30-2d',
      metric: 'units',
      comparison: 'below_expected_pct',
      threshold_pct: 30,
      consecutive_days: 2,
      scope: 'rollout',
      action: 'pause',
      sentence: 'Pause if daily units fall more than 30% below expected for two days.',
    },
  ],
};

function proposal(variantGid: string, includeGuardrails = false): Record<string, unknown> {
  return {
    contract_version: CONTRACT_VERSION,
    name: 'Merchant API test',
    variant_gids: [variantGid],
    change: { type: 'percent', percent: 10, rounding: 'none' },
    ...(includeGuardrails ? { guardrails: structuredClone(guardrails) } : {}),
  };
}

interface MockLivePrice {
  price: number;
  compareAt: number | null;
  productGid: string;
}

function installShopifyPriceMock(
  variants: readonly RolloutVariant[],
  initial: 'baseline' | 'target' = 'baseline',
): { live: Map<string, MockLivePrice>; writes: { count: number } } {
  const live = new Map<string, MockLivePrice>();
  for (const variant of variants) {
    live.set(variant.variant_gid, {
      price: initial === 'baseline' ? variant.baseline_price_cents : variant.target_price_cents,
      compareAt:
        initial === 'baseline' ? variant.baseline_compare_at_cents : variant.target_compare_at_cents,
      productGid: variant.product_gid,
    });
  }
  const writes = { count: 0 };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const operation = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, any>;
    };
    if (operation.query.includes('PriceflagVariantPrices')) {
      return Response.json({
        data: {
          nodes: (operation.variables.ids as string[]).map((gid) => {
            const current = live.get(gid);
            if (current === undefined) return null;
            return {
              id: gid,
              price: (current.price / 100).toFixed(2),
              compareAtPrice: current.compareAt === null ? null : (current.compareAt / 100).toFixed(2),
              product: { id: current.productGid },
            };
          }),
        },
      });
    }
    if (!operation.query.includes('PriceflagVariantsBulkUpdate')) {
      throw new Error('unexpected Shopify operation');
    }
    writes.count += 1;
    const inputs = operation.variables.variants as {
      id: string;
      price: string;
      compareAtPrice?: string | null;
    }[];
    for (const input of inputs) {
      const current = live.get(input.id);
      assert(current !== undefined, `write referenced unknown variant ${input.id}`);
      current.price = Math.round(Number(input.price) * 100);
      if (Object.hasOwn(input, 'compareAtPrice')) {
        current.compareAt = input.compareAtPrice === null ? null : Math.round(Number(input.compareAtPrice) * 100);
      }
    }
    return Response.json({
      data: {
        productVariantsBulkUpdate: {
          productVariants: inputs.map((input) => {
            const current = live.get(input.id) as MockLivePrice;
            return {
              id: input.id,
              price: (current.price / 100).toFixed(2),
              compareAtPrice: current.compareAt === null ? null : (current.compareAt / 100).toFixed(2),
            };
          }),
          userErrors: [],
        },
      },
    });
  }) as typeof fetch;
  return { live, writes };
}

let adapter: DemoAdapter;
let shopId: string;
let otherShopId: string;
let variantGid: string;
let secondVariantGid: string;
let createdRollout: Rollout;
let createdVariant: RolloutVariant;

async function createTestDraft(gids: string[] = [variantGid]): Promise<{ rollout: Rollout; variants: RolloutVariant[] }> {
  const input = proposal(gids[0] as string, true);
  input.variant_gids = gids;
  const response = await createRollout(request('/api/rollouts', input, token(DEMO_SHOP_DOMAIN)));
  const body = await json(response);
  assert(response.status === 201, `could not create draft fixture: ${JSON.stringify(body)}`);
  const rollout = await adapter.getRollout(body.rollout.id);
  assert(rollout !== null, 'created draft disappeared');
  return { rollout, variants: await adapter.getRolloutVariants(rollout.id) };
}

test('merchant routes reject missing bearer tokens even when ?shop is supplied', async () => {
  const response = await forecast(
    request(`/api/forecast?shop=${DEMO_SHOP_DOMAIN}`, proposal(variantGid)),
  );
  assert(response.status === 401, `expected 401, got ${response.status}`);
});

test('the store-wide kill switch also rejects the legacy static/query fallback', async () => {
  const response = await killSwitch(
    request(`/api/kill-switch?shop=${DEMO_SHOP_DOMAIN}`, { reason: 'must not run' }),
  );
  assert(response.status === 401, `expected 401, got ${response.status}`);
});

test('the store-wide kill switch requires explicit merchant confirmation', async () => {
  const before = await adapter.getShop(shopId);
  const response = await killSwitch(
    request(
      '/api/kill-switch',
      { reason: 'a checkbox in the UI is not API confirmation' },
      token(DEMO_SHOP_DOMAIN),
    ),
  );
  const body = await json(response);
  assert(response.status === 400, `unconfirmed kill switch returned ${response.status}`);
  assert(body.error?.code === 'confirmation_required', 'confirmation failure used the wrong code');
  assert(
    (await adapter.getShop(shopId))?.kill_switch_engaged_at === before?.kill_switch_engaged_at,
    'unconfirmed kill switch changed the store',
  );
});

test('forecast accepts a verified session, stays tenant-scoped, and writes nothing', async () => {
  const before = await adapter.listRollouts(shopId);
  const response = await forecast(
    request('/api/forecast', proposal(variantGid), token(DEMO_SHOP_DOMAIN)),
  );
  const body = await json(response);
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.contract_version === CONTRACT_VERSION, 'forecast contract version is missing');
  assert(body.products?.[0]?.variant_gid === variantGid, 'forecast returned the wrong tenant product');
  assert((await adapter.listRollouts(shopId)).length === before.length, 'forecast wrote a rollout');
});

test('forged session tokens are rejected', async () => {
  const forged = `${token(DEMO_SHOP_DOMAIN).slice(0, -1)}x`;
  const response = await forecast(request('/api/forecast', proposal(variantGid), forged));
  assert(response.status === 401, `expected 401, got ${response.status}`);
});

test('every legacy merchant route rejects missing and forged session tokens', async () => {
  const forged = `${token(DEMO_SHOP_DOMAIN).slice(0, -1)}x`;
  const calls = [
    (bearer?: string) => journal(authGet('/api/journal?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => sync(request('/api/sync?shop=' + DEMO_SHOP_DOMAIN, {}, bearer)),
    (bearer?: string) => syncStatus(authGet('/api/sync/status?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => killSwitch(request('/api/kill-switch?shop=' + DEMO_SHOP_DOMAIN, {}, bearer)),
    (bearer?: string) => releaseKillSwitch(
      deleteRequest('/api/kill-switch?shop=' + DEMO_SHOP_DOMAIN, { confirm: true }, bearer),
    ),
    (bearer?: string) => confirmRollout(request('/api/rollouts/unknown/confirm', { confirm: true }, bearer), {
      params: Promise.resolve({ id: 'unknown' }),
    }),
    (bearer?: string) => pauseRollout(request('/api/rollouts/unknown/pause', { confirm: true }, bearer), {
      params: Promise.resolve({ id: 'unknown' }),
    }),
    (bearer?: string) => getShopSettings(authGet('/api/shop?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => updateShopSettings(
      patchRequest('/api/shop?shop=' + DEMO_SHOP_DOMAIN, { notify_emails: [] }, bearer),
    ),
    (bearer?: string) => setCogs(
      patchRequest('/api/products/unknown/cogs?shop=' + DEMO_SHOP_DOMAIN, { cogs_cents: 100 }, bearer),
      { params: Promise.resolve({ variantId: 'unknown' }) },
    ),
    (bearer?: string) => listProducts(authGet('/api/products?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => getLive(authGet('/api/live?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => reconcileWebhookSubscriptions(
      request('/api/webhook-subscriptions?shop=' + DEMO_SHOP_DOMAIN, {}, bearer),
    ),
    (bearer?: string) => listRollouts(authGet('/api/rollouts?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => cancelRollout(
      request('/api/rollouts/unknown/cancel?shop=' + DEMO_SHOP_DOMAIN, { confirm: true }, bearer),
      { params: Promise.resolve({ id: 'unknown' }) },
    ),
    (bearer?: string) => getRolloutReport(
      authGet('/api/rollouts/unknown/report?shop=' + DEMO_SHOP_DOMAIN, bearer),
      { params: Promise.resolve({ id: 'unknown' }) },
    ),
  ];
  for (const call of calls) {
    const missing = await call();
    const invalid = await call(forged);
    assert(missing.status === 401, `missing token returned ${missing.status}`);
    assert(invalid.status === 401, `forged token returned ${invalid.status}`);
  }
});

test('catalog and live views ignore cross-shop query parameters', async () => {
  const primaryCatalogResponse = await listProducts(
    authGet('/api/products?only_repriceable=true&limit=2', token(DEMO_SHOP_DOMAIN)),
  );
  const primaryCatalog = await json(primaryCatalogResponse);
  assert(primaryCatalogResponse.status === 200, `catalog returned ${primaryCatalogResponse.status}`);
  assert(primaryCatalog.items.length === 2, 'catalog limit was not applied');
  assert(primaryCatalog.items.every((product: { shop_id: string }) => product.shop_id === shopId), 'catalog mixed tenants');

  const otherCatalog = await json(
    await listProducts(authGet(`/api/products?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP))),
  );
  assert(otherCatalog.total === 0, 'cross-shop query parameter exposed the primary catalog');

  const primaryLive = await json(await getLive(authGet('/api/live', token(DEMO_SHOP_DOMAIN))));
  const otherLive = await json(
    await getLive(authGet(`/api/live?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP))),
  );
  assert(typeof primaryLive.products_missing_cost === 'number', 'live view omitted readiness data');
  assert(otherLive.rollouts.length === 0, 'cross-shop live view exposed a rollout');
  assert(otherLive.skus_holding_priceflag_price === 0, 'cross-shop live view exposed a live price');

  const invalidQuery = await listProducts(
    authGet('/api/products?only_repriceable=yes', token(DEMO_SHOP_DOMAIN)),
  );
  assert(invalidQuery.status === 400, 'catalog accepted an invalid boolean query');
});

test('completed rollouts remain operationally live until their Shopify writes are reverted', async () => {
  const fixture = await createTestDraft([secondVariantGid]);
  const now = new Date().toISOString();
  await adapter.updateRollout(fixture.rollout.id, {
    status: 'completed',
    current_stage: 0,
    started_at: now,
    stage_entered_at: now,
    ended_at: now,
    ended_reason: 'completed',
  });
  await adapter.updateRolloutVariant(fixture.variants[0]!.id, { applied_at: now, reverted_at: null });

  const response = await getLive(authGet('/api/live', token(DEMO_SHOP_DOMAIN)));
  const body = await json(response);
  assert(response.status === 200, `live view returned ${response.status}`);
  assert(body.anything_live === true, 'completed live price was hidden from the operational state');
  assert(
    body.rollouts.some(
      (item: { id: string; variants_live: number }) =>
        item.id === fixture.rollout.id && item.variants_live === 1,
    ),
    'completed rollout with an unreverted write was missing from the live list',
  );

  await adapter.updateRolloutVariant(fixture.variants[0]!.id, { reverted_at: now });
  await adapter.updateRollout(fixture.rollout.id, {
    status: 'rolled_back',
    ended_reason: 'manual_rollback',
  });
});

test('rollout listing and reports remain tenant-scoped', async () => {
  const fixture = await createTestDraft();
  const primaryResponse = await listRollouts(
    authGet('/api/rollouts?status=draft', token(DEMO_SHOP_DOMAIN)),
  );
  const primary = await json(primaryResponse);
  assert(primaryResponse.status === 200, `rollout list returned ${primaryResponse.status}`);
  assert(
    primary.items.some((item: { rollout: Rollout }) => item.rollout.id === fixture.rollout.id),
    'token tenant rollout was missing from the list',
  );

  const other = await json(
    await listRollouts(authGet(`/api/rollouts?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP))),
  );
  assert(other.total === 0, 'cross-shop query parameter exposed a rollout');

  const crossReport = await getRolloutReport(
    authGet(`/api/rollouts/${fixture.rollout.id}/report`, token(OTHER_SHOP)),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  assert(crossReport.status === 404, 'cross-shop report lookup did not return 404');
  const pendingReport = await getRolloutReport(
    authGet(`/api/rollouts/${fixture.rollout.id}/report`, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const pendingBody = await json(pendingReport);
  assert(pendingReport.status === 404, 'missing report did not return 404');
  assert(pendingBody.error?.code === 'report_not_ready', 'missing report error code drifted');

  const report: RolloutReport = {
    contract_version: CONTRACT_VERSION,
    rollout_id: fixture.rollout.id,
    generated_at: new Date().toISOString(),
    model_version: 'merchant-api-report-v1',
    model_run_id: null,
    window: { start_day: '2026-07-01', end_day: '2026-07-30', days: 30 },
    predicted: {
      expected: { units_change_pct: -5, revenue_delta_cents: 5000, profit_delta_cents: 3000 },
      low: { units_change_pct: -12, revenue_delta_cents: 1000, profit_delta_cents: 200 },
      high: { units_change_pct: 1, revenue_delta_cents: 9000, profit_delta_cents: 6000 },
    },
    realized: { units_change_pct: -4, revenue_delta_cents: 5600, profit_delta_cents: 3400 },
    in_range: true,
    elasticity_update: null,
    narrative: 'The observed result stayed within the approved forecast range.',
    per_variant: [],
  };
  await adapter.ingestModelRunAtomic({
    shopId,
    ingestKey: `merchant-report:${fixture.rollout.id}`,
    run: {
      kind: 'report',
      model_version: report.model_version,
      git_sha: null,
      status: 'succeeded',
      gate_passed: true,
      incumbent_version: null,
      metrics: {},
      rows_written: 1,
      notes: null,
      error: null,
    },
    fits: [],
    bands: [],
    reports: [report],
    recommendations: [],
  });
  const readyReport = await getRolloutReport(
    authGet(`/api/rollouts/${fixture.rollout.id}/report`, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const readyBody = await json(readyReport);
  assert(readyReport.status === 200, `ready report returned ${readyReport.status}`);
  assert(readyBody.rollout_id === fixture.rollout.id, 'report returned the wrong rollout');
  assert(!Object.hasOwn(readyBody, 'shop_id'), 'report exposed database tenant metadata');
  assert(!Object.hasOwn(readyBody, 'id'), 'report exposed database row metadata');
  assert(!Object.hasOwn(readyBody, 'created_at'), 'report violated its frozen schema');
});

test('cancel requires confirmation and is forbidden after any price-write history', async () => {
  const fixture = await createTestDraft();
  const context = { params: Promise.resolve({ id: fixture.rollout.id }) };

  const crossShop = await cancelRollout(
    request(`/api/rollouts/${fixture.rollout.id}/cancel`, { confirm: true }, token(OTHER_SHOP)),
    context,
  );
  assert(crossShop.status === 404, 'cross-shop cancellation did not return 404');
  const unconfirmed = await cancelRollout(
    request(`/api/rollouts/${fixture.rollout.id}/cancel`, {}, token(DEMO_SHOP_DOMAIN)),
    context,
  );
  assert(unconfirmed.status === 400, 'unconfirmed cancellation was accepted');
  const cancelled = await cancelRollout(
    request(`/api/rollouts/${fixture.rollout.id}/cancel`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    context,
  );
  const cancelledBody = await json(cancelled);
  assert(cancelled.status === 200, `cancel returned ${cancelled.status}: ${JSON.stringify(cancelledBody)}`);
  assert(cancelledBody.rollout.status === 'cancelled', 'draft did not become cancelled');
  assert(cancelledBody.rollout.ended_reason === 'cancelled', 'cancel end reason was not recorded');

  const unsafe = await createTestDraft();
  const unsafeVariant = unsafe.variants[0];
  assert(unsafeVariant !== undefined, 'unsafe cancellation fixture has no variant');
  await adapter.updateRolloutVariant(unsafeVariant.id, { applied_at: new Date().toISOString() });
  const unsafeResponse = await cancelRollout(
    request(`/api/rollouts/${unsafe.rollout.id}/cancel`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: unsafe.rollout.id }) },
  );
  const unsafeBody = await json(unsafeResponse);
  assert(unsafeResponse.status === 409, 'write-history rollout was cancelled instead of requiring rollback');
  assert(unsafeBody.error?.code === 'cancel_not_safe', 'unsafe cancel error code drifted');
  assert((await adapter.getRollout(unsafe.rollout.id))?.status === 'draft', 'unsafe cancellation changed rollout state');
});

test('shop settings are token-scoped and never expose Shopify credentials', async () => {
  const primary = await json(await getShopSettings(authGet('/api/shop', token(DEMO_SHOP_DOMAIN))));
  const other = await json(
    await getShopSettings(authGet(`/api/shop?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP))),
  );
  assert(primary.shop?.shop_domain === DEMO_SHOP_DOMAIN, 'primary token returned the wrong shop');
  assert(other.shop?.shop_domain === OTHER_SHOP, 'query parameter overrode the token tenant');
  assert(!Object.hasOwn(primary.shop, 'access_token_enc'), 'shop response exposed the encrypted Admin token');
});

test('notification settings update only the token tenant and reject unknown fields', async () => {
  const response = await updateShopSettings(
    patchRequest(
      `/api/shop?shop=${OTHER_SHOP}`,
      { notify_emails: [' OWNER@EXAMPLE.COM ', 'owner@example.com'] },
      token(DEMO_SHOP_DOMAIN),
    ),
  );
  const body = await json(response);
  assert(response.status === 200, `settings update returned ${response.status}: ${JSON.stringify(body)}`);
  assert(body.shop.notify_emails.length === 1, 'settings did not normalize duplicate email addresses');
  assert(body.shop.notify_emails[0] === 'owner@example.com', 'settings did not normalize the email address');
  assert((await adapter.getShop(otherShopId))?.notify_emails.length === 0, 'settings changed another tenant');

  const unsupported = await updateShopSettings(
    patchRequest('/api/shop', { notify_emails: [], kill_switch_engaged_at: new Date().toISOString() }, token(DEMO_SHOP_DOMAIN)),
  );
  assert(unsupported.status === 400, 'settings accepted an unsupported field');
  assert((await adapter.getShop(shopId))?.notify_emails[0] === 'owner@example.com', 'rejected settings changed state');

  const tooMany = await updateShopSettings(
    patchRequest(
      '/api/shop',
      { notify_emails: Array.from({ length: 6 }, (_, index) => `owner${index}@example.com`) },
      token(DEMO_SHOP_DOMAIN),
    ),
  );
  assert(tooMany.status === 400, 'settings accepted more than five notification addresses');
});

test('unit-cost updates are token-scoped, validated, and allow loss leaders', async () => {
  const productBefore = (await adapter.getProductsByVariantGids(shopId, [variantGid]))[0];
  assert(productBefore !== undefined, 'cost fixture product disappeared');
  const lossLeaderCost = productBefore.price_cents + 500;
  const updatedResponse = await setCogs(
    patchRequest(`/api/products/${encodeURIComponent(variantGid)}/cogs`, { cogs_cents: lossLeaderCost }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ variantId: variantGid }) },
  );
  const updated = await json(updatedResponse);
  assert(updatedResponse.status === 200, `cost update returned ${updatedResponse.status}: ${JSON.stringify(updated)}`);
  assert(updated.product.cogs_cents === lossLeaderCost, 'loss-leader unit cost was not saved');
  assert(updated.product.cogs_source === 'manual', 'manual unit cost was not labelled manual');

  const crossShop = await setCogs(
    patchRequest(`/api/products/${encodeURIComponent(variantGid)}/cogs`, { cogs_cents: 1 }, token(OTHER_SHOP)),
    { params: Promise.resolve({ variantId: variantGid }) },
  );
  assert(crossShop.status === 404, 'cross-shop cost update did not return 404');
  assert(
    (await adapter.getProductsByVariantGids(shopId, [variantGid]))[0]?.cogs_cents === lossLeaderCost,
    'cross-shop cost update changed the primary tenant',
  );

  for (const invalid of [-1, 1.5, '100']) {
    const invalidResponse = await setCogs(
      patchRequest(`/api/products/${encodeURIComponent(variantGid)}/cogs`, { cogs_cents: invalid }, token(DEMO_SHOP_DOMAIN)),
      { params: Promise.resolve({ variantId: variantGid }) },
    );
    assert(invalidResponse.status === 400, `invalid cost ${String(invalid)} returned ${invalidResponse.status}`);
  }

  const cleared = await setCogs(
    patchRequest(`/api/products/${encodeURIComponent(variantGid)}/cogs`, { cogs_cents: null }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ variantId: variantGid }) },
  );
  const clearedBody = await json(cleared);
  assert(cleared.status === 200 && clearedBody.product.cogs_cents === null, 'unit cost was not cleared');
});

test('journal and sync status ignore a cross-shop ?shop parameter', async () => {
  const primaryJournal = await json(await journal(authGet('/api/journal', token(DEMO_SHOP_DOMAIN))));
  assert(primaryJournal.total > 0, 'primary fixture needs journal data');

  const otherJournalResponse = await journal(
    authGet(`/api/journal?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP)),
  );
  const otherJournal = await json(otherJournalResponse);
  assert(otherJournalResponse.status === 200, `other journal returned ${otherJournalResponse.status}`);
  assert(otherJournal.total === 0, 'cross-shop token read the primary shop journal');

  const primaryStatus = await json(await syncStatus(authGet('/api/sync/status', token(DEMO_SHOP_DOMAIN))));
  const otherStatus = await json(
    await syncStatus(authGet(`/api/sync/status?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP))),
  );
  assert(primaryStatus.stage === 'done', `primary sync fixture is ${String(primaryStatus.stage)}`);
  assert(otherStatus.stage === 'queued', 'cross-shop token read the primary shop sync run');
});

test('journal rejects malformed pagination and impossible date windows before querying', async () => {
  for (const query of [
    'limit=0',
    'limit=1.5',
    'limit=501',
    'offset=-1',
    'offset=NaN',
    'from=2026-02-31',
    'to=not-a-day',
    'from=2026-08-20&to=2026-08-19',
    'source=rolluot',
  ]) {
    const response = await journal(authGet(`/api/journal?${query}`, token(DEMO_SHOP_DOMAIN)));
    const body = await json(response);
    assert(response.status === 400, `journal accepted ${query}: ${response.status}`);
    assert(body.error?.code === 'invalid_journal_query', `journal used the wrong error for ${query}`);
  }
});

test('sync derives credentials from the token tenant, never ?shop or static env', async () => {
  process.env.PRICEFLAG_MODE = 'real';
  let contacted = false;
  globalThis.fetch = (async (): Promise<Response> => {
    contacted = true;
    throw new Error('cross-shop sync must not contact Shopify');
  }) as typeof fetch;
  try {
    const invalidWindow = await sync(
      request('/api/sync?days=not-a-number', {}, token(OTHER_SHOP)),
    );
    assert(invalidWindow.status === 400, `invalid sync window returned ${invalidWindow.status}`);
    assert(!contacted, 'invalid sync input contacted Shopify before validation');

    const response = await sync(
      request(`/api/sync?shop=${DEMO_SHOP_DOMAIN}`, {}, token(OTHER_SHOP)),
    );
    assert(response.status === 401, `other tenant without credentials returned ${response.status}`);
    assert(!contacted, 'cross-shop sync used the primary shop static token');
  } finally {
    process.env.PRICEFLAG_MODE = 'demo';
    globalThis.fetch = originalFetch;
  }
});

test('kill-switch release mutates only the session-token tenant', async () => {
  await adapter.updateShop(shopId, {
    kill_switch_engaged_at: new Date().toISOString(),
    kill_switch_reason: 'primary fixture',
  });
  await adapter.updateShop(otherShopId, {
    kill_switch_engaged_at: new Date().toISOString(),
    kill_switch_reason: 'other fixture',
    access_token_enc: encryptSecret('shpat_other_release_test'),
  });

  const unconfirmed = await releaseKillSwitch(
    deleteRequest('/api/kill-switch', {}, token(OTHER_SHOP)),
  );
  assert(unconfirmed.status === 400, `unconfirmed release returned ${unconfirmed.status}`);
  assert((await adapter.getShop(otherShopId))?.kill_switch_engaged_at !== null, 'unconfirmed release changed the store');

  const response = await releaseKillSwitch(
    deleteRequest(`/api/kill-switch?shop=${DEMO_SHOP_DOMAIN}`, { confirm: true }, token(OTHER_SHOP)),
  );
  assert(response.status === 200, `release returned ${response.status}`);
  assert((await adapter.getShop(shopId))?.kill_switch_engaged_at !== null, 'primary switch was released cross-shop');
  assert((await adapter.getShop(otherShopId))?.kill_switch_engaged_at === null, 'token tenant switch stayed engaged');
  await adapter.updateShop(otherShopId, { access_token_enc: null });

  // Restore the primary fixture for later writer tests.
  await adapter.updateShop(shopId, { kill_switch_engaged_at: null, kill_switch_reason: null });
});

test('automatic rollback cannot be enabled during the beta', async () => {
  const before = await adapter.listRollouts(shopId);
  const body = proposal(variantGid, true);
  (body.guardrails as Guardrails).auto_rollback = true;
  const response = await createRollout(
    request('/api/rollouts', body, token(DEMO_SHOP_DOMAIN)),
  );
  assert(response.status === 422, `expected 422, got ${response.status}`);
  assert((await adapter.listRollouts(shopId)).length === before.length, 'rejected request created a rollout');
});

test('draft creation is blocked while the store-wide kill switch is engaged', async () => {
  const before = await adapter.listRollouts(shopId);
  await adapter.updateShop(shopId, {
    kill_switch_engaged_at: new Date().toISOString(),
    kill_switch_reason: 'draft creation regression',
  });
  try {
    const response = await createRollout(
      request('/api/rollouts', proposal(variantGid, true), token(DEMO_SHOP_DOMAIN)),
    );
    const body = await json(response);
    assert(response.status === 409, `kill-switched draft creation returned ${response.status}`);
    assert(body.error?.code === 'kill_switch_engaged', 'kill-switched draft used the wrong error code');
    assert((await adapter.listRollouts(shopId)).length === before.length, 'kill-switched request created a draft');
  } finally {
    await adapter.updateShop(shopId, { kill_switch_engaged_at: null, kill_switch_reason: null });
  }
});

test('draft creation atomically freezes baselines, targets, cohorts, and the approved forecast', async () => {
  const response = await createRollout(
    request('/api/rollouts', proposal(variantGid, true), token(DEMO_SHOP_DOMAIN)),
  );
  const body = await json(response);
  assert(response.status === 201, `expected 201, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.rollout.status === 'draft', 'new rollout is not a draft');
  assert(body.rollout.current_stage === -1, 'new draft started a stage');
  assert(body.rollout.started_at === null, 'new draft has a start time');
  assert(body.rollout.forecast?.contract_version === CONTRACT_VERSION, 'approved forecast was not frozen');

  createdRollout = (await adapter.getRollout(body.rollout.id)) as Rollout;
  const variants = await adapter.getRolloutVariants(createdRollout.id);
  assert(variants.length === 1, `expected one frozen variant, got ${variants.length}`);
  createdVariant = variants[0] as RolloutVariant;
  assert(createdVariant.baseline_price_cents > 0, 'baseline was not captured');
  assert(createdVariant.target_price_cents > createdVariant.baseline_price_cents, 'target was not captured');
  assert(createdVariant.applied_at === null, 'draft wrote a Shopify price');
  const events = await adapter.listRolloutEvents(createdRollout.id);
  assert(events.length === 1 && events[0]?.type === 'created', 'created event was not committed atomically');
});

test('the atomic adapter seam exposes neither half of an invalid snapshot', async () => {
  const before = await adapter.listRollouts(shopId);
  const invalidId = '75f1e87a-f0c5-4e52-97e0-87597312eb73';
  let threw = false;
  try {
    await adapter.createDraftRollout(
      {
        ...createdRollout,
        id: invalidId,
        status: 'draft',
        current_stage: -1,
        started_at: null,
        stage_entered_at: null,
        ended_at: null,
        ended_reason: null,
      },
      [{ ...createdVariant, rollout_id: createdRollout.id }],
    );
  } catch {
    threw = true;
  }
  assert(threw, 'invalid atomic snapshot was accepted');
  assert((await adapter.getRollout(invalidId)) === null, 'failed transaction exposed a rollout row');
  assert((await adapter.listRollouts(shopId)).length === before.length, 'failed transaction changed rollout count');
});

test('cross-shop rollout lookup is indistinguishable from an unknown id', async () => {
  const response = await getRollout(authGet(`/api/rollouts/${createdRollout.id}`, token(OTHER_SHOP)), {
    params: Promise.resolve({ id: createdRollout.id }),
  });
  const body = await json(response);
  assert(response.status === 404, `expected 404, got ${response.status}`);
  assert(body.error?.code === 'rollout_not_found', 'cross-shop lookup leaked a different error');
});

test('confirm and pause return the same 404 for a cross-shop rollout without contacting Shopify', async () => {
  let contacted = false;
  globalThis.fetch = (async (): Promise<Response> => {
    contacted = true;
    throw new Error('cross-shop control must not contact Shopify');
  }) as typeof fetch;
  const context = { params: Promise.resolve({ id: createdRollout.id }) };
  const confirmed = await confirmRollout(
    request(`/api/rollouts/${createdRollout.id}/confirm`, { confirm: true }, token(OTHER_SHOP)),
    context,
  );
  const confirmedBody = await json(confirmed);
  const paused = await pauseRollout(
    request(`/api/rollouts/${createdRollout.id}/pause`, { confirm: true }, token(OTHER_SHOP)),
    context,
  );
  const pausedBody = await json(paused);
  assert(confirmed.status === 404 && paused.status === 404, 'cross-shop control did not return 404');
  assert(confirmedBody.error?.code === 'rollout_not_found', 'confirm leaked rollout ownership');
  assert(pausedBody.error?.code === 'rollout_not_found', 'pause leaked rollout ownership');
  assert(!contacted, 'cross-shop control reached Shopify');
});

test('confirm requires explicit merchant approval', async () => {
  const response = await confirmRollout(
    request(`/api/rollouts/${createdRollout.id}/confirm`, {}, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: createdRollout.id }) },
  );
  const body = await json(response);
  assert(response.status === 400, `expected 400, got ${response.status}`);
  assert(body.error?.code === 'rollout_confirmation_required', 'confirm approval error code drifted');
});

test('confirm rechecks a store-wide stop after taking the rollout lease', async () => {
  const fixture = await createTestDraft();
  const shopify = installShopifyPriceMock(fixture.variants);
  const originalGetRollout = adapter.getRollout.bind(adapter);
  let fixtureReads = 0;
  adapter.getRollout = async (rolloutId: string) => {
    const rollout = await originalGetRollout(rolloutId);
    if (rolloutId === fixture.rollout.id) {
      fixtureReads += 1;
      if (fixtureReads === 2) {
        await adapter.updateShop(shopId, {
          kill_switch_engaged_at: new Date().toISOString(),
          kill_switch_reason: 'confirmation race regression',
        });
      }
    }
    return rollout;
  };

  try {
    const response = await confirmRollout(
      request(`/api/rollouts/${fixture.rollout.id}/confirm`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
      { params: Promise.resolve({ id: fixture.rollout.id }) },
    );
    const body = await json(response);
    assert(response.status === 409, `racing stop returned ${response.status}`);
    assert(body.error?.code === 'kill_switch_engaged', 'racing stop used the wrong error');
    assert(shopify.writes.count === 0, 'confirmation wrote after the kill switch engaged');
    assert((await originalGetRollout(fixture.rollout.id))?.status === 'draft', 'stopped draft transitioned');
  } finally {
    adapter.getRollout = originalGetRollout;
    await adapter.updateShop(shopId, { kill_switch_engaged_at: null, kill_switch_reason: null });
  }
});

test('future confirmation verifies the baseline and schedules without a Shopify write', async () => {
  const fixture = await createTestDraft();
  const shopify = installShopifyPriceMock(fixture.variants);
  const scheduledStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const response = await confirmRollout(
    request(
      `/api/rollouts/${fixture.rollout.id}/confirm`,
      { confirm: true, scheduled_start_at: scheduledStart },
      token(DEMO_SHOP_DOMAIN),
    ),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const body = await json(response);
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.rollout.status === 'scheduled', 'future confirmation did not schedule the rollout');
  assert(shopify.writes.count === 0, 'scheduling changed a Shopify price');
});

test('immediate confirmation detects baseline drift before the first write and pauses safely', async () => {
  const fixture = await createTestDraft();
  const shopify = installShopifyPriceMock(fixture.variants);
  const frozen = fixture.variants[0];
  assert(frozen !== undefined, 'drift fixture has no variant');
  const current = shopify.live.get(frozen.variant_gid);
  assert(current !== undefined, 'drift fixture is missing live price');
  current.price += 1;

  const response = await confirmRollout(
    request(`/api/rollouts/${fixture.rollout.id}/confirm`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const body = await json(response);
  const stored = await adapter.getRollout(fixture.rollout.id);
  assert(response.status === 207, `expected 207, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.ok === false && stored?.status === 'paused', 'baseline drift was not left safely paused');
  assert(shopify.writes.count === 0, 'baseline drift still wrote a Shopify price');
});

test('immediate confirmation starts stage zero only after Shopify verifies every value', async () => {
  const fixture = await createTestDraft();
  const shopify = installShopifyPriceMock(fixture.variants);
  const response = await confirmRollout(
    request(`/api/rollouts/${fixture.rollout.id}/confirm`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const body = await json(response);
  const stored = await adapter.getRollout(fixture.rollout.id);
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.ok === true && stored?.status === 'running' && stored.current_stage === 0, 'stage zero did not start');
  for (const frozen of fixture.variants) {
    const live = shopify.live.get(frozen.variant_gid);
    assert(live?.price === frozen.target_price_cents, 'confirmed target price is not live');
    assert(live.compareAt === frozen.target_compare_at_cents, 'confirmed compare-at price is not live');
  }

  const paused = await pauseRollout(
    request(
      `/api/rollouts/${fixture.rollout.id}/pause`,
      { confirm: true, reason: 'Merchant checkpoint' },
      token(DEMO_SHOP_DOMAIN),
    ),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const pausedBody = await json(paused);
  assert(paused.status === 200 && pausedBody.rollout.status === 'paused', 'manual pause failed');
  assert(pausedBody.rollout.paused_reason === 'Merchant checkpoint', 'manual pause reason was lost');
});

test('confirm and rollback fail honestly while another evaluator holds the rollout lease', async () => {
  const draft = await createTestDraft();
  const confirmResult = await adapter.withRolloutLock(draft.rollout.id, async () =>
    confirmRollout(
      request(`/api/rollouts/${draft.rollout.id}/confirm`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
      { params: Promise.resolve({ id: draft.rollout.id }) },
    ),
  );
  assert(confirmResult.acquired, 'test could not acquire confirm lease');
  assert(confirmResult.result?.status === 409, `locked confirm returned ${confirmResult.result?.status}`);
  const confirmBody = await json(confirmResult.result as Response);
  assert(confirmBody.error?.code === 'rollout_busy', 'locked confirm did not report rollout_busy');

  const running = await adapter.updateRollout(draft.rollout.id, {
    status: 'running',
    current_stage: 0,
    started_at: new Date().toISOString(),
    stage_entered_at: new Date().toISOString(),
  });
  const rollbackResult = await adapter.withRolloutLock(running.id, async () =>
    rollback(
      request(`/api/rollouts/${running.id}/rollback`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
      { params: Promise.resolve({ id: running.id }) },
    ),
  );
  assert(rollbackResult.acquired, 'test could not acquire rollback lease');
  assert(rollbackResult.result?.status === 409, `locked rollback returned ${rollbackResult.result?.status}`);
  const rollbackBody = await json(rollbackResult.result as Response);
  assert(rollbackBody.error?.code === 'rollout_busy', 'locked rollback did not report rollout_busy');
});

test('cross-shop rollback is rejected before Shopify is contacted', async () => {
  let contacted = false;
  globalThis.fetch = (async (): Promise<Response> => {
    contacted = true;
    throw new Error('Shopify must not be contacted for a cross-shop id');
  }) as typeof fetch;
  const response = await rollback(
    request(`/api/rollouts/${createdRollout.id}/rollback`, { confirm: true }, token(OTHER_SHOP)),
    { params: Promise.resolve({ id: createdRollout.id }) },
  );
  assert(response.status === 404, `expected 404, got ${response.status}`);
  assert(!contacted, 'cross-shop rollback reached Shopify');
});

test('manual rollback requires an explicit merchant confirmation', async () => {
  const response = await rollback(
    request(`/api/rollouts/${createdRollout.id}/rollback`, {}, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: createdRollout.id }) },
  );
  const body = await json(response);
  assert(response.status === 400, `expected 400, got ${response.status}`);
  assert(body.error?.code === 'rollback_confirmation_required', 'confirmation error code drifted');
});

test('manual rollback rechecks a store-wide stop at the final Shopify write boundary', async () => {
  const fixture = await createTestDraft();
  const frozen = fixture.variants[0];
  assert(frozen !== undefined, 'rollback stop-race fixture has no variant');
  await adapter.updateRollout(fixture.rollout.id, {
    status: 'running',
    current_stage: 0,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  await adapter.updateRolloutVariant(frozen.id, {
    applied_at: new Date().toISOString(),
    applied_price_cents: frozen.target_price_cents,
  });
  const shopify = installShopifyPriceMock([frozen], 'target');

  let shopReads = 0;
  const stoppingAdapter = new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === 'getShop') {
        return async (wantedShopId: string) => {
          const current = await target.getShop(wantedShopId);
          shopReads += 1;
          return current !== null && shopReads >= 2
            ? { ...current, kill_switch_engaged_at: new Date().toISOString(), kill_switch_reason: 'race regression' }
            : current;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  setAdapter(stoppingAdapter);
  try {
    const response = await rollback(
      request(`/api/rollouts/${fixture.rollout.id}/rollback`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
      { params: Promise.resolve({ id: fixture.rollout.id }) },
    );
    assert(response.status === 207, `stopped rollback did not report a safe partial result (${response.status})`);
    assert(shopify.writes.count === 0, 'rollback contacted Shopify after the final stop check');
    assert((await adapter.getRollout(fixture.rollout.id))?.status === 'paused', 'stopped rollback was not left retryable');
  } finally {
    setAdapter(adapter);
  }
});

test('manual rollback verifies Shopify before reporting success and is idempotent', async () => {
  createdRollout = await adapter.updateRollout(createdRollout.id, {
    status: 'running',
    current_stage: 0,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  createdVariant = await adapter.updateRolloutVariant(createdVariant.id, {
    applied_at: new Date().toISOString(),
    applied_price_cents: createdVariant.target_price_cents,
  });

  let livePrice = createdVariant.target_price_cents;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, any>;
    };
    let data: unknown;
    if (body.query.includes('PriceflagVariantPrices')) {
      data = {
        nodes: (body.variables.ids as string[]).map((gid) => ({
          id: gid,
          price: (livePrice / 100).toFixed(2),
          compareAtPrice: null,
          product: { id: createdVariant.product_gid },
        })),
      };
    } else if (body.query.includes('PriceflagVariantsBulkUpdate')) {
      const write = (body.variables.variants as { id: string; price: string }[])[0];
      assert(write !== undefined, 'rollback did not send a write');
      livePrice = Math.round(Number(write.price) * 100);
      data = {
        productVariantsBulkUpdate: {
          productVariants: [{ id: write.id, price: write.price, compareAtPrice: null }],
          userErrors: [],
        },
      };
    } else {
      throw new Error('unexpected Shopify operation');
    }
    return Response.json({ data });
  }) as typeof fetch;

  const response = await rollback(
    request(
      `/api/rollouts/${createdRollout.id}/rollback`,
      { confirm: true, reason: 'Test undo' },
      token(DEMO_SHOP_DOMAIN),
    ),
    { params: Promise.resolve({ id: createdRollout.id }) },
  );
  const body = await json(response);
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.ok === true && body.failed === 0, 'rollback claimed a partial result');
  assert(livePrice === createdVariant.baseline_price_cents, 'Shopify did not receive the baseline price');
  assert(body.rollout.status === 'rolled_back', 'rollout ended before/without verified restoration');

  const second = await rollback(
    request(`/api/rollouts/${createdRollout.id}/rollback`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: createdRollout.id }) },
  );
  const secondBody = await json(second);
  assert(second.status === 200 && secondBody.ok === true, 'idempotent rollback retry failed');
});

test('partial rollback stays non-terminal and reports the unverified SKU', async () => {
  const createResponse = await createRollout(
    request('/api/rollouts', proposal(variantGid, true), token(DEMO_SHOP_DOMAIN)),
  );
  const created = await json(createResponse);
  assert(createResponse.status === 201, 'could not create the partial-failure fixture');
  const rollout = await adapter.updateRollout(created.rollout.id, {
    status: 'completed',
    current_stage: 0,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ended_reason: 'completed',
  });
  const frozen = (await adapter.getRolloutVariants(rollout.id))[0];
  assert(frozen !== undefined, 'fixture has no frozen variant');
  await adapter.updateRolloutVariant(frozen.id, {
    applied_at: new Date().toISOString(),
    applied_price_cents: frozen.target_price_cents,
  });

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const operation = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, any>;
    };
    if (operation.query.includes('PriceflagVariantPrices')) {
      return Response.json({
        data: {
          nodes: (operation.variables.ids as string[]).map((gid) => ({
            id: gid,
            price: (frozen.target_price_cents / 100).toFixed(2),
            compareAtPrice: null,
            product: { id: frozen.product_gid },
          })),
        },
      });
    }
    return Response.json({
      data: {
        productVariantsBulkUpdate: {
          productVariants: null,
          userErrors: [{ field: ['variants', '0', 'price'], message: 'Write refused', code: 'INVALID' }],
        },
      },
    });
  }) as typeof fetch;

  const response = await rollback(
    request(`/api/rollouts/${rollout.id}/rollback`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: rollout.id }) },
  );
  const body = await json(response);
  const stored = await adapter.getRollout(rollout.id);
  assert(response.status === 207, `expected 207, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.ok === false && body.failed === 1, 'partial rollback was reported as successful');
  assert(body.unverified?.[0]?.variant_gid === frozen.variant_gid, 'unverified SKU was not identified');
  assert(stored?.status === 'paused', `partial rollback became terminal (${stored?.status})`);
  assert(stored?.ended_at === null && stored.ended_reason === null, 'completed rollback failure stayed terminal');
});

test('rollback remains partial when Shopify restores price but not the frozen compare-at value', async () => {
  const fixture = await createTestDraft();
  const original = fixture.variants[0];
  assert(original !== undefined, 'compare-at fixture has no variant');
  // This regression is specifically about a compare-at value Priceflag managed.
  // Unmanaged compare-at values belong to the merchant and are deliberately
  // preserved (covered by pricing-safety.test.ts).
  const frozen = await adapter.updateRolloutVariant(original.id, {
    baseline_compare_at_cents: original.baseline_price_cents + 500,
    target_compare_at_cents: null,
    compare_at_action: 'clear',
  });
  await adapter.updateRollout(fixture.rollout.id, {
    status: 'running',
    current_stage: 0,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  await adapter.updateRolloutVariant(frozen.id, {
    applied_at: new Date().toISOString(),
    applied_price_cents: frozen.target_price_cents,
  });

  let livePrice = frozen.target_price_cents;
  let liveCompareAt = frozen.target_compare_at_cents;
  let wrote = false;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const operation = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, any>;
    };
    if (operation.query.includes('PriceflagVariantPrices')) {
      return Response.json({
        data: {
          nodes: [{
            id: frozen.variant_gid,
            price: (livePrice / 100).toFixed(2),
            compareAtPrice: liveCompareAt === null ? null : (liveCompareAt / 100).toFixed(2),
            product: { id: frozen.product_gid },
          }],
        },
      });
    }
    const input = (operation.variables.variants as { id: string; price: string; compareAtPrice?: string | null }[])[0];
    assert(input !== undefined, 'compare-at rollback did not write');
    livePrice = Math.round(Number(input.price) * 100);
    // Acknowledge the requested value, then model Shopify drifting the live
    // compare-at value before the route's source-of-truth verification read.
    const acknowledgedCompareAt = input.compareAtPrice ?? null;
    liveCompareAt = (frozen.baseline_compare_at_cents ?? 0) + 123;
    wrote = true;
    return Response.json({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [{ id: input.id, price: input.price, compareAtPrice: acknowledgedCompareAt }],
          userErrors: [],
        },
      },
    });
  }) as typeof fetch;

  const response = await rollback(
    request(`/api/rollouts/${fixture.rollout.id}/rollback`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: fixture.rollout.id }) },
  );
  const body = await json(response);
  const stored = await adapter.getRollout(fixture.rollout.id);
  assert(wrote, 'compare-at fixture never reached the rollback write');
  assert(response.status === 207 && body.ok === false, 'compare-at mismatch was reported as rollback success');
  assert(body.unverified?.[0]?.expected_compare_at === frozen.baseline_compare_at_cents, 'expected compare-at missing');
  assert(body.unverified?.[0]?.found_compare_at === liveCompareAt, 'live compare-at mismatch missing');
  assert(stored?.status === 'paused' && stored.ended_at === null, 'compare-at mismatch became terminal');
  await adapter.updateRolloutVariant(frozen.id, {
    baseline_compare_at_cents: original.baseline_compare_at_cents,
    target_compare_at_cents: original.target_compare_at_cents,
    compare_at_action: original.compare_at_action,
  });
});

test('rollback restores every live variant when all write acknowledgements were lost', async () => {
  const input = proposal(variantGid, true);
  input.variant_gids = [variantGid, secondVariantGid];
  const createResponse = await createRollout(
    request('/api/rollouts', input, token(DEMO_SHOP_DOMAIN)),
  );
  const created = await json(createResponse);
  assert(createResponse.status === 201, 'could not create the acknowledgement-loss fixture');
  const rollout = await adapter.updateRollout(created.rollout.id, {
    status: 'running',
    current_stage: 1,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
  const frozen = await adapter.getRolloutVariants(rollout.id);
  assert(frozen.length === 2, `expected two variants, got ${frozen.length}`);

  // The live store carries each target, but applied_at remains null: Shopify
  // accepted the writes and the previous process died before acknowledging them.
  const live = new Map(frozen.map((variant) => [variant.variant_gid, variant.target_price_cents]));
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const operation = JSON.parse(String(init?.body ?? '{}')) as {
      query: string;
      variables: Record<string, any>;
    };
    if (operation.query.includes('PriceflagVariantPrices')) {
      return Response.json({
        data: {
          nodes: (operation.variables.ids as string[]).map((gid) => {
            const row = frozen.find((variant) => variant.variant_gid === gid);
            assert(row !== undefined, `unknown variant ${gid}`);
            return {
              id: gid,
              price: ((live.get(gid) as number) / 100).toFixed(2),
              compareAtPrice: null,
              product: { id: row.product_gid },
            };
          }),
        },
      });
    }
    const writes = operation.variables.variants as { id: string; price: string }[];
    for (const write of writes) live.set(write.id, Math.round(Number(write.price) * 100));
    return Response.json({
      data: {
        productVariantsBulkUpdate: {
          productVariants: writes.map((write) => ({ ...write, compareAtPrice: null })),
          userErrors: [],
        },
      },
    });
  }) as typeof fetch;

  const response = await rollback(
    request(`/api/rollouts/${rollout.id}/rollback`, { confirm: true }, token(DEMO_SHOP_DOMAIN)),
    { params: Promise.resolve({ id: rollout.id }) },
  );
  const body = await json(response);
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert(body.restored === 2 && body.failed === 0, 'not every unacknowledged write was restored');
  for (const variant of frozen) {
    assert(live.get(variant.variant_gid) === variant.baseline_price_cents, `${variant.variant_gid} stayed live`);
  }
});

test('kill switch reaches the original chain root after a terminal-status crash without replaying an intermediate price', async () => {
  const chainShop = await adapter.upsertShop({
    shop_domain: CHAIN_SHOP,
    mode: 'demo',
    currency: 'USD',
    access_token_enc: encryptSecret('shpat_chain_safety_test'),
  });
  const source = (await adapter.listProducts(shopId, { only_repriceable: true, limit: 1 })).items[0];
  assert(source !== undefined, 'chain fixture has no source product');
  const sourceInput: ProductUpsert = {
    product_gid: source.product_gid,
    variant_gid: source.variant_gid,
    inventory_item_gid: source.inventory_item_gid,
    title: source.title,
    variant_title: source.variant_title,
    sku: source.sku,
    vendor: source.vendor,
    product_type: source.product_type,
    tags: source.tags,
    image_url: source.image_url,
    status: source.status,
    price_cents: source.price_cents,
    compare_at_cents: source.compare_at_cents,
    currency: source.currency,
    cogs_cents: source.cogs_cents,
    cogs_source: source.cogs_source,
    cogs_updated_at: source.cogs_updated_at,
    is_gift_card: source.is_gift_card,
    requires_selling_plan: source.requires_selling_plan,
    has_selling_plan: source.has_selling_plan,
    inventory_quantity: source.inventory_quantity,
    available_for_sale: source.available_for_sale,
  };
  const chainVariantGid = 'gid://shopify/ProductVariant/990001';
  const chainProductGid = 'gid://shopify/Product/990001';
  await adapter.upsertProducts(chainShop.id, [{
    ...sourceInput,
    variant_gid: chainVariantGid,
    product_gid: chainProductGid,
    inventory_item_gid: 'gid://shopify/InventoryItem/990001',
    title: 'Chain safety product',
    price_cents: 1000,
    compare_at_cents: null,
  }]);

  const firstResponse = await createRollout(
    request('/api/rollouts', proposal(chainVariantGid, true), token(CHAIN_SHOP)),
  );
  const firstBody = await json(firstResponse);
  assert(firstResponse.status === 201, `could not create first chain rollout: ${JSON.stringify(firstBody)}`);
  const firstRollout = await adapter.updateRollout(firstBody.rollout.id, {
    status: 'completed',
    current_stage: 0,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ended_reason: 'completed',
  });
  const firstVariant = (await adapter.getRolloutVariants(firstRollout.id))[0];
  assert(firstVariant !== undefined, 'first chain rollout has no variant');
  await adapter.updateRolloutVariant(firstVariant.id, {
    applied_at: new Date().toISOString(),
    applied_price_cents: firstVariant.target_price_cents,
  });

  await adapter.upsertProducts(chainShop.id, [{
    ...sourceInput,
    variant_gid: chainVariantGid,
    product_gid: chainProductGid,
    inventory_item_gid: 'gid://shopify/InventoryItem/990001',
    title: 'Chain safety product',
    price_cents: 1100,
    compare_at_cents: null,
  }]);
  const secondProposal = proposal(chainVariantGid, true);
  secondProposal.change = { type: 'absolute', absolute_cents: -100, rounding: 'none' };
  const secondResponse = await createRollout(
    request('/api/rollouts', secondProposal, token(CHAIN_SHOP)),
  );
  const secondBody = await json(secondResponse);
  assert(secondResponse.status === 201, `could not create second chain rollout: ${JSON.stringify(secondBody)}`);
  const secondRollout = await adapter.updateRollout(secondBody.rollout.id, {
    status: 'completed',
    current_stage: 0,
    stage_entered_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    ended_reason: 'completed',
  });
  const secondVariant = (await adapter.getRolloutVariants(secondRollout.id))[0];
  assert(secondVariant !== undefined, 'second chain rollout has no variant');
  await adapter.updateRolloutVariant(secondVariant.id, {
    applied_at: new Date().toISOString(),
    applied_price_cents: secondVariant.target_price_cents,
  });

  const shopify = installShopifyPriceMock([firstVariant, secondVariant], 'target');
  let terminalFailuresRemaining = 3;
  const arbitraryOrderAdapter = new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === 'listRollouts') {
        return async (wantedShopId: string, statuses?: readonly Rollout['status'][]) => {
          const rows = await target.listRollouts(wantedShopId, statuses);
          return wantedShopId === chainShop.id ? [...rows].reverse() : rows;
        };
      }
      if (property === 'updateRollout') {
        return async (rolloutId: string, patch: Partial<Rollout>) => {
          if (
            rolloutId === secondRollout.id &&
            patch.status === 'rolled_back' &&
            terminalFailuresRemaining > 0
          ) {
            terminalFailuresRemaining -= 1;
            throw new Error('simulated database failure after Shopify restored the price');
          }
          return target.updateRollout(rolloutId, patch);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  setAdapter(arbitraryOrderAdapter);
  try {
    const firstKill = await killSwitch(
      request('/api/kill-switch', { confirm: true, reason: 'arbitrary-order chain regression' }, token(CHAIN_SHOP)),
    );
    const firstKillBody = await json(firstKill);
    assert(firstKill.status === 207, `crash-window kill did not report partial state: ${JSON.stringify(firstKillBody)}`);
    assert(shopify.live.get(chainVariantGid)?.price === 1000, 'kill switch left the chain on an intermediate price');
    assert((await adapter.getRollout(firstRollout.id))?.status === 'rolled_back', 'old chain link was not resolved');
    assert(
      (await adapter.getRollout(secondRollout.id))?.status !== 'rolled_back',
      'crash-window chain link did not remain visibly unfinished and retryable',
    );

    const writesAfterFirst = shopify.writes.count;
    terminalFailuresRemaining = 0;
    const retry = await killSwitch(
      request('/api/kill-switch', { confirm: true, reason: 'idempotent chain retry' }, token(CHAIN_SHOP)),
    );
    assert(retry.status === 200, `chain retry failed: ${JSON.stringify(await json(retry))}`);
    assert(shopify.writes.count === writesAfterFirst, 'chain retry rewrote an already restored storefront');
    assert((await adapter.getRollout(secondRollout.id))?.status === 'rolled_back', 'retry reopened a restored chain link');

    const chainLive = shopify.live.get(chainVariantGid);
    assert(chainLive !== undefined, 'chain live price disappeared');
    chainLive.price = 1050;
    const unverifiedRelease = await releaseKillSwitch(
      deleteRequest('/api/kill-switch', { confirm: true }, token(CHAIN_SHOP)),
    );
    const unverifiedBody = await json(unverifiedRelease);
    assert(unverifiedRelease.status === 409, 'release ignored a live price that was not at the chain root');
    assert(unverifiedBody.error?.code === 'kill_switch_release_unverified', 'unverified release used the wrong code');
    chainLive.price = 1000;

    const released = await releaseKillSwitch(
      deleteRequest('/api/kill-switch', { confirm: true }, token(CHAIN_SHOP)),
    );
    assert(released.status === 200, `verified chain could not release its kill switch (${released.status})`);
  } finally {
    setAdapter(adapter);
  }
});

test('kill switch fails honestly when an evaluator still holds a rollout lease', async () => {
  const fixture = await createTestDraft();
  const busyDraft = await createTestDraft([secondVariantGid]);
  await adapter.updateRollout(fixture.rollout.id, {
    status: 'running',
    current_stage: 0,
    started_at: new Date().toISOString(),
    stage_entered_at: new Date().toISOString(),
  });
  const allVariants: RolloutVariant[] = [];
  for (const rollout of await adapter.listRollouts(shopId)) {
    allVariants.push(...await adapter.getRolloutVariants(rollout.id));
  }
  installShopifyPriceMock(allVariants);

  const locked = await adapter.withRolloutLock(fixture.rollout.id, async () =>
    adapter.withRolloutLock(busyDraft.rollout.id, async () =>
      killSwitch(
        request(
          '/api/kill-switch',
          { confirm: true, reason: 'lease race regression' },
          token(DEMO_SHOP_DOMAIN),
        ),
      ),
    ),
  );
  assert(locked.acquired, 'test could not acquire the contested lease');
  const nested = locked.result;
  assert(nested?.acquired, 'test could not acquire the contested draft lease');
  const response = nested.result as Response;
  const body = await json(response);
  assert(response.status === 207 && body.ok === false, 'busy kill switch reported complete success');
  for (const rolloutId of [fixture.rollout.id, busyDraft.rollout.id]) {
    assert(
      body.failures?.some(
        (failure: { rollout_id: string; code: string }) =>
          failure.rollout_id === rolloutId && failure.code === 'rollout_busy',
      ),
      `busy rollout ${rolloutId} was not named in the kill-switch result`,
    );
  }
  assert((await adapter.getShop(shopId))?.kill_switch_engaged_at !== null, 'partial kill switch was released');
  const blockedRelease = await releaseKillSwitch(
    deleteRequest('/api/kill-switch', { confirm: true }, token(DEMO_SHOP_DOMAIN)),
  );
  const blockedBody = await json(blockedRelease);
  assert(blockedRelease.status === 409, 'an incomplete emergency stop could be released');
  assert(blockedBody.error?.code === 'kill_switch_release_blocked', 'blocked release used the wrong error code');

  const retry = await killSwitch(
    request('/api/kill-switch', { confirm: true, reason: 'finish lease race regression' }, token(DEMO_SHOP_DOMAIN)),
  );
  assert(retry.status === 200, `kill-switch retry did not converge: ${JSON.stringify(await json(retry))}`);
  const released = await releaseKillSwitch(
    deleteRequest('/api/kill-switch', { confirm: true }, token(DEMO_SHOP_DOMAIN)),
  );
  assert(released.status === 200, `verified emergency stop could not be released (${released.status})`);
});

test('shop-wide rollback pagination cannot omit variants with tied timestamps', async () => {
  const createdAt = '2026-08-04T00:00:00.000Z';
  const source = Array.from({ length: 1001 }, (_, index) => ({
    id: `rv-${String(index).padStart(4, '0')}`,
    rollout_id: 'rollout-pagination',
    shop_id: 'shop-pagination',
    variant_gid: `gid://shopify/ProductVariant/${index + 1}`,
    product_gid: `gid://shopify/Product/${index + 1}`,
    title: `Variant ${index + 1}`,
    sku: null,
    baseline_price_cents: 1000,
    baseline_compare_at_cents: null,
    target_price_cents: 1100,
    target_compare_at_cents: null,
    compare_at_action: 'none',
    baseline_units_per_day: 1,
    cogs_cents_at_creation: 400,
    cohort_stage: 0,
    applied_price_cents: null,
    applied_at: null,
    reverted_at: null,
    excluded: false,
    exclusion_reason: null,
    created_at: createdAt,
    updated_at: createdAt,
  }));
  const orderCalls: string[][] = [];

  const fakeDb = {
    from(table: string) {
      assert(table === 'rollout_variants', `unexpected table ${table}`);
      const orders: string[] = [];
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order(column: string) {
          orders.push(column);
          return this;
        },
        async range(from: number, to: number) {
          orderCalls.push([...orders]);
          const rows = [...source].sort(
            (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
          );
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
    },
  };

  const supabase = new SupabaseAdapter(fakeDb as never);
  const variants = await supabase.listRolloutVariantsForShop('shop-pagination');
  assert(variants.length === 1001, `expected 1001 variants, got ${variants.length}`);
  assert(new Set(variants.map((variant) => variant.id)).size === 1001, 'a pagination boundary duplicated a variant');
  assert(orderCalls.length === 2, `expected two pages, got ${orderCalls.length}`);
  assert(
    orderCalls.every((columns) => columns.join(',') === 'created_at,id'),
    `pagination order was not uniquely deterministic: ${JSON.stringify(orderCalls)}`,
  );
});

async function main(): Promise<void> {
  process.env.SHOPIFY_API_KEY = API_KEY;
  process.env.SHOPIFY_API_SECRET = API_SECRET;
  process.env.SHOPIFY_SHOP_DOMAIN = DEMO_SHOP_DOMAIN;
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_merchant_api_test';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.VERCEL_ENV = 'production';
  process.env.PRICEFLAG_MODE = 'demo';

  adapter = DemoAdapter.ephemeral(20260803);
  setAdapter(adapter);
  const shops = await adapter.listShops();
  const shop = shops[0];
  assert(shop !== undefined, 'demo shop was not seeded');
  shopId = shop.id;
  await adapter.updateShop(shopId, { access_token_enc: encryptSecret('shpat_oauth_merchant_api_test') });
  const otherShop = await adapter.upsertShop({ shop_domain: OTHER_SHOP, mode: 'demo' });
  otherShopId = otherShop.id;
  const products = await adapter.listProducts(shopId, { only_repriceable: true, limit: 2 });
  const product = products.items[0];
  const secondProduct = products.items[1];
  assert(product !== undefined, 'demo product was not seeded');
  assert(secondProduct !== undefined, 'second demo product was not seeded');
  variantGid = product.variant_gid;
  secondVariantGid = secondProduct.variant_gid;

  let passed = 0;
  for (const item of tests) {
    try {
      await item.run();
      passed += 1;
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (cause) {
      process.stderr.write(`FAIL ${item.name}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
    }
  }

  setAdapter(null);
  globalThis.fetch = originalFetch;
  if (passed !== tests.length) process.exitCode = 1;
  process.stdout.write(`${passed}/${tests.length} merchant API tests passed\n`);
}

void main();
