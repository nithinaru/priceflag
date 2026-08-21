import assert from 'node:assert/strict';

import { NextRequest } from 'next/server';

import { POST } from '../app/api/ml/export/route';
import { DemoAdapter, setAdapter } from '../lib/adapters';
import { DEMO_SHOP_DOMAIN } from '../lib/demo/generator';

process.env.ML_INGEST_SECRET = 'test-only-secret';
process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
process.env.VERCEL_ENV = 'preview';
process.env.PRICEFLAG_MODE = 'real';

const adapter = DemoAdapter.ephemeral(91);
setAdapter(adapter);

function request(payload: unknown, secret = 'test-only-secret'): NextRequest {
  return new NextRequest('http://localhost/api/ml/export', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function body(payload: unknown, secret?: string): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await POST(request(payload, secret));
  return { response, json: (await response.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  const seededShop = await adapter.getShopByDomain(DEMO_SHOP_DOMAIN);
  assert(seededShop);
  await adapter.updateShop(seededShop.id, { mode: 'real' });

  const unauthorized = await body({ operation: 'attest' }, 'wrong');
  assert.equal(unauthorized.response.status, 401);

  process.env.PRICEFLAG_MODE = 'demo';
  const demoMode = await body({ operation: 'attest' });
  assert.equal(demoMode.response.status, 503);
  process.env.PRICEFLAG_MODE = 'real';

  const attestation = await body({ operation: 'attest' });
  assert.equal(attestation.response.status, 200);
  assert.equal(attestation.response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(attestation.json.source, 'priceflag-ml-export');
  assert.equal(attestation.json.project_ref, 'abcdefghijklmnopqrst');
  assert.equal(attestation.json.environment, 'staging');
  assert.deepEqual(attestation.json.shops, [DEMO_SHOP_DOMAIN]);
  assert.doesNotMatch(JSON.stringify(attestation.json), /access_token|secret/i);

  const firstProducts = await body({
    operation: 'read',
    surface: 'products',
    shop_domain: DEMO_SHOP_DOMAIN,
    cursor: 0,
    limit: 1,
  });
  assert.equal(firstProducts.response.status, 200);
  assert.equal((firstProducts.json.rows as unknown[]).length, 1);
  assert.equal(firstProducts.json.next_cursor, 1);
  assert.doesNotMatch(JSON.stringify(firstProducts.json), /access_token|email|customer/i);

  // Shopify catalogs commonly contain many variants with the same visible
  // title. Exercise a page boundary larger than the maximum response and prove
  // that the adapter's unique variant_gid tie-breaker neither drops nor repeats
  // a row across OFFSET pages.
  await adapter.upsertProducts(
    seededShop.id,
    Array.from({ length: 1_005 }, (_, index) => ({
      product_gid: `gid://shopify/Product/${90_000 + index}`,
      variant_gid: `gid://shopify/ProductVariant/${90_000 + index}`,
      inventory_item_gid: null,
      title: 'Identical catalog title',
      variant_title: 'Default Title',
      sku: null,
      vendor: 'Pagination Test',
      product_type: 'Coffee',
      tags: [],
      image_url: null,
      status: 'ACTIVE' as const,
      price_cents: 1_500,
      compare_at_cents: null,
      currency: 'USD',
      cogs_cents: 500,
      cogs_source: 'manual' as const,
      cogs_updated_at: null,
      is_gift_card: false,
      requires_selling_plan: false,
      has_selling_plan: false,
      inventory_quantity: 100,
      available_for_sale: true,
    })),
  );
  const catalogTotal = (await adapter.listProducts(seededShop.id)).total;
  const exportedVariantGids: string[] = [];
  let productCursor: number | null = 0;
  while (productCursor !== null) {
    const exported = await body({
      operation: 'read',
      surface: 'products',
      shop_domain: DEMO_SHOP_DOMAIN,
      cursor: productCursor,
      limit: 1_000,
    });
    assert.equal(exported.response.status, 200);
    exportedVariantGids.push(
      ...(exported.json.rows as Array<{ variant_gid: string }>).map((row) => row.variant_gid),
    );
    productCursor = exported.json.next_cursor as number | null;
  }
  assert.equal(exportedVariantGids.length, catalogTotal);
  assert.equal(new Set(exportedVariantGids).size, catalogTotal);

  for (const surface of ['product_days', 'price_history', 'rollout_windows'] as const) {
    const exported = await body({ operation: 'read', surface, shop_domain: DEMO_SHOP_DOMAIN });
    assert.equal(exported.response.status, 200, surface);
    assert.ok(Array.isArray(exported.json.rows), surface);
    assert.doesNotMatch(JSON.stringify(exported.json), /access_token|email|customer/i, surface);
  }

  const foreign = await body({ operation: 'read', surface: 'products', shop_domain: 'foreign.myshopify.com' });
  assert.equal(foreign.response.status, 404);
  const oversized = await body({
    operation: 'read',
    surface: 'products',
    shop_domain: DEMO_SHOP_DOMAIN,
    limit: 1_001,
  });
  assert.equal(oversized.response.status, 400);

  const shop = await adapter.getShopByDomain(DEMO_SHOP_DOMAIN);
  assert(shop);
  const sha = 'a'.repeat(40);
  const run = await adapter.recordModelRun({
    shop_id: shop.id,
    kind: 'elasticity',
    model_version: 'export-test',
    git_sha: sha,
    status: 'succeeded',
    gate_passed: true,
    incumbent_version: null,
    metrics: {},
    rows_written: 3,
    notes: null,
    error: null,
    finished_at: new Date().toISOString(),
  });
  const verified = await body({
    operation: 'verify_receipts',
    shop_domain: DEMO_SHOP_DOMAIN,
    receipts: [{ id: run.id, git_sha: sha, rows_written: 3 }],
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.json.verified, 1);
  const mismatch = await body({
    operation: 'verify_receipts',
    shop_domain: DEMO_SHOP_DOMAIN,
    receipts: [{ id: run.id, git_sha: sha, rows_written: 2 }],
  });
  assert.equal(mismatch.response.status, 409);

  const originalListRollouts = adapter.listRollouts.bind(adapter);
  const originalConsoleError = console.error;
  let backendFailure: Awaited<ReturnType<typeof body>>;
  try {
    adapter.listRollouts = async () => {
      throw new Error('private database detail must not cross the API boundary');
    };
    console.error = () => {};
    backendFailure = await body({
      operation: 'read',
      surface: 'rollout_windows',
      shop_domain: DEMO_SHOP_DOMAIN,
    });
  } finally {
    console.error = originalConsoleError;
    adapter.listRollouts = originalListRollouts;
  }
  assert.equal(backendFailure.response.status, 503);
  assert.deepEqual(backendFailure.json.error, {
    code: 'backend_unavailable',
    message: 'The ML export backend is temporarily unavailable.',
    retryable: true,
    details: null,
  });
  assert.doesNotMatch(JSON.stringify(backendFailure.json), /private database detail/);

  setAdapter(null);
  console.log('ML export API: secret auth, narrow fields, pagination, shop scope and receipt read-back passed.');
}

void main();
