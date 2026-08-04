import { createHmac } from 'node:crypto';

import { DemoAdapter, setAdapter } from '../lib/adapters';
import { CONTRACT_VERSION, type Guardrails } from '../lib/contracts';
import { DEMO_SHOP_DOMAIN } from '../lib/demo/generator';
import { encryptSecret } from '../lib/crypto';
import type { Rollout, RolloutVariant } from '../lib/types';
import { POST as forecast } from '../app/api/forecast/route';
import { POST as createRollout } from '../app/api/rollouts/route';
import { GET as getRollout } from '../app/api/rollouts/[id]/route';
import { POST as confirmRollout } from '../app/api/rollouts/[id]/confirm/route';
import { POST as pauseRollout } from '../app/api/rollouts/[id]/pause/route';
import { POST as rollback } from '../app/api/rollouts/[id]/rollback/route';
import { GET as journal } from '../app/api/journal/route';
import { POST as killSwitch, DELETE as releaseKillSwitch } from '../app/api/kill-switch/route';
import { POST as sync } from '../app/api/sync/route';
import { GET as syncStatus } from '../app/api/sync/status/route';

const API_KEY = 'merchant-api-test-key';
const API_SECRET = 'merchant-api-test-secret';
const OTHER_SHOP = 'other-merchant.myshopify.com';
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
    (bearer?: string) => releaseKillSwitch(authGet('/api/kill-switch?shop=' + DEMO_SHOP_DOMAIN, bearer)),
    (bearer?: string) => confirmRollout(request('/api/rollouts/unknown/confirm', { confirm: true }, bearer), {
      params: Promise.resolve({ id: 'unknown' }),
    }),
    (bearer?: string) => pauseRollout(request('/api/rollouts/unknown/pause', { confirm: true }, bearer), {
      params: Promise.resolve({ id: 'unknown' }),
    }),
  ];
  for (const call of calls) {
    const missing = await call();
    const invalid = await call(forged);
    assert(missing.status === 401, `missing token returned ${missing.status}`);
    assert(invalid.status === 401, `forged token returned ${invalid.status}`);
  }
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

test('sync derives credentials from the token tenant, never ?shop or static env', async () => {
  process.env.PRICEFLAG_MODE = 'real';
  let contacted = false;
  globalThis.fetch = (async (): Promise<Response> => {
    contacted = true;
    throw new Error('cross-shop sync must not contact Shopify');
  }) as typeof fetch;
  try {
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
  });

  const response = await releaseKillSwitch(
    authGet(`/api/kill-switch?shop=${DEMO_SHOP_DOMAIN}`, token(OTHER_SHOP)),
  );
  assert(response.status === 200, `release returned ${response.status}`);
  assert((await adapter.getShop(shopId))?.kill_switch_engaged_at !== null, 'primary switch was released cross-shop');
  assert((await adapter.getShop(otherShopId))?.kill_switch_engaged_at === null, 'token tenant switch stayed engaged');

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
  const frozen = fixture.variants[0];
  assert(frozen !== undefined, 'compare-at fixture has no variant');
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

test('kill switch fails honestly when an evaluator still holds a rollout lease', async () => {
  const fixture = await createTestDraft();
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
    killSwitch(request('/api/kill-switch', { reason: 'lease race regression' }, token(DEMO_SHOP_DOMAIN))),
  );
  assert(locked.acquired, 'test could not acquire the contested lease');
  const response = locked.result as Response;
  const body = await json(response);
  assert(response.status === 207 && body.ok === false, 'busy kill switch reported complete success');
  assert(
    body.failures?.some((failure: { rollout_id: string; code: string }) =>
      failure.rollout_id === fixture.rollout.id && failure.code === 'rollout_busy'),
    'busy rollout was not named in the kill-switch result',
  );
  assert((await adapter.getShop(shopId))?.kill_switch_engaged_at !== null, 'partial kill switch was released');
  await releaseKillSwitch(authGet('/api/kill-switch', token(DEMO_SHOP_DOMAIN)));
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
