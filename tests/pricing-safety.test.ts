import { DemoAdapter } from '../lib/adapters/demo';
import type { StoreAdapter } from '../lib/adapters/types';
import { computeTargetPrice } from '../lib/engine/forecast';
import { normalizeStages, planRolloutVariants } from '../lib/engine/rollout';
import { applyStage, rollbackRollout } from '../lib/pricing/writer';
import { ShopifyApiError, type AdminGraphqlClient } from '../lib/shopify/client';
import { CredentialError, credentialsFromShop } from '../lib/shopify/credentials';
import { writeProductVariantPrices, type PriceWrite } from '../lib/shopify/prices';
import type { RolloutVariant, Shop } from '../lib/types';
import { FakeShopify, makeProduct, makeRolloutCreate } from './integration/_harness';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  await run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

async function expectInvalidAcknowledgement(payload: unknown, writes: readonly PriceWrite[]): Promise<void> {
  const client = {
    request: async () => payload,
  } as unknown as AdminGraphqlClient;
  let error: unknown;
  try {
    await writeProductVariantPrices(client, 'gid://shopify/Product/1', writes);
  } catch (cause) {
    error = cause;
  }
  assert(error instanceof ShopifyApiError, 'invalid acknowledgement did not throw ShopifyApiError');
  assert(error.code === 'invalid_response', `unexpected acknowledgement error code ${error.code}`);
}

