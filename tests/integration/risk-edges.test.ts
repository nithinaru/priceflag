/**
 * Lane D — ranked risk edges from the 2026-08 read-through.
 *
 * Each test carries a one-line comment naming the merchant-facing consequence
 * of the behavior it pins or the bug it exposes. Tests written against the
 * DESIRED behavior are allowed to fail: a failure here is a finding, and the
 * underlying code is deliberately not changed by this suite.
 *
 * Run: `npx tsx tests/integration/run.ts`
 */

import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';

import { POST as webhookPost } from '../../app/api/webhooks/[topic]/route';
import { maxDuration as cronMaxDuration } from '../../app/api/cron/evaluate/route';
import { DemoAdapter, setAdapter } from '../../lib/adapters';
import type { StoreAdapter } from '../../lib/adapters/types';
import { CONTRACT_VERSION } from '../../lib/contracts';
import type { Guardrails } from '../../lib/contracts';
import { addDays, nowIso, yesterday, type DayString } from '../../lib/dates';
import { computeTargetPrice } from '../../lib/engine/forecast';
import {
  evaluateGuardrails,
  ruleConditionHolds,
  type DailyObservation,
  type GuardrailAssessment,
} from '../../lib/engine/guardrails';
import { assignCohorts, decideNext, liveCountAtStage, normalizeStages } from '../../lib/engine/rollout';
import { evaluateRollout } from '../../lib/evaluator/index';
import { parseMoneyToCents, formatCentsAsShopifyMoney } from '../../lib/money';
import { applyStage, rollbackRollout } from '../../lib/pricing/writer';
import type { AdminGraphqlClient } from '../../lib/shopify/client';
import { signWebhookBody } from '../../lib/shopify/hmac';
import { webhookTopicToken } from '../../lib/shopify/webhooks';
import type { Shop } from '../../lib/types';

import { makeScenario, advanceTo } from './invariants.test';
import {
  assert,
  assertEqual,
  assertExactCents,
  makeProduct,
  section,
  test,
  uniqueId,
} from './_harness';

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

const noRules: Guardrails = { contract_version: CONTRACT_VERSION, auto_rollback: false, rules: [] };

const emptyAssessment: GuardrailAssessment = {
  breach: false,
  streak: 0,
  rule_id: null,
  reason: null,
  action: null,
  floored: false,
  skipped: [],
};

function unitsRule(overrides: Partial<Guardrails['rules'][number]> = {}): Guardrails {
  return {
    contract_version: CONTRACT_VERSION,
    auto_rollback: true,
    rules: [
      {
        id: 'risk-edge-units',
        metric: 'units',
        comparison: 'below_expected_pct',
        threshold_pct: 30,
        consecutive_days: 2,
        scope: 'rollout',
        action: 'rollback_all',
        sentence: 'If daily units fall more than 30% below expected for 2 days in a row, revert everything.',
        ...overrides,
      },
    ],
  };
}

function observation(day: DayString, actual: number, expected: number, low: number, high: number): DailyObservation {
  return {
    day,
    stage_index: 0,
    actual_units: actual,
    actual_revenue_cents: actual * 2000,
    actual_profit_cents: actual * 800,
    expected_units: expected,
    expected_low: low,
    expected_high: high,
    expected_revenue_cents: Math.round(expected * 2000),
    expected_profit_cents: Math.round(expected * 800),
    breach_probability: null,
  };
}

// ---------------------------------------------------------------------------
// pure engine edges
// ---------------------------------------------------------------------------

