import assert from 'node:assert/strict';

import { NextRequest } from 'next/server';

import { POST } from '../app/api/ml/ingest/route';
import { DemoAdapter, setAdapter } from '../lib/adapters';
import { DEMO_SHOP_DOMAIN } from '../lib/demo/generator';

process.env.ML_INGEST_SECRET = 'test-only-secret';

const adapter = DemoAdapter.ephemeral(81);
setAdapter(adapter);

function request(payload: unknown, secret = 'test-only-secret'): NextRequest {
  return new NextRequest('http://localhost/api/ml/ingest', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main(): Promise<void> {
  const shop = await adapter.getShopByDomain(DEMO_SHOP_DOMAIN);
  assert(shop);
  const product = (await adapter.listProducts(shop.id, { limit: 1 })).items[0];
  assert(product);
  const fit = {
    contract_version: '1.0.0',
    shop_domain: DEMO_SHOP_DOMAIN,
    variant_gid: product.variant_gid,
    elasticity: -1.4,
    se: 0.2,
    low: -1.7,
    high: -1.1,
    interval: 0.8,
    n_obs: 500,
    price_variation_pct: 12,
    confidence: 'fitted',
    model_version: 'test-fit-1',
    fitted_at: '2026-08-04T00:00:00Z',
  };
  const payload = {
    shop_domain: DEMO_SHOP_DOMAIN,
    model_run: { kind: 'elasticity', model_version: 'test-fit-1', gate_passed: true },
    fits: [fit],
    bands: [],
    reports: [],
  };
  const first = await POST(request(payload));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(
    [firstBody.fits_written, firstBody.bands_written, firstBody.reports_written, firstBody.rows_written],
    [1, 0, 0, 1],
  );
  assert.equal(firstBody.deduplicated, false);

  const retry = await POST(request(payload));
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.model_run_id, firstBody.model_run_id);
  assert.equal(retryBody.deduplicated, true);
  assert.equal((await adapter.listModelRuns(null)).length, 1);

  const wrongShop = await POST(request({ ...payload, fits: [{ ...fit, shop_domain: 'other.myshopify.com' }] }));
  assert.equal(wrongShop.status, 422);

  const band = {
    contract_version: '1.0.0',
    shop_domain: DEMO_SHOP_DOMAIN,
    variant_gid: product.variant_gid,
    day: '2026-08-05',
    expected_units: 10,
    low: 7,
    high: 14,
    interval: 0.8,
    band_kind: 'baseline',
    rollout_id: '123e4567-e89b-42d3-a456-426614174000',
    is_floored: false,
    model_version: 'test-band-1',
    generated_at: '2026-08-04T00:00:00Z',
  };
  const baselineScoped = await POST(
    request({
      shop_domain: DEMO_SHOP_DOMAIN,
      model_run: { kind: 'baseline', model_version: 'test-band-1', gate_passed: true },
      bands: [band],
    }),
  );
  assert.equal(baselineScoped.status, 422, 'baseline bands must have null rollout_id');

  const foreignCounterfactual = await POST(
    request({
      shop_domain: DEMO_SHOP_DOMAIN,
      model_run: { kind: 'counterfactual', model_version: 'test-band-1', gate_passed: true },
      bands: [{ ...band, band_kind: 'counterfactual' }],
    }),
  );
  assert.equal(foreignCounterfactual.status, 500, 'counterfactual rollout ownership is checked at write time');

  // Satisfies every `required` field of contracts/price_recommendation.schema.json.
  const recommendation = {
    contract_version: '1.0.0',
    shop_domain: DEMO_SHOP_DOMAIN,
    variant_gid: product.variant_gid,
    current_price_cents: 2500,
    recommended_price_cents: 2699,
    robust_price_cents: 2599,
    rounding: 'end_99',
    elasticity: -1.4,
    confidence: 'fitted',
    expected: {
      nominal_profit_delta_cents_per_day: 320,
      robust_profit_delta_cents_per_day: -40,
      nominal_revenue_delta_cents_per_day: 510,
      robust_revenue_delta_cents_per_day: 120,
    },
    constraints: { binding: ['none'] },
    candidates_evaluated: 48,
    rationale: 'A small increase to $26.99 should add profit; demand looks steady near this price.',
    model_version: 'optimizer-1.0',
    computed_at: '2026-08-11T00:00:00Z',
  };

  // A valid recommendation row clears contract validation: with the gate closed
  // the run is recorded and the rows discarded (200), which proves the 422s
  // below are about the rows, not the kind. (The accepted write path lands with
  // the recommendations table + RPC.)
  const recGateClosed = await POST(
    request({
      shop_domain: DEMO_SHOP_DOMAIN,
      model_run: { kind: 'recommendation', model_version: 'optimizer-1.0', gate_passed: false },
      recommendations: [recommendation],
    }),
  );
  assert.equal(recGateClosed.status, 200, 'a valid recommendation row must clear contract validation');
  assert.equal((await recGateClosed.json()).reason, 'gate_not_passed');

  const recInvalidRow = await POST(
    request({
      shop_domain: DEMO_SHOP_DOMAIN,
      model_run: { kind: 'recommendation', model_version: 'optimizer-1.0', gate_passed: true },
      recommendations: [{ ...recommendation, recommended_price_cents: 0 }],
    }),
  );
  assert.equal(recInvalidRow.status, 422, 'a zero-cent recommendation must be rejected at the door');

  const recForeignShop = await POST(
    request({
      shop_domain: DEMO_SHOP_DOMAIN,
      model_run: { kind: 'recommendation', model_version: 'optimizer-1.0', gate_passed: true },
      recommendations: [{ ...recommendation, shop_domain: 'other.myshopify.com' }],
    }),
  );
  assert.equal(recForeignShop.status, 422, 'recommendation rows must match the ingest shop');

  const recWrongSurface = await POST(
    request({
      shop_domain: DEMO_SHOP_DOMAIN,
      model_run: { kind: 'recommendation', model_version: 'optimizer-1.0', gate_passed: true },
      recommendations: [recommendation],
      fits: [fit],
    }),
  );
  assert.equal(recWrongSurface.status, 400, 'a recommendation run cannot carry fits');

  const fitCarryingRecommendations = await POST(
    request({
      ...payload,
      model_run: { kind: 'elasticity', model_version: 'test-fit-1', gate_passed: true },
      recommendations: [recommendation],
    }),
  );
  assert.equal(fitCarryingRecommendations.status, 400, 'an elasticity run cannot carry recommendations');

  const unauthorized = await POST(request(payload, 'wrong'));
  assert.equal(unauthorized.status, 401);

  const runsBeforeUninstall = (await adapter.listModelRuns(null)).length;
  await adapter.updateShop(shop.id, { uninstalled_at: '2026-08-04T01:00:00Z' });
  const afterUninstall = await POST(
    request({
      ...payload,
      model_run: { kind: 'elasticity', model_version: 'test-fit-after-uninstall', gate_passed: true },
      fits: [{ ...fit, model_version: 'test-fit-after-uninstall' }],
    }),
  );
  assert.equal(afterUninstall.status, 404, 'an uninstalled store must reject new model output');
  assert.equal(
    (await adapter.listModelRuns(null)).length,
    runsBeforeUninstall,
    'the rejected ingest must not create a model run',
  );

  setAdapter(null);
  console.log(
    'ML ingest API: atomic counts, retry idempotency, tenant metadata, uninstall state and secret checks passed.',
  );
}

void main();