function shop(overrides: Partial<Shop> = {}): Shop {
  const now = new Date().toISOString();
  return {
    id: 'shop-pricing-safety',
    shop_domain: 'pricing-safety.myshopify.com',
    name: 'Pricing Safety',
    email: null,
    access_token_enc: null,
    scopes: null,
    api_version: '2026-07',
    currency: 'USD',
    timezone: 'UTC',
    plan_name: null,
    mode: 'real',
    kill_switch_engaged_at: null,
    kill_switch_reason: null,
    notify_emails: [],
    installed_at: now,
    uninstalled_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const writes: PriceWrite[] = [
    { variantGid: 'gid://shopify/ProductVariant/1', priceCents: 1200, compareAtCents: null },
    { variantGid: 'gid://shopify/ProductVariant/2', priceCents: 2200, compareAtCents: 3000 },
  ];
  const exact = [
    { id: writes[0]!.variantGid, price: '12.00', compareAtPrice: null },
    { id: writes[1]!.variantGid, price: '22.00', compareAtPrice: '30.00' },
  ];

  await test('missing Shopify bulk acknowledgement is rejected', () =>
    expectInvalidAcknowledgement({}, writes),
  );
  await test('null Shopify bulk acknowledgement is rejected', () =>
    expectInvalidAcknowledgement({ productVariantsBulkUpdate: null }, writes),
  );
  await test('partial Shopify bulk acknowledgement is rejected', () =>
    expectInvalidAcknowledgement(
      { productVariantsBulkUpdate: { productVariants: exact.slice(0, 1), userErrors: [] } },
      writes,
    ),
  );
  await test('extra Shopify bulk acknowledgement is rejected', () =>
    expectInvalidAcknowledgement(
      {
        productVariantsBulkUpdate: {
          productVariants: [
            ...exact,
            { id: 'gid://shopify/ProductVariant/3', price: '32.00', compareAtPrice: null },
          ],
          userErrors: [],
        },
      },
      writes,
    ),
  );
  await test('wrong acknowledged Shopify price is rejected', () =>
    expectInvalidAcknowledgement(
      {
        productVariantsBulkUpdate: {
          productVariants: [{ ...exact[0]!, price: '12.01' }, exact[1]],
          userErrors: [],
        },
      },
      writes,
    ),
  );
  await test('wrong acknowledged Shopify compare-at is rejected', () =>
    expectInvalidAcknowledgement(
      {
        productVariantsBulkUpdate: {
          productVariants: [exact[0], { ...exact[1]!, compareAtPrice: null }],
          userErrors: [],
        },
      },
      writes,
    ),
  );

  await test('the shared Shopify mutation boundary rejects a zero-dollar write', async () => {
    let contacted = false;
    const client = {
      request: async () => {
        contacted = true;
        throw new Error('the zero-dollar write reached Shopify');
      },
    } as unknown as AdminGraphqlClient;
    let error: unknown;
    try {
      await writeProductVariantPrices(client, 'gid://shopify/Product/1', [
        { variantGid: 'gid://shopify/ProductVariant/1', priceCents: 0 },
      ]);
    } catch (cause) {
      error = cause;
    }
    assert(error instanceof RangeError, 'the low-level writer accepted a zero-dollar price');
    assert(!contacted, 'the low-level writer contacted Shopify before validating the price');
  });

  const envNames = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'VERCEL_ENV'] as const;
  const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  try {
    process.env.SHOPIFY_SHOP_DOMAIN = 'pricing-safety.myshopify.com';
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'local-test-token';
    process.env.VERCEL_ENV = 'preview';

    await test('uninstall state wins before the static-token branch', () => {
      let error: unknown;
      try {
        credentialsFromShop(shop({ uninstalled_at: new Date().toISOString() }));
      } catch (cause) {
        error = cause;
      }
      assert(error instanceof CredentialError, 'uninstalled shop did not throw CredentialError');
      assert(error.code === 'shop_uninstalled', `unexpected uninstall error ${error.code}`);
    });

    await test('production rejects static Shopify write credentials', () => {
      process.env.VERCEL_ENV = 'production';
      let error: unknown;
      try {
        credentialsFromShop(shop());
      } catch (cause) {
        error = cause;
      }
      assert(error instanceof CredentialError, 'production static credential did not throw CredentialError');
      assert(error.code === 'static_credentials_forbidden', `unexpected production error ${error.code}`);
    });
  } finally {
    for (const name of envNames) {
      const value = originalEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  await test('planning rejects a zero-dollar target', () => {
    let rejected = false;
    try {
      computeTargetPrice(1000, { type: 'percent', percent: -100 });
    } catch {
      rejected = true;
    }
    assert(rejected, 'planning accepted a zero-dollar target');
  });

  await test('the immediate pre-write boundary rejects corrupt zero-dollar intent', async () => {
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const storedShop = await adapter.upsertShop({
      shop_domain: 'pricing-safety.myshopify.com',
      mode: 'demo',
      currency: 'USD',
    });
    const product = makeProduct(900, { priceCents: 1000, productIndex: 900 }, storedShop.id);
    const stages = normalizeStages(undefined, 1);
    const rollout = await adapter.createRollout(
      makeRolloutCreate({
        shop_id: storedShop.id,
        status: 'running',
        stages,
        current_stage: stages.length - 1,
        stage_entered_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      }),
    );
    await adapter.insertRolloutVariants(
      planRolloutVariants({
        rolloutId: rollout.id,
        shopId: storedShop.id,
        products: [product],
        change: { type: 'percent', percent: 10 },
        stages,
      }),
    );

    const corruptAdapter = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'getRolloutVariants') {
          return async (rolloutId: string): Promise<RolloutVariant[]> =>
            (await target.getRolloutVariants(rolloutId)).map((row) => ({
              ...row,
              excluded: false,
              target_price_cents: 0,
            }));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StoreAdapter;
    const fakeShopify = new FakeShopify().seed([product]);
    const result = await applyStage(
      { adapter: corruptAdapter, client: fakeShopify.asClient(), shop: storedShop },
      rollout,
      stages.length - 1,
    );
    assert(result.applied === 0 && result.failed === 1, 'writer did not reject corrupt zero-dollar intent');
    assert(fakeShopify.writeLog.length === 0, 'zero-dollar mutation reached Shopify');
  });

  await test('rollback rejects a corrupt zero-dollar baseline before Shopify', async () => {
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const storedShop = await adapter.upsertShop({
      shop_domain: 'rollback-pricing-safety.myshopify.com',
      mode: 'demo',
      currency: 'USD',
    });
    const product = makeProduct(901, { priceCents: 1000, productIndex: 901 }, storedShop.id);
    const stages = normalizeStages(undefined, 1);
    const rollout = await adapter.createRollout(
      makeRolloutCreate({
        shop_id: storedShop.id,
        status: 'running',
        stages,
        current_stage: stages.length - 1,
        stage_entered_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      }),
    );
    await adapter.insertRolloutVariants(
      planRolloutVariants({
        rolloutId: rollout.id,
        shopId: storedShop.id,
        products: [product],
        change: { type: 'percent', percent: 10 },
        stages,
      }),
    );
    const corruptAdapter = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'getRolloutVariants') {
          return async (rolloutId: string): Promise<RolloutVariant[]> =>
            (await target.getRolloutVariants(rolloutId)).map((row) => ({
              ...row,
              excluded: false,
              baseline_price_cents: 0,
            }));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StoreAdapter;
    const fakeShopify = new FakeShopify().seed([product]);
    fakeShopify.setPrice(product.variant_gid, 1100);
    const result = await rollbackRollout(
      { adapter: corruptAdapter, client: fakeShopify.asClient(), shop: storedShop },
      rollout,
      { reason: 'corrupt baseline regression' },
    );
    assert(result.applied === 0 && result.failed === 1, 'rollback accepted a zero-dollar baseline');
    assert(fakeShopify.writeLog.length === 0, 'zero-dollar rollback mutation reached Shopify');
    assert(fakeShopify.priceOf(product.variant_gid) === 1100, 'rollback changed the live price after rejecting it');
  });

  await test('a shop stop stamped after the live read blocks the forward mutation', async () => {
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const storedShop = await adapter.upsertShop({
      shop_domain: 'last-boundary-stop.myshopify.com',
      mode: 'demo',
      currency: 'USD',
    });
    const product = makeProduct(902, { priceCents: 1000, productIndex: 902 }, storedShop.id);
    const stages = normalizeStages(undefined, 1);
    const rollout = await adapter.createRollout(
      makeRolloutCreate({
        shop_id: storedShop.id,
        status: 'running',
        stages,
        current_stage: stages.length - 1,
        stage_entered_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      }),
    );
    await adapter.insertRolloutVariants(
      planRolloutVariants({
        rolloutId: rollout.id,
        shopId: storedShop.id,
        products: [product],
        change: { type: 'percent', percent: 10 },
        stages,
      }),
    );
    const fakeShopify = new FakeShopify().seed([product]);
    const underlying = fakeShopify.asClient();
    let stopStamped = false;
    const client = {
      request: async (query: string, variables: Record<string, unknown>) => {
        const response = await underlying.request(query, variables);
        if (!stopStamped && query.includes('PriceflagVariantPrices')) {
          stopStamped = true;
          await adapter.updateShop(storedShop.id, {
            kill_switch_engaged_at: new Date().toISOString(),
            kill_switch_reason: 'race regression',
          });
        }
        return response;
      },
    } as unknown as AdminGraphqlClient;

    const result = await applyStage({ adapter, client, shop: storedShop }, rollout, stages.length - 1);
    assert(stopStamped, 'fixture did not stamp the stop after the live read');
    assert(result.applied === 0 && result.failed === 1, 'writer continued after the store-wide stop');
    assert(fakeShopify.writeLog.length === 0, 'a Shopify mutation happened after the store-wide stop');
    assert(fakeShopify.priceOf(product.variant_gid) === 1000, 'the storefront price changed after the stop');
  });

  await test('rollback preserves compare-at when Priceflag never managed it', async () => {
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const storedShop = await adapter.upsertShop({
      shop_domain: 'unmanaged-compare-at.myshopify.com',
      mode: 'demo',
      currency: 'USD',
    });
    const product = makeProduct(903, { priceCents: 1000, compareAtCents: null, productIndex: 903 }, storedShop.id);
    const stages = normalizeStages(undefined, 1);
    const rollout = await adapter.createRollout(
      makeRolloutCreate({
        shop_id: storedShop.id,
        status: 'running',
        stages,
        current_stage: 0,
        stage_entered_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      }),
    );
    await adapter.insertRolloutVariants(
      planRolloutVariants({
        rolloutId: rollout.id,
        shopId: storedShop.id,
        products: [product],
        change: { type: 'percent', percent: 10 },
        stages,
      }),
    );
    const fakeShopify = new FakeShopify().seed([product]);
    const applied = await applyStage({ adapter, client: fakeShopify.asClient(), shop: storedShop }, rollout, 0);
    assert(applied.fully_applied, 'fixture did not activate the target price');
    fakeShopify.setPrice(product.variant_gid, 1100, 1500);

    const undo = await rollbackRollout(
      { adapter, client: fakeShopify.asClient(), shop: storedShop },
      rollout,
      { reason: 'unmanaged compare-at regression' },
    );
    assert(undo.fully_applied, 'an unmanaged compare-at blocked the price rollback');
    assert(fakeShopify.priceOf(product.variant_gid) === 1000, 'baseline price was not restored');
    assert(fakeShopify.compareAtOf(product.variant_gid) === 1500, 'merchant compare-at was overwritten');
  });

  await test('rollback pauses on a merchant compare-at edit that Priceflag had managed', async () => {
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const storedShop = await adapter.upsertShop({
      shop_domain: 'managed-compare-at.myshopify.com',
      mode: 'demo',
      currency: 'USD',
    });
    const product = makeProduct(904, { priceCents: 1000, compareAtCents: 1050, productIndex: 904 }, storedShop.id);
    const stages = normalizeStages(undefined, 1);
    const rollout = await adapter.createRollout(
      makeRolloutCreate({
        shop_id: storedShop.id,
        status: 'running',
        stages,
        current_stage: 0,
        stage_entered_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      }),
    );
    await adapter.insertRolloutVariants(
      planRolloutVariants({
        rolloutId: rollout.id,
        shopId: storedShop.id,
        products: [product],
        change: { type: 'percent', percent: 10 },
        stages,
      }),
    );
    const fakeShopify = new FakeShopify().seed([product]);
    const applied = await applyStage({ adapter, client: fakeShopify.asClient(), shop: storedShop }, rollout, 0);
    assert(applied.fully_applied, 'fixture did not activate the managed compare-at target');
    fakeShopify.setPrice(product.variant_gid, 1100, 1300);
    const writesBefore = fakeShopify.writeLog.length;

    const undo = await rollbackRollout(
      { adapter, client: fakeShopify.asClient(), shop: storedShop },
      rollout,
      { reason: 'managed compare-at merchant edit regression' },
    );
    assert(undo.external_changes.length === 1, 'compare-at-only merchant edit was not reported external');
    assert(fakeShopify.writeLog.length === writesBefore, 'rollback wrote over a merchant compare-at edit');
    assert(fakeShopify.priceOf(product.variant_gid) === 1100, 'merchant-edited target price moved');
    assert(fakeShopify.compareAtOf(product.variant_gid) === 1300, 'merchant compare-at was overwritten');
  });

  process.stdout.write(`${passed}/${passed} pricing safety tests passed\n`);
}

main().catch((cause) => {
  process.stderr.write(`FAIL ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