export async function runRiskEdgePureSuite(): Promise<void> {
  section('risk edges — engine level');

  // A silently broken order-webhook feed is indistinguishable from a sales
  // collapse: the merchant's healthy rollout gets paused today, and reverted the
  // day auto-rollback ships, because nobody checks "did any data arrive at all?".
  await test('measurement outage: two days of missing order data fire the guardrail as if demand collapsed', async () => {
    const start: DayString = '2026-08-01';
    const history = [
      observation(start, 22, 20, 12, 28), // healthy day
      observation(addDays(start, 1), 0, 20, 12, 28), // webhooks broke — no data
      observation(addDays(start, 2), 0, 20, 12, 28), // still no data
    ];
    const assessment = evaluateGuardrails(unitsRule(), history);
    assertEqual(assessment.breach, true, 'a zero-data day registers as a breach, not a pipeline problem');
    assertEqual(
      assessment.action,
      'rollback_all',
      'two zero-data days fire the full guardrail action — the evaluator has no data-health check',
    );
  });

  // A store expecting under 3 units/day has guardrails that can NEVER fire, so a
  // real collapse is never judged while the merchant believes they are protected.
  await test('low-volume floor boundary: expected 2.9 can never breach, expected 3.0 can', async () => {
    const start: DayString = '2026-08-01';
    const rule = unitsRule({ consecutive_days: 1 });

    const quiet: DailyObservation[] = [];
    for (let day = 0; day < 14; day += 1) {
      quiet.push(observation(addDays(start, day), 0, 2.9, 1, 6));
      const assessment = evaluateGuardrails(rule, quiet);
      assertEqual(assessment.breach, false, `day ${day}: below the floor, no day can register a breach`);
      assertEqual(assessment.floored, true, `day ${day}: the skip is at least marked as floored`);
    }

    const loud = [observation(start, 0, 3, 1, 6)];
    const assessment = evaluateGuardrails(rule, loud);
    assertEqual(assessment.breach, true, 'at the floor exactly, a zero day is evidence again');
  });

  // The 0.80 probability line is where "noise" becomes "real" for the merchant:
  // one point below must never fire on a single sample, and exactly 0.80 must.
  await test('calibrated breach probability boundary sits exactly at 0.80', async () => {
    const rule = unitsRule().rules[0];
    assert(rule !== undefined, 'fixture rule exists');
    const below = ruleConditionHolds(rule, { ...observation('2026-08-01', 10, 20, 12, 28), breach_probability: 0.7999 });
    const at = ruleConditionHolds(rule, { ...observation('2026-08-01', 10, 20, 12, 28), breach_probability: 0.8 });
    assertEqual(below.holds, false, '0.7999 must not fire — a single noisy sample is not a drop');
    assertEqual(at.holds, true, '0.80 must fire — the model is saying the drop is real');
  });

  // A custom stage plan whose first stage rounds to zero variants starts a
  // rollout that never puts a price live, never advances, and never alerts —
  // a zombie the merchant believes is running.
  await test('every valid stage plan puts at least one variant live at stage 0', async () => {
    const gids = ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2', 'gid://shopify/ProductVariant/3'];
    const stages = normalizeStages(
      [
        { fraction: 0.1, hold_days: 3 },
        { fraction: 0.5, hold_days: 3 },
        { fraction: 1, hold_days: 3 },
      ],
      gids.length,
    );
    const cohorts = assignCohorts('rollout-risk-edge', gids, stages);
    assert(
      liveCountAtStage(cohorts, 0) >= 1,
      `stage 0 of a 10%/50%/100% plan over 3 variants has ${liveCountAtStage(cohorts, 0)} live variants — ` +
        'the evaluator returns too_early forever and the rollout is a silent zombie',
    );
  });

  // On a zero-decimal currency store (JPY/KRW), a fractional-major-unit target is
  // a price Shopify cannot represent: every write is rewritten by Shopify and
  // then fails Priceflag's own verification, stranding the rollout.
  await test('a percent change on a whole-yen price lands on a whole yen', async () => {
    // ¥999 stored as 99900 "cents" (the money layer assumes 100 subunits everywhere).
    const target = computeTargetPrice(99_900, { type: 'percent', percent: -5 }, 'JPY');
    assertEqual(
      target % 100,
      0,
      `-5% on ¥999 produced ${formatCentsAsShopifyMoney(target)} — a fractional yen. ` +
        'Shopify would round it, then reject our verification, stranding the rollout',
    );
    // A two-decimal currency must keep its cent precision.
    assertExactCents(
      computeTargetPrice(99_900, { type: 'percent', percent: -5 }, 'USD'),
      94_905,
      'a USD store still gets exact cents',
    );
  });

  // A stage entered at 11:50pm counts that ten-minute sliver as a full held day,
  // so a 3-day hold can watch the new price for barely 2 days of sales.
  await test('calendar-day holds: a late-evening stage entry shortens the promised hold by up to a day', async () => {
    const rollout = {
      status: 'running' as const,
      stages: [
        { index: 0, fraction: 0.25, hold_days: 3 },
        { index: 1, fraction: 0.5, hold_days: 3 },
        { index: 2, fraction: 1, hold_days: 3 },
      ],
      current_stage: 0,
      // 2026-07-01 23:50 in America/New_York (EDT) — ten minutes before midnight.
      stage_entered_at: '2026-07-02T03:50:00.000Z',
      guardrails: noRules,
    };
    const decision = decideNext({ rollout, assessment: emptyAssessment, asOf: '2026-07-04', timezone: 'America/New_York' });
    // Pinned current behavior: ~2.0 elapsed days count as 3 held calendar days.
    // If this ever changes to true elapsed time, this test should be updated deliberately.
    assertEqual(decision.decision, 'advance', 'holds are counted in shop-local calendar days, slivers included');
  });

  // If the rollout lease could expire while a serverless writer is still running,
  // two writers could interleave and double-write a merchant's prices.
  await test('the rollout lease TTL outlives the longest serverless writer', async () => {
    const source = readFileSync(new URL('../../lib/adapters/supabase.ts', import.meta.url), 'utf8');
    const match = /ttlSeconds\s*=\s*(\d+)/.exec(source);
    assert(match !== null, 'the default lease TTL is discoverable in lib/adapters/supabase.ts');
    const ttl = Number(match[1]);
    assert(
      ttl > cronMaxDuration,
      `lease TTL ${ttl}s must exceed the evaluator route's maxDuration ${cronMaxDuration}s`,
    );
  });

  await test('a demand drop is noticed without a human running the evaluator workflow', async () => {
    const workflow = readFileSync(new URL('../../.github/workflows/evaluator.yml', import.meta.url), 'utf8');
    const vercel = readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8');
    assert(/schedule:/.test(workflow) && /cron:/.test(workflow), 'evaluator.yml must have a schedule');
    assert(!/"crons"/.test(vercel), 'do not put the evaluator on Vercel Cron');
  });
}

// ---------------------------------------------------------------------------
// adapter-backed edges
// ---------------------------------------------------------------------------

export async function runRiskEdgeSuite(adapter: StoreAdapter, shop: Shop, label: string): Promise<void> {
  section(`[${label}] risk edges — rollout lifecycle`);

  // After a stage advance the day is never marked evaluated, so the next tick
  // re-judges it against the NEW cohort and overwrites its recorded reading —
  // corrupting the guardrail history and the audit trail on every advance.
  await test('an advance decision stamps last_evaluated_day like every other decision', async () => {
    const products = [0, 1, 2, 3].map((i) => makeProduct(400 + i, { priceCents: 1000 + i * 100, productIndex: 400 + i }));
    const scenario = await makeScenario(adapter, shop, products, { type: 'percent', percent: 10 });
    await advanceTo(scenario, 0);

    // Backdate the stage entry past its hold and remove guardrails so the only
    // possible decision is a clean advance.
    const day = yesterday(shop.timezone) as DayString;
    scenario.rollout = await adapter.updateRollout(scenario.rollout.id, {
      stage_entered_at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      guardrails: noRules,
    });

    const result = await evaluateRollout(adapter, shop, scenario.rollout, {
      asOfDay: day,
      client: scenario.shopify.asClient(),
      notifier: (async () => undefined) as never,
    });
    assertEqual(result.decision, 'advance', 'precondition: the evaluator advanced the stage');

    const fresh = await adapter.getRollout(scenario.rollout.id);
    assert(fresh !== null, 'rollout still exists');
    assertEqual(
      fresh.last_evaluated_day,
      day,
      'the advance day was never stamped last_evaluated_day — the next tick re-evaluates it under the new stage ' +
        'and upsertRolloutReading overwrites the recorded reading for that day',
    );
  });

  // On a JPY store, Shopify rounds our fractional-yen write; the live price then
  // matches neither the frozen baseline nor the frozen target, so rollback
  // refuses to touch it and the merchant is stuck on a price they never approved.
  await test('rollback restores the original price even after Shopify rounded a zero-decimal write', async () => {
    const jpyShop = await adapter.upsertShop({
      shop_domain: `${uniqueId('jpy')}.myshopify.com`,
      currency: 'JPY',
      timezone: 'Asia/Tokyo',
      mode: 'demo',
    });
    // ¥999, stored as 99900 in the two-decimal money layer.
    const product = makeProduct(700, { priceCents: 99_900, compareAtCents: null, cogsCents: 40_000, productIndex: 700 }, jpyShop.id);
    const scenario = await makeScenario(adapter, jpyShop, [product], { type: 'percent', percent: -5 });

    // A client that behaves like Shopify on a zero-decimal currency: the store
    // keeps (and acknowledges) the price rounded to a whole yen.
    const roundingClient = {
      request: async (query: string, variables: Record<string, unknown> = {}) => {
        if (query.includes('PriceflagVariantsBulkUpdate')) {
          const variants = (variables.variants as { id: string; price: string }[]).map((variant) => ({
            ...variant,
            price: formatCentsAsShopifyMoney(Math.round(parseMoneyToCents(variant.price) / 100) * 100),
          }));
          return scenario.shopify.request(query, { ...variables, variants });
        }
        return scenario.shopify.request(query, variables);
      },
    } as unknown as AdminGraphqlClient;
    const context = { adapter, client: roundingClient, shop: jpyShop };

    const rollout = await adapter.updateRollout(scenario.rollout.id, {
      current_stage: 0,
      stage_entered_at: nowIso(),
    });
    const applied = await applyStage(context, rollout, 0);

    // The frozen target is already a whole yen, so Shopify's rounding changes
    // nothing, the acknowledgement verifies, and the write is recorded as applied.
    assertEqual(applied.applied, 1, 'the zero-decimal target was accepted and acknowledged intact');
    assertEqual(applied.fully_applied, true, 'no variant is left stranded on a price we cannot verify');
    assertExactCents(
      scenario.shopify.priceOf(product.variant_gid),
      94_900,
      'the storefront carries the whole-yen target the merchant approved',
    );

    await rollbackRollout(context, rollout, { reason: 'restore after zero-decimal write' });
    assertExactCents(
      scenario.shopify.priceOf(product.variant_gid),
      99_900,
      'the undo restored ¥999 — a zero-decimal store gets the same one-click revert as everyone else',
    );
  });
}

// ---------------------------------------------------------------------------
// webhook route edges (drives the real route handler)
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'risk-edges-webhook-secret';

function deliver(topic: string, payload: unknown, webhookId: string, shopDomain: string): Promise<Response> {
  const raw = JSON.stringify(payload);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-shopify-topic', topic);
  headers.set('x-shopify-shop-domain', shopDomain);
  headers.set('x-shopify-webhook-id', webhookId);
  headers.set('x-shopify-hmac-sha256', signWebhookBody(raw, WEBHOOK_SECRET));
  const segment = topic.replace(/\//g, '--');
  return webhookPost(
    new NextRequest(
      `http://localhost/api/webhooks/${segment}?pf_topic_token=${encodeURIComponent(
        webhookTopicToken(WEBHOOK_SECRET, topic, shopDomain),
      )}`,
      { method: 'POST', headers, body: raw },
    ),
    { params: Promise.resolve({ topic: segment }) },
  );
}

export async function runRiskEdgeWebhookSuite(): Promise<void> {
  section('risk edges — webhook ordering and rejection');

  const previousSecret = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = WEBHOOK_SECRET;
  const adapter = new DemoAdapter({ persist: false, autoSeed: false });
  setAdapter(adapter);

  const shop = await adapter.upsertShop({
    shop_domain: 'risk-edges.myshopify.com',
    currency: 'USD',
    timezone: 'America/New_York',
    mode: 'demo',
  });
  const product = makeProduct(0, { priceCents: 1000, productIndex: 0 }, shop.id);
  await adapter.upsertProducts(shop.id, [product]);

  try {
    // Shopify delivers webhooks out of order. A stale products/update replayed
    // after a newer one writes yesterday's price back into the catalog, so the
    // next simulation and frozen baseline are built on a price the store no
    // longer charges.
    await test('a stale products/update cannot overwrite a newer price in the catalog', async () => {
      const newer = await deliver(
        'products/update',
        { id: 1000, updated_at: '2026-08-29T12:00:00Z', variants: [{ id: 2000, price: '15.00', compare_at_price: null }] },
        uniqueId('wh-new'),
        shop.shop_domain,
      );
      assertEqual(newer.status, 200, 'precondition: the newer update was accepted');
      const afterNewer = await adapter.getProductsByVariantGids(shop.id, [product.variant_gid]);
      assertExactCents(afterNewer[0]?.price_cents, 1500, 'precondition: the newer price is stored');

      const stale = await deliver(
        'products/update',
        { id: 1000, updated_at: '2026-08-28T12:00:00Z', variants: [{ id: 2000, price: '12.00', compare_at_price: null }] },
        uniqueId('wh-stale'),
        shop.shop_domain,
      );
      assertEqual(stale.status, 200, 'the stale delivery is acknowledged either way');

      const after = await adapter.getProductsByVariantGids(shop.id, [product.variant_gid]);
      assertExactCents(
        after[0]?.price_cents,
        1500,
        'the out-of-order delivery overwrote the newer price — nothing compares updated_at, ' +
          'so forecasts now simulate from a price the store stopped charging',
      );
    });

    // One malformed line item makes the entire order fail forever; once Shopify
    // gives up retrying, that order's real sales silently vanish from the
    // actuals that guardrails judge — undercounting that reads as a drop.
    await test('an order with one zero-quantity line still records its valid lines', async () => {
      const response = await deliver(
        'orders/create',
        {
          id: 42,
          created_at: '2026-08-29T15:00:00Z',
          test: false,
          line_items: [
            { variant_id: 2000, product_id: 1000, quantity: 0, price: '10.00' },
            { variant_id: 2000, product_id: 1000, quantity: 2, price: '10.00' },
          ],
        },
        uniqueId('wh-order'),
        shop.shop_domain,
      );
      assertEqual(
        response.status,
        200,
        'a single zero-quantity line 500s the whole order; after Shopify stops retrying, ' +
          'the valid lines are lost from order_days and the shortfall looks like a demand drop',
      );
    });
  } finally {
    setAdapter(null);
    if (previousSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
    else process.env.SHOPIFY_API_SECRET = previousSecret;
  }
}
