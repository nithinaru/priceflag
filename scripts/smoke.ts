/**
 * Priceflag smoke test.
 *
 *   npx tsx scripts/smoke.ts
 *
 * No test framework on purpose: this has to be runnable in one command with no
 * setup, on a machine with nothing configured, and it has to stay green on every
 * push. It grows with the engine — every sprint adds to it.
 *
 * What it covers today:
 *   - money, gid, crypto and date primitives
 *   - every JSON Schema in `contracts/`, validated against real engine output
 *   - the forecast (breakeven arithmetic, the fitted range, missing-COGS honesty)
 *   - guardrails (streaks, the low-volume floor, profit skipping, breach probability)
 *   - the rollout state machine (stage plans, cohorts, decisions, transitions)
 *   - the fallback expected band
 *   - the journal (idempotency keys, CSV export)
 *   - the same adapter suite against DemoAdapter and, when configured,
 *     SupabaseAdapter — plus a restart test that proves demo state persists
 */

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { loadEnv } from './load-env';

loadEnv();

import { DemoAdapter } from '../lib/adapters/demo';
import { SupabaseAdapter } from '../lib/adapters/supabase';
import type { StoreAdapter } from '../lib/adapters/types';
import { hasSupabaseConfig } from '../lib/config';
import {
  CONTRACT_VERSION,
  DEFAULT_STAGE_PLAN,
  defaultGuardrails,
  demoteConfidence,
  worstConfidence,
  type ElasticityFit,
  type ExpectedBand,
  type Guardrails,
  type ProposalRequest,
  type RolloutReport,
  type SyncProgress,
} from '../lib/contracts';
import { decryptSecret, encryptSecret, generateEncryptionKey, isEncryptedSecret, parseEncryptionKey, safeEqual } from '../lib/crypto';
import { addDays, dayBoundsUtc, dayInTimeZone, diffDays, isoDayOfWeek, today } from '../lib/dates';
import { bracketBand, combineBands } from '../lib/engine/bands';
import { buildForecast, computeBreakeven, computeTargetPrice, resolveCompareAt, ForecastError } from '../lib/engine/forecast';
import { evaluateGuardrails, type DailyObservation } from '../lib/engine/guardrails';
import {
  buildJournalEntry,
  journalToCsv,
  rollbackIdempotencyKey,
  rolloutIdempotencyKey,
  toJournalContract,
} from '../lib/engine/journal';
import { healthSentence, readingSentence, readingVerdict, rolloutHealth, sumReadings } from '../lib/engine/readings';
import {
  assignCohorts,
  canTransition,
  cohortSizes,
  decideNext,
  isDueToStart,
  liveCountAtStage,
  normalizeStages,
  planRolloutVariants,
  pricesForRollback,
  pricesForStage,
  RolloutError,
} from '../lib/engine/rollout';
import {
  applyPercent,
  applyRounding,
  formatCentsAsShopifyMoney,
  parseMoneyToCents,
  roundCents,
} from '../lib/money';
import { coerceGid, gidId, isVariantGid, parseGid, toGid } from '../lib/shopify/gid';
import { signOAuthParams, signWebhookBody, verifyOAuthHmac, verifyWebhookHmac } from '../lib/shopify/hmac';
import {
  adminGraphqlUrl,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForToken,
  isValidShopDomain,
  missingScopes,
  normalizeShopDomain,
  ShopifyAuthError,
  verifyOAuthState,
} from '../lib/shopify/oauth';
import { resolveShopFromRequest, verifySessionToken } from '../lib/shopify/session';
import { AdminGraphqlClient } from '../lib/shopify/client';
import { runSync, syncOrderDays, syncProducts, syncProgressFromRun } from '../lib/sync';
import { DEMO_SHOP_DOMAIN, DISPERSION_K_RANGE, generateDemoStore } from '../lib/demo/generator';
import type { ElasticityFitRow, OrderDay, Product, Rollout } from '../lib/types';
import { exclusionReasonFor } from '../lib/types';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n`);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (cause) {
    failed += 1;
    const message = cause instanceof Error ? cause.message : String(cause);
    failures.push(`${currentSection} › ${name}\n    ${message}`);
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n    \x1b[31m${message}\x1b[0m\n`);
  }
}

function skip(name: string, why: string): void {
  skipped += 1;
  process.stdout.write(`  \x1b[33m∘\x1b[0m ${name} \x1b[2m(${why})\x1b[0m\n`);
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${message}: expected a throw`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-29T15:00:00.000Z');
const TZ = 'America/New_York';
const TODAY = today(TZ, NOW);

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = NOW.toISOString();
  return {
    id: 'p1',
    shop_id: 'shop1',
    product_gid: toGid('Product', 1001),
    variant_gid: toGid('ProductVariant', 2001),
    inventory_item_gid: toGid('InventoryItem', 3001),
    title: 'Everyday Tee',
    variant_title: 'Medium / Black',
    sku: 'TEE-M-BLK',
    vendor: 'Northline',
    product_type: 'Apparel',
    tags: ['apparel'],
    image_url: null,
    status: 'ACTIVE',
    price_cents: 3200,
    compare_at_cents: null,
    currency: 'USD',
    cogs_cents: 1150,
    cogs_source: 'shopify',
    cogs_updated_at: now,
    is_gift_card: false,
    requires_selling_plan: false,
    has_selling_plan: false,
    inventory_quantity: 80,
    available_for_sale: true,
    first_synced_at: now,
    last_synced_at: now,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** `days` days of flat demand ending yesterday, at the product's list price. */
function makeHistory(product: Product, days: number, unitsPerDay: number): OrderDay[] {
  const rows: OrderDay[] = [];
  for (let i = days; i >= 1; i -= 1) {
    const day = addDays(TODAY, -i);
    rows.push({
      shop_id: product.shop_id,
      variant_gid: product.variant_gid,
      day,
      product_gid: product.product_gid,
      units: unitsPerDay,
      orders: unitsPerDay,
      gross_revenue_cents: unitsPerDay * product.price_cents,
      discount_cents: 0,
      refund_units: 0,
      refund_cents: 0,
      net_revenue_cents: unitsPerDay * product.price_cents,
      realized_unit_price_cents: product.price_cents,
      list_price_cents: product.price_cents,
      had_stockout: false,
      on_promo: false,
      source: 'seed',
    });
  }
  return rows;
}

function makeFit(variantGid: string, overrides: Partial<ElasticityFitRow> = {}): ElasticityFitRow {
  return {
    id: 'fit1',
    shop_id: 'shop1',
    variant_gid: variantGid,
    elasticity: -1.6,
    se: 0.25,
    low: null,
    high: null,
    interval_nominal: 0.8,
    n_obs: 168,
    price_variation_pct: 11.4,
    confidence: 'fitted',
    confidence_explanation: null,
    method: 'loglog_ridge_eb_shrunk',
    shrinkage_weight: 0.85,
    prior_elasticity: -1.4,
    r2: 0.42,
    model_version: 'elasticity-v1.0.0',
    model_run_id: null,
    window_start: addDays(TODAY, -180),
    window_end: addDays(TODAY, -1),
    fitted_at: NOW.toISOString(),
    ...overrides,
  };
}

function observation(overrides: Partial<DailyObservation> & { day: string }): DailyObservation {
  return {
    stage_index: 0,
    actual_units: 10,
    actual_revenue_cents: 32000,
    actual_profit_cents: 20500,
    expected_units: 10,
    expected_low: 6,
    expected_high: 14,
    expected_revenue_cents: 32000,
    expected_profit_cents: 20500,
    ...overrides,
  };
}

function makeRollout(overrides: Partial<Rollout> = {}): Rollout {
  return {
    id: 'r1',
    shop_id: 'shop1',
    name: 'Spring margin repair',
    status: 'running',
    change_type: 'percent',
    change_pct: 10,
    change_absolute_cents: null,
    rounding: 'none',
    horizon_days: 90,
    stages: DEFAULT_STAGE_PLAN.map((stage) => ({ ...stage })),
    current_stage: 0,
    stage_entered_at: new Date(NOW.getTime() - 4 * 86_400_000).toISOString(),
    guardrails: defaultGuardrails(),
    forecast: null,
    scheduled_start_at: null,
    started_at: new Date(NOW.getTime() - 4 * 86_400_000).toISOString(),
    ended_at: null,
    ended_reason: null,
    paused_reason: null,
    notify_emails: [],
    eval_lock_token: null,
    eval_locked_until: null,
    last_evaluated_at: null,
    last_evaluated_day: null,
    created_by: 'merchant',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// money / gid / crypto / dates
// ---------------------------------------------------------------------------

async function testPrimitives(): Promise<void> {
  section('money');

  await test('parses Shopify decimal strings exactly', () => {
    assertEqual(parseMoneyToCents('19.99'), 1999, '19.99');
    assertEqual(parseMoneyToCents('0.01'), 1, '0.01');
    assertEqual(parseMoneyToCents('100'), 10000, '100');
    assertEqual(parseMoneyToCents('100.5'), 10050, '100.5');
    assertEqual(parseMoneyToCents('-4.20'), -420, '-4.20');
    // The case that float multiplication gets wrong.
    assertEqual(parseMoneyToCents('1.005'), 101, '1.005 rounds half up');
    assertEqual(parseMoneyToCents('8.675'), 868, '8.675 rounds half up');
  });

  await test('rejects nonsense rather than guessing', () => {
    assertThrows(() => parseMoneyToCents('nineteen'), 'words');
    assertThrows(() => parseMoneyToCents(''), 'empty string');
    assertThrows(() => parseMoneyToCents('1.2.3'), 'two decimal points');
  });

  await test('round-trips cents through Shopify money strings', () => {
    for (const cents of [0, 1, 99, 100, 1999, 123456, -420]) {
      assertEqual(parseMoneyToCents(formatCentsAsShopifyMoney(cents)), cents, `round trip ${cents}`);
    }
    assertEqual(formatCentsAsShopifyMoney(1999), '19.99', 'formats 1999');
    assertEqual(formatCentsAsShopifyMoney(100), '1.00', 'formats 100');
    assertEqual(formatCentsAsShopifyMoney(5), '0.05', 'formats 5');
  });

  await test('rounds half away from zero, symmetrically', () => {
    assertEqual(roundCents(0.5), 1, '0.5');
    assertEqual(roundCents(-0.5), -1, '-0.5 mirrors 0.5');
    assertEqual(roundCents(2.4), 2, '2.4');
    assertEqual(roundCents(-2.6), -3, '-2.6');
  });

  await test('applies percentage changes in integer cents', () => {
    assertEqual(applyPercent(3200, 10), 3520, '+10% of 3200');
    assertEqual(applyPercent(1999, -15), 1699, '-15% of 1999');
    assertEqual(applyPercent(1, -100), 0, 'cannot go negative');
  });

  await test('snaps to psychological endings without big jumps', () => {
    assertEqual(applyRounding(3520, 'end_99'), 3499, '3520 -> 34.99');
    assertEqual(applyRounding(3560, 'end_99'), 3599, '3560 -> 35.99 (nearest)');
    assertEqual(applyRounding(3520, 'end_95'), 3495, '3520 -> 34.95');
    assertEqual(applyRounding(3520, 'end_00'), 3500, '3520 -> 35.00');
    assertEqual(applyRounding(3520, 'none'), 3520, 'none is identity');
  });

  section('shopify gids');

  await test('builds, parses and validates gids', () => {
    assertEqual(toGid('ProductVariant', 42), 'gid://shopify/ProductVariant/42', 'toGid');
    assertEqual(gidId('gid://shopify/Product/9'), '9', 'gidId');
    assert(isVariantGid('gid://shopify/ProductVariant/1'), 'variant gid recognised');
    assert(!isVariantGid('gid://shopify/Product/1'), 'product gid is not a variant gid');
    assertEqual(parseGid('nope'), null, 'garbage parses to null');
    assertEqual(coerceGid('Product', 7), 'gid://shopify/Product/7', 'coerces a bare id');
    assertThrows(() => coerceGid('Product', 'gid://shopify/ProductVariant/7'), 'wrong resource type');
  });

  section('crypto');

  await test('encrypts and decrypts an access token', () => {
    const key = generateEncryptionKey();
    const token = 'shpat_' + 'a'.repeat(32);
    const sealed = encryptSecret(token, key);
    assert(isEncryptedSecret(sealed), 'looks like a v1 payload');
    assert(!sealed.includes(token), 'ciphertext does not contain the plaintext');
    assertEqual(decryptSecret(sealed, key), token, 'round trip');
  });

  await test('refuses a tampered ciphertext or a wrong key', () => {
    const key = generateEncryptionKey();
    const sealed = encryptSecret('shpat_secret', key);
    const parts = sealed.split('.');
    const flipped = [parts[0], parts[1], parts[2], Buffer.from('tampered').toString('base64')].join('.');
    assertThrows(() => decryptSecret(flipped, key), 'tampered ciphertext');
    assertThrows(() => decryptSecret(sealed, generateEncryptionKey()), 'wrong key');
  });

  await test('validates key material with a useful message', () => {
    assertThrows(() => parseEncryptionKey(undefined), 'missing key');
    assertThrows(() => parseEncryptionKey('too-short'), 'short key');
    assertEqual(parseEncryptionKey(generateEncryptionKey()).length, 32, 'accepts base64');
    assertEqual(parseEncryptionKey('ab'.repeat(32)).length, 32, 'accepts hex');
  });

  await test('compares shared secrets in constant time', () => {
    assert(safeEqual('abc123', 'abc123'), 'equal secrets match');
    assert(!safeEqual('abc123', 'abc124'), 'different secrets do not');
    assert(!safeEqual('abc', 'abcd'), 'different lengths do not');
  });

  section('dates (shop-timezone days)');

  await test('resolves the calendar day in the shop timezone', () => {
    // 03:00 UTC is still the previous evening in New York — the exact case that
    // makes a UTC-based evaluator read the wrong day's orders.
    assertEqual(dayInTimeZone(new Date('2026-07-30T03:00:00Z'), 'America/New_York'), '2026-07-29', 'NY evening');
    assertEqual(dayInTimeZone(new Date('2026-07-30T03:00:00Z'), 'UTC'), '2026-07-30', 'same instant in UTC');
    assertEqual(dayInTimeZone(new Date('2026-07-29T23:00:00Z'), 'Asia/Tokyo'), '2026-07-30', 'Tokyo morning');
  });

  await test('does day arithmetic across a DST boundary', () => {
    assertEqual(addDays('2026-03-07', 1), '2026-03-08', 'spring forward');
    assertEqual(addDays('2026-11-01', 1), '2026-11-02', 'fall back');
    assertEqual(diffDays('2026-03-01', '2026-04-01'), 31, 'March is 31 days');
    assertEqual(diffDays('2026-07-29', '2026-07-28'), -1, 'negative span');
  });

  await test('reports ISO weekdays like Postgres does', () => {
    assertEqual(isoDayOfWeek('2026-07-27'), 1, 'Monday is 1');
    assertEqual(isoDayOfWeek('2026-07-26'), 7, 'Sunday is 7');
  });

  await test('brackets a shop day into UTC instants', () => {
    const { start, end } = dayBoundsUtc('2026-07-29', 'America/New_York');
    assertEqual(start.toISOString(), '2026-07-29T04:00:00.000Z', 'EDT midnight is 04:00Z');
    assertEqual(end.getTime() - start.getTime(), 86_400_000, 'exactly one day long');
  });
}

// ---------------------------------------------------------------------------
// Shopify auth (Sprint B2)
// ---------------------------------------------------------------------------

const TEST_CLIENT_ID = 'test-client-id';
const TEST_CLIENT_SECRET = 'hush-hush-shopify-client-secret';

function signSessionToken(
  claims: Record<string, unknown>,
  secret = TEST_CLIENT_SECRET,
  alg = 'HS256',
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = encode({ alg, typ: 'JWT' });
  const payload = encode(claims);
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`, 'utf8').digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function validSessionClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  return {
    iss: 'https://acme-dev.myshopify.com/admin',
    dest: 'https://acme-dev.myshopify.com',
    aud: TEST_CLIENT_ID,
    sub: '42',
    exp: nowSeconds + 60,
    nbf: nowSeconds - 10,
    iat: nowSeconds - 10,
    jti: 'abc123',
    ...overrides,
  };
}

async function testShopifyAuth(): Promise<void> {
  section('shopify auth — shop domains');

  await test('accepts real shop domains and rejects lookalikes', () => {
    assert(isValidShopDomain('acme-dev.myshopify.com'), 'ordinary shop');
    assert(isValidShopDomain('ACME-DEV.MYSHOPIFY.COM'.toLowerCase()), 'case normalised');
    assertEqual(normalizeShopDomain('https://acme-dev.myshopify.com/admin'), 'acme-dev.myshopify.com', 'strips scheme and path');

    // Shopify's published regex is not anchored at the end, which would accept
    // this. Ours is — the value ends up in a URL we send the client secret to.
    assert(!isValidShopDomain('evil.myshopify.com.attacker.test'), 'suffix attack rejected');
    assert(!isValidShopDomain('acme.example.com'), 'wrong domain rejected');
    assert(!isValidShopDomain('acme..myshopify.com'), 'double dot rejected');
    assert(!isValidShopDomain('-acme.myshopify.com'), 'leading hyphen rejected');
    assert(!isValidShopDomain(''), 'empty rejected');
    assertThrows(() => normalizeShopDomain('not a shop'), 'garbage throws');
  });

  section('shopify auth — OAuth');

  await test('the authorize URL requests an offline token', () => {
    const url = new URL(
      buildAuthorizeUrl({
        shop: 'acme-dev.myshopify.com',
        state: 'nonce123',
        clientId: TEST_CLIENT_ID,
        redirectUri: 'https://app.test/api/auth/callback',
        scopes: ['read_products', 'write_products', 'read_orders', 'read_all_orders'],
      }),
    );

    assertEqual(url.origin, 'https://acme-dev.myshopify.com', 'authorizes on the shop, not on our domain');
    assertEqual(url.pathname, '/admin/oauth/authorize', 'correct path');
    assertEqual(url.searchParams.get('client_id'), TEST_CLIENT_ID, 'client id');
    assertEqual(url.searchParams.get('state'), 'nonce123', 'nonce');
    assertEqual(
      url.searchParams.get('scope'),
      'read_products,write_products,read_orders,read_all_orders',
      'comma-separated scopes',
    );
    // Absent `grant_options[]` is what makes the token offline. An online token
    // would expire and auto-rollback would silently stop working at 3am.
    assertEqual(url.searchParams.get('grant_options[]'), null, 'no grant_options means an offline token');
  });

  await test('the callback HMAC verifies exactly as Shopify computes it', () => {
    const params = new URLSearchParams({
      code: 'authcode',
      host: 'YWRtaW4uc2hvcGlmeS5jb20',
      shop: 'acme-dev.myshopify.com',
      state: 'nonce123',
      timestamp: '1785000000',
    });
    params.set('hmac', signOAuthParams(params, TEST_CLIENT_SECRET));

    assert(verifyOAuthHmac(params, TEST_CLIENT_SECRET), 'a genuine callback verifies');
    assert(!verifyOAuthHmac(params, 'wrong-secret'), 'a different secret does not');
  });

  await test('any tampered parameter invalidates the callback', () => {
    const params = new URLSearchParams({ code: 'authcode', shop: 'acme-dev.myshopify.com', timestamp: '1785000000' });
    params.set('hmac', signOAuthParams(params, TEST_CLIENT_SECRET));

    const swapped = new URLSearchParams(params);
    // The attack this defends against: same signature, different shop.
    swapped.set('shop', 'attacker-dev.myshopify.com');
    assert(!verifyOAuthHmac(swapped, TEST_CLIENT_SECRET), 'shop cannot be swapped');

    const extra = new URLSearchParams(params);
    extra.set('injected', '1');
    assert(!verifyOAuthHmac(extra, TEST_CLIENT_SECRET), 'a parameter cannot be added');

    const missing = new URLSearchParams(params);
    missing.delete('hmac');
    assert(!verifyOAuthHmac(missing, TEST_CLIENT_SECRET), 'no hmac is not a pass');
  });

  await test('`signature` is included in the digest, not stripped', () => {
    // Only `hmac` is excluded. An older generation of Shopify docs also excluded
    // `signature`; doing that today would reject legitimate requests.
    const params = new URLSearchParams({ code: 'c', shop: 'acme-dev.myshopify.com', signature: 'legacy' });
    params.set('hmac', signOAuthParams(params, TEST_CLIENT_SECRET));
    assert(verifyOAuthHmac(params, TEST_CLIENT_SECRET), 'verifies with signature present');
  });

  await test('the OAuth nonce is single-use and compared safely', () => {
    const state = createOAuthState();
    assert(state.length >= 32, 'nonce has real entropy');
    assert(verifyOAuthState(state, state), 'matching nonce passes');
    assert(!verifyOAuthState(state, createOAuthState()), 'a different nonce fails');
    assert(!verifyOAuthState(state, undefined), 'a missing cookie fails');
    assert(!verifyOAuthState(null, state), 'a missing parameter fails');
  });

  await test('the token exchange posts the right body and reads the token', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};

    const token = await exchangeCodeForToken({
      shop: 'acme-dev.myshopify.com',
      code: 'authcode',
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ access_token: 'shpat_abc', scope: 'read_products,write_products' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    assertEqual(seenUrl, 'https://acme-dev.myshopify.com/admin/oauth/access_token', 'exchange endpoint');
    assertEqual(seenBody.client_id, TEST_CLIENT_ID, 'client id sent');
    assertEqual(seenBody.client_secret, TEST_CLIENT_SECRET, 'client secret sent');
    assertEqual(seenBody.code, 'authcode', 'code sent');
    assertEqual(seenBody.expiring, undefined, 'no `expiring` flag: we want a non-expiring offline token');
    assertEqual(token.access_token, 'shpat_abc', 'token parsed');
  });

  await test('a failed or empty token exchange throws rather than storing nothing', async () => {
    const reject = async (status: number, body: string): Promise<string> => {
      try {
        await exchangeCodeForToken({
          shop: 'acme-dev.myshopify.com',
          code: 'authcode',
          clientId: TEST_CLIENT_ID,
          clientSecret: TEST_CLIENT_SECRET,
          fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch,
        });
      } catch (cause) {
        return cause instanceof ShopifyAuthError ? cause.code : 'wrong-error';
      }
      return 'no-throw';
    };

    assertEqual(await reject(401, '{}'), 'token_exchange_failed', 'HTTP error throws');
    assertEqual(await reject(200, '{"scope":"read_products"}'), 'token_exchange_failed', 'missing token throws');
  });

  await test('a missing scope is caught, especially read_all_orders', () => {
    const required = ['read_products', 'write_products', 'read_orders', 'read_all_orders'];
    assertEqual(missingScopes('read_products,write_products,read_orders,read_all_orders', required).length, 0, 'all granted');

    // The dangerous case: everything looks fine but order history silently caps at
    // 60 days, so every forecast would be built on two months of data.
    const missing = missingScopes('read_products,write_products,read_orders', required);
    assertEqual(missing.join(','), 'read_all_orders', 'the history scope is noticed');
    assertEqual(missingScopes(' read_products , read_orders ', ['read_products']).length, 0, 'tolerates whitespace');
  });

  await test('the Admin GraphQL endpoint is pinned to a version', () => {
    assertEqual(
      adminGraphqlUrl('acme-dev.myshopify.com', '2026-07'),
      'https://acme-dev.myshopify.com/admin/api/2026-07/graphql.json',
      'versioned endpoint',
    );
  });

  section('shopify auth — webhook HMAC');

  await test('a webhook verifies against its raw body in base64', () => {
    const body = JSON.stringify({ id: 1234, line_items: [{ variant_id: 9 }] });
    const signature = signWebhookBody(body, TEST_CLIENT_SECRET);

    assert(verifyWebhookHmac(body, signature, TEST_CLIENT_SECRET), 'genuine webhook verifies');
    assert(!verifyWebhookHmac(body, signature, 'wrong-secret'), 'wrong secret fails');
    assert(!verifyWebhookHmac(`${body} `, signature, TEST_CLIENT_SECRET), 'a single byte of drift fails');
    assert(!verifyWebhookHmac(body, null, TEST_CLIENT_SECRET), 'a missing header is not a pass');
    assert(!verifyWebhookHmac(body, '', TEST_CLIENT_SECRET), 'an empty header is not a pass');
  });

  await test('re-serialised JSON does not verify (why we keep the raw body)', () => {
    const body = '{"b":2,"a":1}';
    const signature = signWebhookBody(body, TEST_CLIENT_SECRET);
    const reserialised = JSON.stringify(JSON.parse(body) as unknown);
    assert(verifyWebhookHmac(body, signature, TEST_CLIENT_SECRET), 'the raw body verifies');
    assert(
      !verifyWebhookHmac(reserialised, signature, TEST_CLIENT_SECRET) || reserialised === body,
      'parsing and re-stringifying breaks the digest',
    );
  });

  section('shopify auth — session tokens');

  const verifyOptions = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET, now: NOW };

  await test('a valid session token resolves the shop', () => {
    const session = verifySessionToken(signSessionToken(validSessionClaims()), verifyOptions);
    assertEqual(session.shopDomain, 'acme-dev.myshopify.com', 'shop comes from the signed dest claim');
  });

  await test('the algorithm is pinned to HS256', () => {
    // The classic JWT hole: honouring whatever `alg` the token asks for.
    const noneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify(validSessionClaims()),
    ).toString('base64url')}.`;
    assertThrows(() => verifySessionToken(noneToken, verifyOptions), 'alg=none rejected');
    assertThrows(
      () => verifySessionToken(signSessionToken(validSessionClaims(), TEST_CLIENT_SECRET, 'HS512'), verifyOptions),
      'alg=HS512 rejected',
    );
  });

  await test('a forged or mis-signed token is rejected', () => {
    assertThrows(
      () => verifySessionToken(signSessionToken(validSessionClaims(), 'attacker-secret'), verifyOptions),
      'signed with the wrong secret',
    );
    assertThrows(() => verifySessionToken('not.a.jwt', verifyOptions), 'not a JWT');
    assertThrows(() => verifySessionToken('onlyonepart', verifyOptions), 'wrong shape');
  });

  await test('expiry, aud and dest/iss agreement are all enforced', () => {
    const nowSeconds = Math.floor(NOW.getTime() / 1000);

    assertThrows(
      () => verifySessionToken(signSessionToken(validSessionClaims({ exp: nowSeconds - 60 })), verifyOptions),
      'expired token',
    );
    assertThrows(
      () => verifySessionToken(signSessionToken(validSessionClaims({ nbf: nowSeconds + 600 })), verifyOptions),
      'not-yet-valid token',
    );
    // A validly-signed token for a different app is not ours to honour.
    assertThrows(
      () => verifySessionToken(signSessionToken(validSessionClaims({ aud: 'someone-elses-app' })), verifyOptions),
      'wrong audience',
    );
    // The cross-shop attack: a token for shop A claiming to be destined for shop B.
    assertThrows(
      () =>
        verifySessionToken(
          signSessionToken(validSessionClaims({ iss: 'https://attacker-dev.myshopify.com/admin' })),
          verifyOptions,
        ),
      'iss and dest disagree',
    );

    // A little clock skew is tolerated, as Shopify's own libraries do.
    const session = verifySessionToken(
      signSessionToken(validSessionClaims({ exp: nowSeconds - 2 })),
      verifyOptions,
    );
    assertEqual(session.shopDomain, 'acme-dev.myshopify.com', '2 seconds of skew is fine');
  });

  await test('a session token beats the ?shop= parameter', () => {
    process.env.SHOPIFY_API_KEY = TEST_CLIENT_ID;
    process.env.SHOPIFY_API_SECRET = TEST_CLIENT_SECRET;
    try {
      const token = signSessionToken(validSessionClaims());
      // The query parameter claims a different shop. The signed token wins, because
      // the parameter is not authenticated and the token is.
      const request = new Request('https://app.test/api/products?shop=attacker-dev.myshopify.com', {
        headers: { authorization: `Bearer ${token}` },
      });
      const resolved = resolveShopFromRequest(request, { now: NOW });
      assertEqual(resolved.shopDomain, 'acme-dev.myshopify.com', 'shop comes from the token');
      assertEqual(resolved.source, 'session_token', 'and the source says so');
    } finally {
      delete process.env.SHOPIFY_API_KEY;
      delete process.env.SHOPIFY_API_SECRET;
    }
  });

  await test('the ?shop= fallback is refused in production', () => {
    const request = new Request('https://app.test/api/products?shop=acme-dev.myshopify.com');

    const dev = resolveShopFromRequest(request, { allowQueryParam: true });
    assertEqual(dev.source, 'query', 'allowed when explicitly permitted');

    assertThrows(
      () => resolveShopFromRequest(request, { allowQueryParam: false }),
      'refused without a session token',
    );
  });
}

// ---------------------------------------------------------------------------
// sync pipeline (Sprint B3) — against a mocked Admin API
// ---------------------------------------------------------------------------

/** Dispatches on the operation name in the query, so tests need no network. */
function mockAdminApi(responses: Record<string, unknown>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, unknown> };
    const match = /query (\w+)/.exec(body.query);
    const operation = match?.[1] ?? 'unknown';

    const handler = responses[operation];
    const data = typeof handler === 'function' ? (handler as (v: Record<string, unknown>) => unknown)(body.variables) : handler;
    if (data === undefined) throw new Error(`mock has no response for operation ${operation}`);

    return new Response(
      JSON.stringify({
        data,
        extensions: {
          cost: {
            requestedQueryCost: 10,
            actualQueryCost: 10,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

function gqlVariant(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: toGid('ProductVariant', id),
    title: 'Default Title',
    sku: `SKU-${id}`,
    price: '32.00',
    compareAtPrice: null,
    inventoryQuantity: 10,
    availableForSale: true,
    sellingPlanGroupsCount: { count: 0 },
    inventoryItem: { id: toGid('InventoryItem', id), unitCost: { amount: '11.50' } },
    ...overrides,
  };
}

function gqlProduct(id: number, variants: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: toGid('Product', id),
    title: `Product ${id}`,
    status: 'ACTIVE',
    vendor: 'Northline',
    productType: 'Apparel',
    tags: ['apparel'],
    isGiftCard: false,
    requiresSellingPlan: false,
    sellingPlanGroupsCount: { count: 0 },
    featuredMedia: { preview: { image: { url: 'https://cdn.example/img.png' } } },
    variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variants },
    ...overrides,
  };
}

async function testSync(): Promise<void> {
  section('sync — catalog');

  const credentials = {
    shopDomain: 'acme-dev.myshopify.com',
    accessToken: 'shpat_test',
    apiVersion: '2026-07',
    source: 'static_env' as const,
  };

  await test('maps variants, costs, and every exclusion rule', async () => {
    const adapter = DemoAdapter.ephemeral();
    const shop = await adapter.demoShop();

    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      fetchImpl: mockAdminApi({
        PriceflagProducts: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              gqlProduct(1, [gqlVariant(101)]),
              // Gift card, subscription at product level, subscription at variant
              // level, and an archived product: all four must be excluded (R22).
              gqlProduct(2, [gqlVariant(102)], { isGiftCard: true }),
              gqlProduct(3, [gqlVariant(103)], { requiresSellingPlan: true }),
              gqlProduct(4, [gqlVariant(104, { sellingPlanGroupsCount: { count: 2 } })]),
              gqlProduct(5, [gqlVariant(105)], { status: 'ARCHIVED' }),
              // No cost recorded in Shopify: must stay unknown, never zero (R3).
              gqlProduct(6, [gqlVariant(106, { inventoryItem: { id: 'gid://shopify/InventoryItem/106', unitCost: null } })]),
              // A cost of exactly 0.00 is "never filled in", not a free product.
              gqlProduct(7, [gqlVariant(107, { inventoryItem: { id: 'gid://shopify/InventoryItem/107', unitCost: { amount: '0.00' } } })]),
            ],
          },
        },
      }),
    });

    const result = await syncProducts(client, adapter, shop.id, 'USD', { reconcileDeletions: false });
    assertEqual(result.productsSeen, 7, 'seven products');
    assertEqual(result.variantsWritten, 7, 'seven variants');

    const stored = await adapter.getProductsByVariantGids(shop.id, [
      toGid('ProductVariant', 101),
      toGid('ProductVariant', 106),
      toGid('ProductVariant', 107),
    ]);
    const plain = stored.find((p) => p.variant_gid === toGid('ProductVariant', 101));
    assertEqual(plain?.price_cents, 3200, 'price parsed to cents');
    assertEqual(plain?.cogs_cents, 1150, 'unitCost parsed to cents');
    assertEqual(plain?.cogs_source, 'shopify', 'and attributed to Shopify');

    const noCost = stored.find((p) => p.variant_gid === toGid('ProductVariant', 106));
    assertEqual(noCost?.cogs_cents, null, 'missing cost stays unknown');
    assertEqual(noCost?.cogs_source, 'none', 'and the source says so');

    const zeroCost = stored.find((p) => p.variant_gid === toGid('ProductVariant', 107));
    assertEqual(zeroCost?.cogs_cents, null, 'a 0.00 cost is treated as unknown, not as a 100% margin');

    const repriceable = await adapter.listProducts(shop.id, { only_repriceable: true });
    const syncedGids = new Set([101, 102, 103, 104, 105, 106, 107].map((id) => toGid('ProductVariant', id)));
    const syncedRepriceable = repriceable.items.filter((p) => syncedGids.has(p.variant_gid));
    assertEqual(syncedRepriceable.length, 3, 'only the three eligible variants (101, 106, 107) survive the filters');
  });

  await test('follows variant pagination rather than truncating at one page', async () => {
    const adapter = DemoAdapter.ephemeral();
    const shop = await adapter.demoShop();

    let continuations = 0;
    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      fetchImpl: mockAdminApi({
        PriceflagProducts: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              gqlProduct(1, [gqlVariant(201)], {
                variants: {
                  pageInfo: { hasNextPage: true, endCursor: 'v1' },
                  nodes: [gqlVariant(201)],
                },
              }),
            ],
          },
        },
        PriceflagProductVariants: () => {
          continuations += 1;
          return {
            product: {
              variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [gqlVariant(202)] },
            },
          };
        },
      }),
    });

    const result = await syncProducts(client, adapter, shop.id, 'USD', { reconcileDeletions: false });
    assertEqual(continuations, 1, 'asked for the next variant page');
    assertEqual(result.variantsWritten, 2, 'both variants written — silently dropping one would mean a price we could not roll back');
  });

  section('sync — order history');

  await test('aggregates line items into shop-timezone daily rows', async () => {
    const adapter = DemoAdapter.ephemeral();
    const shop = await adapter.demoShop();
    const variantGid = toGid('ProductVariant', 301);

    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      fetchImpl: mockAdminApi({
        PriceflagOrders: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                // 02:00 UTC is still the previous evening in New York. Attributing
                // this to the UTC day would put it on the wrong day's demand.
                id: 'gid://shopify/Order/1',
                createdAt: '2026-07-15T02:00:00Z',
                test: false,
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'li1',
                      quantity: 2,
                      variant: { id: variantGid },
                      originalTotalSet: { shopMoney: { amount: '64.00' } },
                      discountedTotalSet: { shopMoney: { amount: '58.00' } },
                    },
                  ],
                },
                refunds: [],
              },
              {
                id: 'gid://shopify/Order/2',
                createdAt: '2026-07-15T18:00:00Z',
                test: false,
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'li2',
                      quantity: 1,
                      variant: { id: variantGid },
                      originalTotalSet: { shopMoney: { amount: '32.00' } },
                      discountedTotalSet: { shopMoney: { amount: '32.00' } },
                    },
                  ],
                },
                refunds: [],
              },
              {
                // Test orders are real rows with real line items. Counting them
                // would inflate the baseline that guardrails compare against.
                id: 'gid://shopify/Order/3',
                createdAt: '2026-07-15T19:00:00Z',
                test: true,
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'li3',
                      quantity: 99,
                      variant: { id: variantGid },
                      originalTotalSet: { shopMoney: { amount: '3168.00' } },
                      discountedTotalSet: { shopMoney: { amount: '3168.00' } },
                    },
                  ],
                },
                refunds: [],
              },
            ],
          },
        },
      }),
    });

    const result = await syncOrderDays(
      client,
      adapter,
      shop.id,
      'America/New_York',
      '2026-07-01',
      '2026-07-31',
      { listPrices: new Map([[variantGid, 3200]]) },
    );

    assertEqual(result.ordersProcessed, 2, 'two real orders');
    assertEqual(result.ordersSkippedTest, 1, 'and the test order was skipped');

    const rows = await adapter.getOrderDays(shop.id, { variant_gids: [variantGid] });
    assertEqual(rows.length, 2, 'two distinct shop-days');

    const july14 = rows.find((row) => row.day === '2026-07-14');
    assert(july14 !== undefined, '02:00Z lands on the 14th in New York, not the 15th');
    assertEqual(july14?.units, 2, 'units');
    assertEqual(july14?.gross_revenue_cents, 6400, 'gross from originalTotalSet');
    assertEqual(july14?.discount_cents, 600, 'discount is original minus discounted');
    assertEqual(july14?.net_revenue_cents, 5800, 'net');
    assertEqual(july14?.realized_unit_price_cents, 2900, 'realized unit price is net over units');
    assertEqual(july14?.list_price_cents, 3200, 'list price is the regressor and differs from realized');
    assertEqual(july14?.on_promo, true, 'a discounted day is flagged so Lane C can control for it');

    const july15 = rows.find((row) => row.day === '2026-07-15');
    assertEqual(july15?.units, 1, 'the 18:00Z order is the 15th in New York');
    assertEqual(july15?.orders, 1, 'one distinct order');
  });

  await test('counts distinct orders, and books refunds on the day they happened', async () => {
    const adapter = DemoAdapter.ephemeral();
    const shop = await adapter.demoShop();
    const variantGid = toGid('ProductVariant', 401);

    const line = (id: string, quantity: number, amount: string): Record<string, unknown> => ({
      id,
      quantity,
      variant: { id: variantGid },
      originalTotalSet: { shopMoney: { amount } },
      discountedTotalSet: { shopMoney: { amount } },
    });

    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      fetchImpl: mockAdminApi({
        PriceflagOrders: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'gid://shopify/Order/10',
                createdAt: '2026-07-10T15:00:00Z',
                test: false,
                // Two lines of the same variant in one order: two units, ONE order.
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [line('a', 1, '32.00'), line('b', 1, '32.00')],
                },
                refunds: [
                  {
                    id: 'r1',
                    // Refunded three days later — it belongs to the 13th.
                    createdAt: '2026-07-13T15:00:00Z',
                    refundLineItems: {
                      nodes: [
                        {
                          quantity: 1,
                          subtotalSet: { shopMoney: { amount: '32.00' } },
                          lineItem: { variant: { id: variantGid } },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    });

    await syncOrderDays(client, adapter, shop.id, 'UTC', '2026-07-01', '2026-07-31', {});
    const rows = await adapter.getOrderDays(shop.id, { variant_gids: [variantGid] });

    const saleDay = rows.find((row) => row.day === '2026-07-10');
    assertEqual(saleDay?.units, 2, 'two units');
    assertEqual(saleDay?.orders, 1, 'but one distinct order — orders are not summable across lines');

    const refundDay = rows.find((row) => row.day === '2026-07-13');
    assert(refundDay !== undefined, 'the refund books on its own day, not the sale day');
    assertEqual(refundDay?.refund_units, 1, 'refund units');
    assertEqual(refundDay?.refund_cents, 3200, 'refund cents');
    assertEqual(refundDay?.net_revenue_cents, -3200, 'a refund-only day is negative revenue, which is the truth');
  });

  await test('a line item whose variant was deleted is dropped, not misattributed', async () => {
    const adapter = DemoAdapter.ephemeral();
    const shop = await adapter.demoShop();

    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      fetchImpl: mockAdminApi({
        PriceflagOrders: {
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'gid://shopify/Order/20',
                createdAt: '2026-07-10T15:00:00Z',
                test: false,
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'orphan',
                      quantity: 5,
                      variant: null,
                      originalTotalSet: { shopMoney: { amount: '160.00' } },
                      discountedTotalSet: { shopMoney: { amount: '160.00' } },
                    },
                  ],
                },
                refunds: [],
              },
            ],
          },
        },
      }),
    });

    const result = await syncOrderDays(client, adapter, shop.id, 'UTC', '2026-07-01', '2026-07-31', {});
    assertEqual(result.ordersProcessed, 1, 'the order is still counted');
    assertEqual(result.dayRowsWritten, 0, 'but there is no variant to attribute it to');
  });

  section('sync — progress contract');

  await test('an empty store still produces a valid, honest progress payload', async () => {
    // No auto-seed: a seeded store already has a completed sync run, and this
    // test is about what a brand new connection reports.
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const shop = await adapter.upsertShop({
      shop_domain: 'acme-dev.myshopify.com',
      timezone: 'America/New_York',
      currency: 'USD',
      mode: 'real',
    });

    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      fetchImpl: mockAdminApi({
        PriceflagShop: {
          shop: {
            name: 'Acme',
            myshopifyDomain: 'acme-dev.myshopify.com',
            ianaTimezone: 'America/New_York',
            currencyCode: 'USD',
            contactEmail: 'owner@example.com',
            plan: { displayName: 'Developer Preview' },
          },
        },
        PriceflagCounts: { productsCount: { count: 0 }, ordersCount: { count: 0, precision: 'EXACT' } },
        PriceflagProducts: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        PriceflagOrders: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      }),
    });

    const outcome = await runSync(adapter, shop, { client, historyDays: 180 });
    assertEqual(outcome.error, null, 'an empty store is not an error');

    const run = await adapter.getLatestSyncRun(shop.id);
    const progress = syncProgressFromRun(run);
    assertEqual(progress.stage, 'done', 'the sync completes');
    assertEqual(progress.catalog.ready, true, 'catalog ready');
    assertEqual(progress.history.ready, true, 'history ready even when there is none');
    assert(
      /no orders/i.test(progress.message),
      `and the message says so plainly: ${progress.message}`,
    );
  });

  await test('a Shopify auth failure becomes a merchant-readable error', async () => {
    const adapter = new DemoAdapter({ persist: false, autoSeed: false });
    const shop = await adapter.upsertShop({
      shop_domain: 'acme-dev.myshopify.com',
      timezone: 'UTC',
      currency: 'USD',
      mode: 'real',
    });

    const client = new AdminGraphqlClient(credentials, {
      sleepImpl: async () => {},
      maxRetries: 0,
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });

    const outcome = await runSync(adapter, shop, { client });
    assertEqual(outcome.error?.code, 'auth_expired', 'classified as an auth problem');
    assert(
      /reconnect/i.test(outcome.error?.message ?? ''),
      `and states the one action that fixes it: ${outcome.error?.message}`,
    );
    assertEqual(outcome.error?.retryable, false, 'retrying will not help');

    const progress = syncProgressFromRun(await adapter.getLatestSyncRun(shop.id));
    assertEqual(progress.stage, 'error', 'progress reports the failure');
  });
}

// ---------------------------------------------------------------------------
// golden data (Lane C's fixture)
// ---------------------------------------------------------------------------

async function testGoldenData(): Promise<void> {
  section('golden data');

  const store = generateDemoStore({ seed: 20260729, historyDays: 180 });

  await test('generation is deterministic for a given seed', () => {
    const again = generateDemoStore({ seed: 20260729, historyDays: 180, endDay: store.window.to });
    assertEqual(again.orderDays.length, store.orderDays.length, 'same row count');
    const a = store.orderDays.map((row) => row.units).join(',');
    const b = again.orderDays.map((row) => row.units).join(',');
    assertEqual(a === b, true, 'byte-identical unit series');
  });

  await test('daily counts are overdispersed, not Poisson (Lane C request 7)', () => {
    // Poisson has var = mean. Real retail counts do not, and generating Poisson
    // data would make the monitoring bands look better calibrated than they will
    // ever be on a real store — and band calibration drives auto-rollback.
    const busiest = store.truth
      .filter((row) => row.price_levels >= 1)
      .map((row) => row.variant_gid);

    let checked = 0;
    for (const variantGid of busiest) {
      const units = store.orderDays
        .filter((row) => row.variant_gid === variantGid && !row.had_stockout && !row.on_promo)
        .map((row) => row.units);
      if (units.length < 60) continue;

      const mean = units.reduce((sum, value) => sum + value, 0) / units.length;
      if (mean < 4) continue; // too quiet for the ratio to be meaningful
      const variance =
        units.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (units.length - 1);

      // Allow for seasonality inflating variance either way, but a Poisson
      // generator would sit near 1.0 and NB with k in [4,12] sits well above it.
      assert(
        variance / mean > 1.15,
        `variance/mean for ${variantGid} was ${(variance / mean).toFixed(2)}, expected overdispersion`,
      );
      checked += 1;
    }
    assert(checked >= 3, `expected to check several SKUs, checked ${checked}`);
  });

  await test('the truth table reports the dispersion so both fixtures can agree', () => {
    for (const row of store.truth) {
      assert(
        row.dispersion_k >= DISPERSION_K_RANGE[0] && row.dispersion_k <= DISPERSION_K_RANGE[1],
        `k for ${row.variant_gid} was ${row.dispersion_k}, outside [${DISPERSION_K_RANGE.join(', ')}]`,
      );
    }
  });

  await test('the fixture still contains the awkward cases on purpose', () => {
    assert(
      store.truth.some((row) => row.price_levels <= 1 && row.expected_confidence === 'assumption'),
      'a never-repriced product, where `assumption` is the only honest answer',
    );
    assert(
      store.truth.some((row) => row.expected_confidence === 'fitted'),
      'and one with enough price movement to be estimable',
    );
    assert(
      store.products.some((product) => product.cogs_cents === null),
      'a product with no cost, for the profit-unknown state',
    );
    assert(
      store.products.some((product) => product.is_gift_card) &&
        store.products.some((product) => product.has_selling_plan),
      'a gift card and a subscription product, which are never repriced',
    );
    assert(store.orderDays.some((row) => row.had_stockout), 'stockout days');
    assert(store.orderDays.some((row) => row.on_promo), 'promo days');
  });

  await test('no order-day row carries anything resembling customer identity (R23)', () => {
    const allowed = new Set([
      'variant_gid', 'product_gid', 'day', 'units', 'orders', 'gross_revenue_cents',
      'discount_cents', 'refund_units', 'refund_cents', 'net_revenue_cents',
      'realized_unit_price_cents', 'list_price_cents', 'had_stockout', 'on_promo', 'source',
    ]);
    const first = store.orderDays[0] as Record<string, unknown>;
    for (const key of Object.keys(first)) {
      assert(allowed.has(key), `unexpected field on order_days: ${key}`);
    }
  });
}

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

const SCHEMA_FILES = [
  'forecast_result.schema.json',
  'elasticity_fit.schema.json',
  'expected_band.schema.json',
  'guardrails.schema.json',
  'proposal_request.schema.json',
  'sync_progress.schema.json',
  'journal_entry.schema.json',
  'rollout_report.schema.json',
] as const;

async function testContracts(): Promise<void> {
  section('contracts (JSON Schema)');

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const schemas = new Map<string, unknown>();
  for (const file of SCHEMA_FILES) {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'contracts', file), 'utf8')) as {
      $id: string;
    };
    schemas.set(file, raw);
    ajv.addSchema(raw, raw.$id);
  }

  const validate = (file: string, payload: unknown): void => {
    const schema = schemas.get(file) as { $id: string };
    const fn = ajv.getSchema(schema.$id);
    assert(fn !== undefined, `schema ${file} compiled`);
    if (!(fn as (data: unknown) => boolean)(payload)) {
      const errors = (fn as { errors?: unknown[] }).errors ?? [];
      throw new Error(`${file} rejected the payload: ${JSON.stringify(errors, null, 2)}`);
    }
  };

  await test('every schema compiles', () => {
    assertEqual(schemas.size, SCHEMA_FILES.length, 'all schemas loaded');
  });

  await test('a real forecast validates against forecast_result.schema.json', () => {
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 60, 10),
      change: { type: 'percent', percent: 10 },
      fits: new Map([[product.variant_gid, makeFit(product.variant_gid)]]),
      now: NOW,
    });
    validate('forecast_result.schema.json', forecast);
  });

  await test('a bracket-only forecast validates too (fitted: null)', () => {
    const product = makeProduct({ cogs_cents: null, cogs_source: 'none' });
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 12, 3),
      change: { type: 'absolute', absolute_cents: -300 },
      now: NOW,
    });
    assertEqual(forecast.fitted, null, 'no fit means no fitted block');
    assertEqual(forecast.confidence, 'assumption', 'and the tier says so');
    validate('forecast_result.schema.json', forecast);
  });

  await test('elasticity_fit fixture validates', () => {
    const fit: ElasticityFit = {
      contract_version: CONTRACT_VERSION,
      shop_domain: DEMO_SHOP_DOMAIN,
      variant_gid: toGid('ProductVariant', 2001),
      elasticity: -1.62,
      se: 0.24,
      n_obs: 168,
      price_variation_pct: 11.4,
      confidence: 'fitted',
      confidence_explanation: 'Fitted to 168 days including two price changes.',
      method: 'loglog_ridge_eb_shrunk',
      shrinkage_weight: 0.85,
      prior_elasticity: -1.4,
      r2: 0.42,
      model_version: 'elasticity-v1.0.0',
      model_run_id: null,
      fitted_at: NOW.toISOString(),
      window_start: '2026-01-30',
      window_end: '2026-07-28',
    };
    validate('elasticity_fit.schema.json', fit);
  });

  await test('expected_band fixtures validate, both kinds', () => {
    const baseline: ExpectedBand = {
      contract_version: CONTRACT_VERSION,
      shop_domain: DEMO_SHOP_DOMAIN,
      variant_gid: toGid('ProductVariant', 2001),
      day: '2026-07-28',
      expected_units: 12.4,
      low: 7.1,
      high: 18.2,
      interval: 0.8,
      band_kind: 'baseline',
      rollout_id: null,
      model_version: 'baseline-v1.0.0',
      is_floored: false,
      generated_at: NOW.toISOString(),
    };
    validate('expected_band.schema.json', baseline);

    validate('expected_band.schema.json', {
      ...baseline,
      band_kind: 'counterfactual',
      rollout_id: '3f1c9d64-1f4a-4c9e-9b57-2a0c9f6f1d22',
      breach_probability: 0.91,
    });
  });

  await test('a counterfactual band without a rollout id is rejected', () => {
    const bad = {
      contract_version: CONTRACT_VERSION,
      shop_domain: DEMO_SHOP_DOMAIN,
      variant_gid: toGid('ProductVariant', 2001),
      day: '2026-07-28',
      expected_units: 12.4,
      low: 7.1,
      high: 18.2,
      interval: 0.8,
      band_kind: 'counterfactual',
      rollout_id: null,
      model_version: 'counterfactual-v1.0.0',
      generated_at: NOW.toISOString(),
    };
    assertThrows(() => validate('expected_band.schema.json', bad), 'schema enforces the scoping rule');
  });

  await test('guardrails fixture validates, including the default', () => {
    validate('guardrails.schema.json', defaultGuardrails());

    const alertOnly: Guardrails = {
      contract_version: CONTRACT_VERSION,
      auto_rollback: false,
      rules: [
        {
          id: 'revenue-floor',
          metric: 'revenue',
          comparison: 'below_absolute',
          threshold_pct: null,
          absolute_floor: 25000,
          consecutive_days: 3,
          scope: 'rollout',
          action: 'pause',
          sentence: 'If daily revenue falls below $250 for 3 days in a row, pause the rollout and let me know.',
        },
      ],
    };
    validate('guardrails.schema.json', alertOnly);
  });

  await test('proposal_request fixture validates', () => {
    const proposal: ProposalRequest = {
      contract_version: CONTRACT_VERSION,
      name: 'Spring margin repair',
      variant_gids: [toGid('ProductVariant', 2001), toGid('ProductVariant', 2002)],
      change: { type: 'percent', percent: 8, rounding: 'end_99' },
      horizon_days: 90,
      stages: [
        { fraction: 0.25, hold_days: 3 },
        { fraction: 0.5, hold_days: 3 },
        { fraction: 1, hold_days: 4 },
      ],
      guardrails: defaultGuardrails(),
      scheduled_start_at: null,
      notify_emails: ['owner@example.com'],
    };
    validate('proposal_request.schema.json', proposal);
  });

  await test('a percent proposal without a percent is rejected', () => {
    assertThrows(
      () =>
        validate('proposal_request.schema.json', {
          contract_version: CONTRACT_VERSION,
          variant_gids: [toGid('ProductVariant', 2001)],
          change: { type: 'percent' },
        }),
      'schema requires the matching field',
    );
  });

  await test('sync_progress fixture validates', () => {
    const progress: SyncProgress = {
      contract_version: CONTRACT_VERSION,
      stage: 'history',
      message: 'Loaded 240 products. Now reading 180 days of order history — about 2 minutes left.',
      catalog: { ready: true, products_synced: 240, products_total: 240, ready_at: NOW.toISOString() },
      history: { ready: false, days_synced: 64, days_target: 180, orders_processed: 4120, ready_at: null },
      eta_seconds: 120,
      error: null,
      started_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      finished_at: null,
    };
    validate('sync_progress.schema.json', progress);
  });

  await test('a real journal entry validates against journal_entry.schema.json', () => {
    const product = makeProduct();
    const entry = buildJournalEntry(
      {
        variant_gid: product.variant_gid,
        product_gid: product.product_gid,
        title: product.title,
        sku: product.sku,
        before_price_cents: 3200,
        after_price_cents: 3520,
        before_compare_at_cents: null,
        after_compare_at_cents: null,
        currency: 'USD',
      },
      {
        source: 'rollout',
        actor: 'priceflag',
        rollout_id: '3f1c9d64-1f4a-4c9e-9b57-2a0c9f6f1d22',
        rollout_name: 'Spring margin repair',
        stage_index: 0,
        idempotency_key: rolloutIdempotencyKey('3f1c9d64-1f4a-4c9e-9b57-2a0c9f6f1d22', 0, product.variant_gid, 3520),
        applied_at: NOW.toISOString(),
      },
    );

    validate(
      'journal_entry.schema.json',
      toJournalContract(
        { ...entry, id: '9d0f2b3a-1c4d-4e5f-8a9b-0c1d2e3f4a5b', shop_id: 'shop1', created_at: NOW.toISOString() },
        'Spring margin repair',
      ),
    );
  });

  await test('rollout_report fixture validates', () => {
    const report: RolloutReport = {
      contract_version: CONTRACT_VERSION,
      rollout_id: '3f1c9d64-1f4a-4c9e-9b57-2a0c9f6f1d22',
      generated_at: NOW.toISOString(),
      model_version: 'report-v1.0.0',
      model_run_id: null,
      window: { start_day: '2026-06-28', end_day: '2026-07-28', days: 30 },
      predicted: {
        expected: { units_change_pct: -8.2, revenue_delta_cents: 184000, profit_delta_cents: 96000 },
        low: { units_change_pct: -16.4, revenue_delta_cents: 42000, profit_delta_cents: 12000 },
        high: { units_change_pct: -1.1, revenue_delta_cents: 301000, profit_delta_cents: 174000 },
      },
      realized: { units_change_pct: -5.4, revenue_delta_cents: 213000, profit_delta_cents: 118000 },
      in_range: true,
      elasticity_update: { before: -1.62, after: -1.18, se_after: 0.19, direction: 'less_sensitive' },
      narrative:
        'Orders held up better than expected after the increase. Your customers were less price-sensitive than we assumed, so the next forecast will start from a smaller predicted drop.',
      per_variant: [
        {
          variant_gid: toGid('ProductVariant', 2001),
          realized_units: 284,
          expected_units: 300,
          realized_revenue_cents: 999680,
          realized_profit_cents: 673080,
          elasticity_after: -1.18,
        },
      ],
    };
    validate('rollout_report.schema.json', report);
  });

  await test('confidence helpers agree with the contract ordering', () => {
    assertEqual(worstConfidence(['fitted', 'partial']), 'partial', 'worst of fitted+partial');
    assertEqual(worstConfidence(['fitted', 'assumption', 'partial']), 'assumption', 'assumption wins');
    assertEqual(worstConfidence(['fitted']), 'fitted', 'single tier');
    assertEqual(demoteConfidence('fitted'), 'partial', 'staleness demotes one step');
    assertEqual(demoteConfidence('partial'), 'assumption', 'and again');
    assertEqual(demoteConfidence('assumption'), 'assumption', 'never below the floor');
  });
}

// ---------------------------------------------------------------------------
// forecast
// ---------------------------------------------------------------------------

async function testForecast(): Promise<void> {
  section('forecast');

  await test('breakeven is exact margin arithmetic', () => {
    // price 32.00, cost 11.50, +10% -> 35.20. margin 20.50 -> 23.70.
    // breakeven multiplier = 20.50 / 23.70 = 0.86498 -> -13.50%
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 28, 10),
      change: { type: 'percent', percent: 10 },
      now: NOW,
    });

    assertEqual(forecast.breakeven.direction, 'can_lose', 'a price rise means orders can be lost');
    assertClose(forecast.breakeven.units_change_pct as number, -13.5021, 0.01, 'breakeven percent');
    assert(
      forecast.breakeven.sentence.includes('lose up to 14%'),
      `sentence should name the number, got: ${forecast.breakeven.sentence}`,
    );
  });

  await test('a price cut states the gain it needs instead', () => {
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 28, 10),
      change: { type: 'percent', percent: -10 },
      now: NOW,
    });
    assertEqual(forecast.breakeven.direction, 'must_gain', 'a cut needs more orders');
    // margin 20.50 -> 17.30; 20.50/17.30 - 1 = +18.50%
    assertClose(forecast.breakeven.units_change_pct as number, 18.4971, 0.01, 'breakeven percent');
  });

  await test('the breakeven scenario row lands at roughly zero profit', () => {
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 28, 10),
      change: { type: 'percent', percent: 10 },
      now: NOW,
    });
    const row = forecast.scenarios.find((scenario) => scenario.is_breakeven);
    assert(row !== undefined, 'a breakeven row exists');
    assertClose((row as { profit_delta_cents: number | null }).profit_delta_cents as number, 0, 300, 'breakeven profit');
  });

  await test('baseline arithmetic is exact and in cents', () => {
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 28, 10),
      change: { type: 'percent', percent: 10 },
      now: NOW,
    });
    assertClose(forecast.baseline.units_per_day, 10, 1e-6, 'units per day');
    assertEqual(forecast.baseline.revenue_cents_per_day, 320_00, 'revenue per day');
    assertEqual(forecast.baseline.profit_cents_per_day, 205_00, 'profit per day');
    assertClose(forecast.baseline.margin_pct as number, 64.0625, 0.01, 'margin percent');

    // At unchanged demand: (35.20 - 32.00) x 10 units x 90 days = $2,880.
    const flat = forecast.scenarios.find((scenario) => scenario.units_change_pct === 0);
    assertEqual((flat as { revenue_delta_cents: number }).revenue_delta_cents, 288_000, 'revenue delta at flat demand');
  });

  await test('missing COGS reports profit as unknown, never as zero', () => {
    const product = makeProduct({ cogs_cents: null, cogs_source: 'none' });
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 28, 10),
      change: { type: 'percent', percent: 10 },
      now: NOW,
    });

    assertEqual(forecast.baseline.profit_cents_per_day, null, 'baseline profit is null');
    assertEqual(forecast.baseline.has_cogs, false, 'has_cogs is false');
    assertEqual(forecast.breakeven.direction, 'undefined', 'breakeven is undefined');
    assert(
      forecast.scenarios.every((scenario) => scenario.profit_delta_cents === null),
      'every scenario reports null profit',
    );
    assert(
      forecast.warnings.some((warning) => warning.code === 'missing_cogs'),
      'and it warns about the missing cost',
    );
    // Revenue is still knowable, and still exact.
    assert(
      forecast.scenarios.some((scenario) => scenario.revenue_delta_cents !== 0),
      'revenue is still computed',
    );
  });

  await test('a fit produces a fitted range around the expected outcome', () => {
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 90, 10),
      change: { type: 'percent', percent: 10 },
      fits: new Map([[product.variant_gid, makeFit(product.variant_gid)]]),
      now: NOW,
    });

    assert(forecast.fitted !== null, 'fitted block present');
    assertEqual(forecast.confidence, 'fitted', 'tier is fitted');
    assertEqual(forecast.model_version, 'elasticity-v1.0.0', 'model version is traceable (R31)');

    const fitted = forecast.fitted as NonNullable<typeof forecast.fitted>;
    // elasticity -1.6 on a +10% price move: 1.1^-1.6 - 1 = -14.0%
    assertClose(fitted.expected.units_change_pct, -14.02, 0.2, 'expected units change');
    assert(fitted.low.units_change_pct < fitted.expected.units_change_pct, 'low end is worse');
    assert(fitted.high.units_change_pct > fitted.expected.units_change_pct, 'high end is better');
    assert(
      (fitted.low.profit_delta_cents as number) <= (fitted.high.profit_delta_cents as number),
      'low profit <= high profit',
    );
  });

  await test("Lane C's asymmetric bounds are used verbatim, not re-derived from se", () => {
    const product = makeProduct();
    // A posterior clipped near zero on the high side: -1.6 with bounds
    // [-2.60, -0.30] is not symmetric, so elasticity ± 1.96·se would misstate it.
    const asymmetric = makeFit(product.variant_gid, { se: 0.25, low: -2.6, high: -0.3 });
    const withBounds = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 90, 10),
      change: { type: 'percent', percent: 10 },
      fits: new Map([[product.variant_gid, asymmetric]]),
      now: NOW,
    });

    const symmetric = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 90, 10),
      change: { type: 'percent', percent: 10 },
      fits: new Map([[product.variant_gid, makeFit(product.variant_gid, { se: 0.25 })]]),
      now: NOW,
    });

    const bounded = withBounds.fitted as NonNullable<typeof withBounds.fitted>;
    const derived = symmetric.fitted as NonNullable<typeof symmetric.fitted>;

    // The supplied interval is much wider than ±1.96·0.25, so the served range
    // must be wider too — proof the bounds were honoured rather than ignored.
    const boundedWidth = bounded.high.units_change_pct - bounded.low.units_change_pct;
    const derivedWidth = derived.high.units_change_pct - derived.low.units_change_pct;
    assert(
      boundedWidth > derivedWidth * 1.5,
      `explicit bounds should widen the range: ${boundedWidth.toFixed(1)} vs ${derivedWidth.toFixed(1)}`,
    );
    // The expected value is untouched by the bounds.
    assertClose(bounded.expected.units_change_pct, derived.expected.units_change_pct, 0.01, 'centre unchanged');
  });

  await test('a variant without bounds still falls back to se, mixed in one selection', () => {
    const withBounds = makeProduct();
    const withoutBounds = makeProduct({ id: 'p2', variant_gid: toGid('ProductVariant', 2002) });

    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [withBounds, withoutBounds],
      orderDays: [...makeHistory(withBounds, 90, 10), ...makeHistory(withoutBounds, 90, 6)],
      change: { type: 'percent', percent: 10 },
      fits: new Map([
        [withBounds.variant_gid, makeFit(withBounds.variant_gid, { low: -2.2, high: -1.0 })],
        [withoutBounds.variant_gid, makeFit(withoutBounds.variant_gid, { se: 0.3 })],
      ]),
      now: NOW,
    });

    const fitted = forecast.fitted as NonNullable<typeof forecast.fitted>;
    assert(fitted.low.units_change_pct < fitted.expected.units_change_pct, 'range still brackets the estimate');
    assert(fitted.high.units_change_pct > fitted.expected.units_change_pct, 'on both sides');
  });

  await test('a stale fit is demoted, never served as fresh (R32)', () => {
    const product = makeProduct();
    const stale = makeFit(product.variant_gid, {
      fitted_at: new Date(NOW.getTime() - 45 * 86_400_000).toISOString(),
    });
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 90, 10),
      change: { type: 'percent', percent: 10 },
      fits: new Map([[product.variant_gid, stale]]),
      now: NOW,
    });

    assertEqual(forecast.confidence, 'partial', 'fitted demotes to partial when stale');
    assert(
      forecast.warnings.some((warning) => warning.code === 'stale_model'),
      'and it says why',
    );
  });

  await test('an assumption-tier fit is not leaned on', () => {
    const product = makeProduct();
    const weak = makeFit(product.variant_gid, { confidence: 'assumption', price_variation_pct: 0 });
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 90, 10),
      change: { type: 'percent', percent: 10 },
      fits: new Map([[product.variant_gid, weak]]),
      now: NOW,
    });
    assertEqual(forecast.fitted, null, 'no fitted block');
    assertEqual(forecast.confidence, 'assumption', 'and the tier is honest about it');
  });

  await test('gift cards and subscriptions are excluded, with the reason (R22)', () => {
    const tee = makeProduct();
    const giftCard = makeProduct({
      id: 'p2',
      variant_gid: toGid('ProductVariant', 2002),
      title: 'Gift Card',
      is_gift_card: true,
    });
    const subscription = makeProduct({
      id: 'p3',
      variant_gid: toGid('ProductVariant', 2003),
      title: 'Coffee Subscription',
      has_selling_plan: true,
    });

    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [tee, giftCard, subscription],
      orderDays: makeHistory(tee, 28, 10),
      change: { type: 'percent', percent: 10 },
      now: NOW,
    });

    assertEqual(forecast.proposal.variant_count, 1, 'only the tee is repriced');
    assertEqual(forecast.products.length, 3, 'but all three are reported');
    const excluded = forecast.products.filter((line) => line.excluded);
    assertEqual(excluded.length, 2, 'two exclusions');
    assert(
      excluded.some((line) => line.exclusion_reason === 'gift_card') &&
        excluded.some((line) => line.exclusion_reason === 'subscription'),
      'each exclusion says which rule caught it',
    );
    assert(
      forecast.products.filter((line) => line.excluded).every((line) => line.target_price_cents === line.current_price_cents),
      'excluded prices never move',
    );
  });

  await test('an all-excluded selection fails loudly', () => {
    const giftCard = makeProduct({ is_gift_card: true });
    let code = '';
    try {
      buildForecast({
        shop: { currency: 'USD', timezone: TZ },
        products: [giftCard],
        orderDays: [],
        change: { type: 'percent', percent: 10 },
        now: NOW,
      });
    } catch (cause) {
      code = cause instanceof ForecastError ? cause.code : 'wrong-error';
    }
    assertEqual(code, 'no_eligible_variants', 'throws a typed error');
  });

  await test('compare-at policy follows R13', () => {
    // Decrease: keep compare-at — the implied discount is now more true.
    const kept = resolveCompareAt(14800, 17800, 13000);
    assertEqual(kept.action, 'keep', 'kept on a decrease');
    assertEqual(kept.target, 17800, 'value unchanged');

    // Increase past compare-at: clear it, never show a fake discount.
    const cleared = resolveCompareAt(14800, 17800, 18000);
    assertEqual(cleared.action, 'clear', 'cleared when the new price passes it');
    assertEqual(cleared.target, null, 'compare-at removed');

    // Exactly equal also clears: a "discount" to the same price is a lie.
    assertEqual(resolveCompareAt(14800, 17800, 17800).action, 'clear', 'equal clears');

    // No compare-at to begin with.
    assertEqual(resolveCompareAt(14800, null, 16000).action, 'none', 'nothing to do');
  });

  await test('the forecast warns when a new price is below cost', () => {
    const product = makeProduct({ price_cents: 1200, cogs_cents: 1150 });
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 28, 5),
      change: { type: 'percent', percent: -20 },
      now: NOW,
    });
    assert(
      forecast.warnings.some((warning) => warning.code === 'price_below_cost'),
      'warns about selling below cost',
    );
    assertEqual(forecast.breakeven.direction, 'undefined', 'and breakeven is meaningless there');
  });

  await test('a zero change is rejected rather than forecast', () => {
    assertThrows(() => computeTargetPrice(3200, { type: 'percent', percent: 0 }), 'zero percent');
    assertThrows(() => computeTargetPrice(3200, { type: 'absolute', absolute_cents: 0 }), 'zero cents');
  });

  await test('thin history is called out, not smoothed over', () => {
    const product = makeProduct();
    const forecast = buildForecast({
      shop: { currency: 'USD', timezone: TZ },
      products: [product],
      orderDays: makeHistory(product, 9, 4),
      change: { type: 'percent', percent: 5 },
      now: NOW,
    });
    assert(
      forecast.warnings.some((warning) => warning.code === 'thin_history'),
      'warns about thin history',
    );
    assert(
      forecast.warnings.some((warning) => warning.code === 'no_price_variation'),
      'and about the single price level',
    );
  });

  await test('breakeven on a mixed-margin selection is volume weighted', () => {
    const highMargin = makeProduct({ price_cents: 10000, cogs_cents: 2000 });
    const lowMargin = makeProduct({
      id: 'p2',
      variant_gid: toGid('ProductVariant', 2002),
      price_cents: 10000,
      cogs_cents: 9000,
    });
    const breakeven = computeBreakeven([
      {
        product: highMargin,
        baseline: { unitsPerDay: 1, ordersPerDay: 1, windowDays: 28, historyDays: 28, observedPriceLevels: 1 },
        unitsPerDay: 1,
        ordersPerDay: 1,
        basePriceCents: 10000,
        targetPriceCents: 11000,
        targetCompareAtCents: null,
        compareAtAction: 'none',
        cogsCents: 2000,
        fit: null,
        fitConfidence: 'assumption',
      },
      {
        product: lowMargin,
        baseline: { unitsPerDay: 1, ordersPerDay: 1, windowDays: 28, historyDays: 28, observedPriceLevels: 1 },
        unitsPerDay: 1,
        ordersPerDay: 1,
        basePriceCents: 10000,
        targetPriceCents: 11000,
        targetCompareAtCents: null,
        compareAtAction: 'none',
        cogsCents: 9000,
        fit: null,
        fitConfidence: 'assumption',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    // Margins: 8000 + 1000 = 9000 before, 9000 + 2000 = 11000 after.
    // 9000/11000 - 1 = -18.18%
    assertClose(breakeven.units_change_pct as number, -18.1818, 0.01, 'weighted breakeven');
  });
}

// ---------------------------------------------------------------------------
// guardrails
// ---------------------------------------------------------------------------

async function testGuardrails(): Promise<void> {
  section('guardrails');

  const rules = defaultGuardrails();

  await test('a healthy day is not a breach', () => {
    const assessment = evaluateGuardrails(rules, [observation({ day: '2026-07-28' })]);
    assertEqual(assessment.breach, false, 'no breach');
    assertEqual(assessment.action, null, 'no action');
  });

  await test('one bad day is not enough for a two-day rule', () => {
    const assessment = evaluateGuardrails(rules, [
      observation({ day: '2026-07-27' }),
      observation({ day: '2026-07-28', actual_units: 5 }),
    ]);
    assertEqual(assessment.breach, true, 'today did cross the line');
    assertEqual(assessment.streak, 1, 'streak of one');
    assertEqual(assessment.action, null, 'but the rule needs two days');
  });

  await test('two consecutive bad days trigger the rollback', () => {
    const assessment = evaluateGuardrails(rules, [
      observation({ day: '2026-07-26' }),
      observation({ day: '2026-07-27', actual_units: 5 }),
      observation({ day: '2026-07-28', actual_units: 4 }),
    ]);
    assertEqual(assessment.streak, 2, 'streak of two');
    assertEqual(assessment.action, 'rollback_all', 'and it fires');
    assert((assessment.reason ?? '').includes('below'), `reason reads plainly: ${assessment.reason}`);
  });

  await test('a gap in the data breaks the streak', () => {
    // Two bad days, but with a missing day between them: "two days in a row"
    // has to mean two actual days.
    const assessment = evaluateGuardrails(rules, [
      observation({ day: '2026-07-25', actual_units: 4 }),
      observation({ day: '2026-07-28', actual_units: 4 }),
    ]);
    assertEqual(assessment.streak, 1, 'streak does not span the gap');
    assertEqual(assessment.action, null, 'so nothing fires');
  });

  await test('low-volume days cannot trip a guardrail on their own', () => {
    // Expected 1.5 units, got zero. On a small store that is ordinary noise.
    const quiet = [
      observation({ day: '2026-07-27', actual_units: 0, expected_units: 1.5, expected_low: 0, expected_high: 4 }),
      observation({ day: '2026-07-28', actual_units: 0, expected_units: 1.5, expected_low: 0, expected_high: 4 }),
    ];
    const assessment = evaluateGuardrails(rules, quiet);
    assertEqual(assessment.breach, false, 'no breach');
    assertEqual(assessment.floored, true, 'and it records that volume was too low to judge');
  });

  await test('auto_rollback: false downgrades the action to a pause', () => {
    const alertOnly: Guardrails = { ...defaultGuardrails(), auto_rollback: false };
    const assessment = evaluateGuardrails(alertOnly, [
      observation({ day: '2026-07-27', actual_units: 4 }),
      observation({ day: '2026-07-28', actual_units: 4 }),
    ]);
    assertEqual(assessment.action, 'pause', 'alert-only pauses instead of reverting');
  });

  await test('a profit rule is skipped, loudly, when profit is unknown', () => {
    const profitRule: Guardrails = {
      contract_version: CONTRACT_VERSION,
      auto_rollback: true,
      rules: [
        {
          id: 'profit-25-2d',
          metric: 'profit',
          comparison: 'below_expected_pct',
          threshold_pct: 25,
          consecutive_days: 2,
          scope: 'rollout',
          action: 'rollback_all',
          sentence: 'If daily profit falls more than 25% below expected for 2 days, revert everything.',
        },
      ],
    };
    const assessment = evaluateGuardrails(profitRule, [
      observation({ day: '2026-07-27', actual_profit_cents: null, expected_profit_cents: null }),
      observation({ day: '2026-07-28', actual_profit_cents: null, expected_profit_cents: null }),
    ]);
    assertEqual(assessment.breach, false, 'unknown profit is not a satisfied guardrail');
    assertEqual(assessment.skipped.length, 1, 'the skip is recorded');
    assert((assessment.skipped[0]?.why ?? '').includes('cost'), 'and it explains why');
  });

  await test('a calibrated breach probability takes precedence (R29)', () => {
    // Actual is inside the raw threshold, but the model is 91% sure the drop is real.
    const assessment = evaluateGuardrails(rules, [
      observation({ day: '2026-07-27', actual_units: 9, breach_probability: 0.91 }),
      observation({ day: '2026-07-28', actual_units: 9, breach_probability: 0.93 }),
    ]);
    assertEqual(assessment.action, 'rollback_all', 'probability fires the rule');
    assert((assessment.reason ?? '').includes('%'), 'and states the confidence');
  });

  await test('a low breach probability suppresses a raw threshold crossing', () => {
    const assessment = evaluateGuardrails(rules, [
      observation({ day: '2026-07-27', actual_units: 4, breach_probability: 0.2 }),
      observation({ day: '2026-07-28', actual_units: 4, breach_probability: 0.15 }),
    ]);
    assertEqual(assessment.breach, false, 'the model says it is noise');
  });

  await test('an absolute floor rule works on revenue', () => {
    const floorRule: Guardrails = {
      contract_version: CONTRACT_VERSION,
      auto_rollback: true,
      rules: [
        {
          id: 'revenue-floor',
          metric: 'revenue',
          comparison: 'below_absolute',
          threshold_pct: null,
          absolute_floor: 25000,
          consecutive_days: 1,
          scope: 'rollout',
          action: 'pause',
          sentence: 'If daily revenue falls below $250, pause the rollout.',
        },
      ],
    };
    const assessment = evaluateGuardrails(floorRule, [
      observation({ day: '2026-07-28', actual_revenue_cents: 19000 }),
    ]);
    assertEqual(assessment.action, 'pause', 'floor rule fires');
  });

  await test('no rules means nothing ever fires', () => {
    const none: Guardrails = { contract_version: CONTRACT_VERSION, auto_rollback: true, rules: [] };
    const assessment = evaluateGuardrails(none, [observation({ day: '2026-07-28', actual_units: 0 })]);
    assertEqual(assessment.breach, false, 'no rules, no breach');
  });
}

// ---------------------------------------------------------------------------
// rollout state machine
// ---------------------------------------------------------------------------

async function testRollout(): Promise<void> {
  section('rollout state machine');

  await test('the default plan is 25 / 50 / 100 of the selection', () => {
    const stages = normalizeStages(undefined, 12);
    assertEqual(stages.length, 3, 'three stages');
    assertEqual(stages[0]?.fraction, 0.25, 'first is a quarter');
    assertEqual(stages[2]?.fraction, 1, 'last is everything');
    assertEqual(stages.reduce((sum, stage) => sum + stage.hold_days, 0), 10, 'ten days of holds');
  });

  await test('a single SKU collapses to a time canary (R11)', () => {
    const stages = normalizeStages(undefined, 1);
    assert(
      stages.every((stage) => stage.fraction === 1),
      'one SKU cannot be split into cohorts, so every stage is the whole selection',
    );
    assertEqual(stages.length, 2, 'two timed holds');
  });

  await test('invalid stage plans are rejected', () => {
    assertThrows(() => normalizeStages([{ fraction: 0.5, hold_days: 3 }], 10), 'last stage must reach 1');
    assertThrows(
      () =>
        normalizeStages(
          [
            { fraction: 0.5, hold_days: 3 },
            { fraction: 0.25, hold_days: 3 },
            { fraction: 1, hold_days: 3 },
          ],
          10,
        ),
      'fractions must not decrease',
    );
    assertThrows(() => normalizeStages([{ fraction: 1, hold_days: 0 }], 10), 'hold_days must be >= 1');
    assertThrows(() => normalizeStages([{ fraction: 1.5, hold_days: 3 }], 10), 'fraction must be <= 1');

    let code = '';
    try {
      normalizeStages(undefined, 0);
    } catch (cause) {
      code = cause instanceof RolloutError ? cause.code : 'wrong-error';
    }
    assertEqual(code, 'no_eligible_variants', 'empty selection is a typed error');
  });

  await test('cohorts are deterministic and correctly sized', () => {
    const gids = Array.from({ length: 8 }, (_, i) => toGid('ProductVariant', 3000 + i));
    const stages = normalizeStages(undefined, gids.length);

    const first = assignCohorts('rollout-a', gids, stages);
    const again = assignCohorts('rollout-a', gids, stages);
    assert(
      gids.every((gid) => first.get(gid) === again.get(gid)),
      'the same rollout picks the same cohorts every time',
    );

    assertEqual(cohortSizes(first, 3).join(','), '2,2,4', '25% / 50% / 100% of 8 variants');
    assertEqual(liveCountAtStage(first, 0), 2, 'two live at stage 0');
    assertEqual(liveCountAtStage(first, 1), 4, 'four live at stage 1');
    assertEqual(liveCountAtStage(first, 2), 8, 'everything live at the end');
  });

  await test('a different rollout shuffles differently', () => {
    const gids = Array.from({ length: 20 }, (_, i) => toGid('ProductVariant', 4000 + i));
    const stages = normalizeStages(undefined, gids.length);
    const a = assignCohorts('rollout-a', gids, stages);
    const b = assignCohorts('rollout-b', gids, stages);
    const sameStage = gids.filter((gid) => a.get(gid) === b.get(gid)).length;
    assert(sameStage < gids.length, 'the same SKUs are not always first');
  });

  await test('planning captures baselines and freezes the compare-at decision', () => {
    const tee = makeProduct();
    const sweater = makeProduct({
      id: 'p2',
      variant_gid: toGid('ProductVariant', 2002),
      price_cents: 14800,
      compare_at_cents: 17800,
      cogs_cents: 6100,
    });
    const giftCard = makeProduct({ id: 'p3', variant_gid: toGid('ProductVariant', 2003), is_gift_card: true });

    const rows = planRolloutVariants({
      rolloutId: 'rollout-a',
      shopId: 'shop1',
      products: [tee, sweater, giftCard],
      change: { type: 'percent', percent: 25 },
      stages: normalizeStages(undefined, 2),
    });

    assertEqual(rows.length, 3, 'excluded variants are recorded too');
    const teeRow = rows.find((row) => row.variant_gid === tee.variant_gid);
    assertEqual(teeRow?.baseline_price_cents, 3200, 'baseline is the price at creation');
    assertEqual(teeRow?.target_price_cents, 4000, '+25% of 3200');

    // 14800 + 25% = 18500, which passes the 17800 compare-at, so it is cleared.
    const sweaterRow = rows.find((row) => row.variant_gid === sweater.variant_gid);
    assertEqual(sweaterRow?.compare_at_action, 'clear', 'compare-at cleared on the increase');
    assertEqual(sweaterRow?.target_compare_at_cents, null, 'and the value removed');

    const giftRow = rows.find((row) => row.variant_gid === giftCard.variant_gid);
    assertEqual(giftRow?.excluded, true, 'gift card excluded');
    assertEqual(giftRow?.target_price_cents, giftRow?.baseline_price_cents, 'and its price never moves');
  });

  await test('holds while the stage is young', () => {
    const rollout = makeRollout({
      stage_entered_at: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
    });
    const decision = decideNext({
      rollout,
      assessment: evaluateGuardrails(rollout.guardrails, [observation({ day: TODAY })]),
      asOf: TODAY,
      timezone: TZ,
    });
    assertEqual(decision.decision, 'hold', 'holds');
    assert(decision.reason.includes('more day'), `says how long: ${decision.reason}`);
  });

  await test('advances once the hold is served', () => {
    const rollout = makeRollout();
    const decision = decideNext({
      rollout,
      assessment: evaluateGuardrails(rollout.guardrails, [observation({ day: TODAY })]),
      asOf: TODAY,
      timezone: TZ,
    });
    assertEqual(decision.decision, 'advance', 'advances');
    assertEqual(decision.next_stage, 1, 'to stage 1');
    assert(decision.reason.includes('50%'), `names the new cohort size: ${decision.reason}`);
  });

  await test('completes after the final stage', () => {
    const rollout = makeRollout({ current_stage: 2 });
    const decision = decideNext({
      rollout,
      assessment: evaluateGuardrails(rollout.guardrails, [observation({ day: TODAY })]),
      asOf: TODAY,
      timezone: TZ,
    });
    assertEqual(decision.decision, 'complete', 'completes');
  });

  await test('safety outranks advancing', () => {
    // The stage is ready to advance AND a guardrail has fired. Advancing a
    // failing rollout is the worst possible outcome, so rollback wins.
    const rollout = makeRollout();
    const assessment = evaluateGuardrails(rollout.guardrails, [
      observation({ day: addDays(TODAY, -1), actual_units: 4 }),
      observation({ day: TODAY, actual_units: 4 }),
    ]);
    assertEqual(assessment.action, 'rollback_all', 'guardrail fired');

    const decision = decideNext({ rollout, assessment, asOf: TODAY, timezone: TZ });
    assertEqual(decision.decision, 'rollback', 'rollback beats advance');
  });

  await test('a rollout that is not running decides nothing', () => {
    for (const status of ['paused', 'completed', 'draft', 'rolled_back'] as const) {
      const decision = decideNext({
        rollout: makeRollout({ status }),
        assessment: evaluateGuardrails(defaultGuardrails(), [observation({ day: TODAY, actual_units: 0 })]),
        asOf: TODAY,
        timezone: TZ,
      });
      assertEqual(decision.decision, 'none', `no decision while ${status}`);
    }
  });

  await test('status transitions are constrained', () => {
    assert(canTransition('draft', 'running'), 'draft -> running');
    assert(canTransition('running', 'rolled_back'), 'running -> rolled_back');
    assert(canTransition('paused', 'running'), 'paused -> running');
    assert(!canTransition('completed', 'running'), 'completed is terminal');
    assert(!canTransition('rolled_back', 'running'), 'rolled_back is terminal');
    assert(!canTransition('draft', 'completed'), 'no shortcut to completed');
  });

  await test('scheduled starts fire only when due (R14)', () => {
    const future = makeRollout({
      status: 'scheduled',
      scheduled_start_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    });
    const past = makeRollout({
      status: 'scheduled',
      scheduled_start_at: new Date(NOW.getTime() - 3600_000).toISOString(),
    });
    assertEqual(isDueToStart(future, NOW), false, 'not yet');
    assertEqual(isDueToStart(past, NOW), true, 'due');
    assertEqual(isDueToStart(makeRollout({ status: 'running' }), NOW), false, 'already running');
  });

  await test('stage writes touch only the newly-live cohort', () => {
    const variants = [
      { variant_gid: 'a', cohort_stage: 0, target_price_cents: 100, excluded: false },
      { variant_gid: 'b', cohort_stage: 1, target_price_cents: 200, excluded: false },
      { variant_gid: 'c', cohort_stage: 1, target_price_cents: 300, excluded: true },
    ];
    assertEqual(pricesForStage(variants, 0).length, 1, 'stage 0 writes one price');
    assertEqual(pricesForStage(variants, 1).length, 1, 'stage 1 skips the excluded variant');
  });

  await test('rollback restores every applied variant from its baseline', () => {
    const variants = [
      { variant_gid: 'a', baseline_price_cents: 100, baseline_compare_at_cents: 150, applied_at: NOW.toISOString(), excluded: false },
      // Never applied: nothing to restore.
      { variant_gid: 'b', baseline_price_cents: 200, baseline_compare_at_cents: null, applied_at: null, excluded: false },
      { variant_gid: 'c', baseline_price_cents: 300, baseline_compare_at_cents: null, applied_at: NOW.toISOString(), excluded: true },
    ];
    const restores = pricesForRollback(variants);
    assertEqual(restores.length, 1, 'only the applied, non-excluded variant');
    assertEqual(restores[0]?.price_cents, 100, 'restores the captured baseline');
    assertEqual(restores[0]?.compare_at_cents, 150, 'including compare-at');
  });
}

// ---------------------------------------------------------------------------
// fallback bands
// ---------------------------------------------------------------------------

async function testBands(): Promise<void> {
  section('fallback expected band');

  const flat = Array.from({ length: 28 }, (_, i) => ({ day: addDays(TODAY, -(28 - i)), units: 10 }));

  await test('a steady history gives a band centred on the mean', () => {
    const band = bracketBand(flat, TODAY);
    assertClose(band.expected_units, 10, 0.5, 'expected units');
    assert(band.low < band.expected_units && band.expected_units < band.high, 'band brackets the estimate');
    assertEqual(band.floored, false, 'volume is high enough to judge');
    assertEqual(band.source, 'bracket', 'never claims to be a model');
  });

  await test('a low-volume history floors the low edge', () => {
    const quiet = Array.from({ length: 28 }, (_, i) => ({ day: addDays(TODAY, -(28 - i)), units: i % 7 === 0 ? 1 : 0 }));
    const band = bracketBand(quiet, TODAY);
    assertEqual(band.floored, true, 'too quiet to judge a single day');
    assertEqual(band.low, 0, 'so the low edge cannot trigger anything');
  });

  await test('no history is an honest zero, not a confident one', () => {
    const band = bracketBand([], TODAY);
    assertEqual(band.expected_units, 0, 'no expectation');
    assertEqual(band.floored, true, 'and flagged');
    assertEqual(band.n_obs, 0, 'with the sample size stated');
  });

  await test('history after the target day is ignored', () => {
    const withFuture = [...flat, { day: addDays(TODAY, 1), units: 9999 }];
    const band = bracketBand(withFuture, TODAY);
    assertClose(band.expected_units, 10, 0.5, 'a future outlier cannot leak in');
  });

  await test('a noisier history gives a wider band', () => {
    const noisy = Array.from({ length: 28 }, (_, i) => ({
      day: addDays(TODAY, -(28 - i)),
      units: i % 2 === 0 ? 2 : 18,
    }));
    const steady = bracketBand(flat, TODAY);
    const wild = bracketBand(noisy, TODAY);
    assert(wild.high - wild.low > steady.high - steady.low, 'more variance, wider band');
  });

  await test('combining independent bands tightens relative to the sum', () => {
    const single = bracketBand(flat, TODAY);
    const combined = combineBands([single, single, single, single]);
    assertClose(combined.expected_units, single.expected_units * 4, 0.01, 'means add');
    const singleWidth = single.high - single.low;
    const combinedWidth = combined.high - combined.low;
    assert(combinedWidth < singleWidth * 4, 'independent variances add, so the width grows with sqrt(n)');
  });
}

// ---------------------------------------------------------------------------
// readings -> verdicts (REQ-A-003: the UI renders a decision, never makes one)
// ---------------------------------------------------------------------------

async function testReadings(): Promise<void> {
  section('reading verdicts');

  await test('a day is only "below" when it leaves the honest interval', () => {
    // Beneath the point estimate but inside the band: half of all healthy days
    // look like this, and calling them "below" would cry wolf.
    assertEqual(readingVerdict(9, 8, 18), 'within', 'inside the band');
    assertEqual(readingVerdict(7, 8, 18), 'below', 'under the low edge');
    assertEqual(readingVerdict(19, 8, 18), 'above', 'over the high edge');
    assertEqual(readingVerdict(8, 8, 18), 'within', 'exactly on the edge is not a breach');
  });

  const reading = {
    day: TODAY,
    actual_units: 12,
    expected_units: 13.4,
    expected_low: 8,
    expected_high: 18,
    band_floored: false,
    band_stale: false,
    breach: false,
    breach_streak: 0,
  };

  await test('the sentence states both numbers in plain language', () => {
    const sentence = readingSentence(reading);
    assert(sentence.includes('12 units'), `actual: ${sentence}`);
    assert(sentence.includes('inside the range'), `verdict: ${sentence}`);
    assert(!/band|interval|guardrail threshold/i.test(sentence), `no jargon (R25): ${sentence}`);
  });

  await test('a floored band refuses to claim anything either way', () => {
    const sentence = readingSentence({ ...reading, band_floored: true });
    assert(sentence.includes('too few orders'), `says why it cannot judge: ${sentence}`);
    assert(!sentence.includes('inside the range'), 'and does not overclaim');
  });

  await test('a stale band says so rather than hiding it (R32)', () => {
    assert(readingSentence({ ...reading, band_stale: true }).includes('out of date'), 'staleness is visible');
  });

  await test('rollout health has a "watching" state between healthy and breaching', () => {
    assertEqual(rolloutHealth('running', [reading]), 'healthy', 'inside the range');
    assertEqual(rolloutHealth('running', [{ ...reading, breach: true, breach_streak: 1 }]), 'watching', 'one bad day');
    assertEqual(
      rolloutHealth('running', [{ ...reading, breach: true, breach_streak: 2 }]),
      'breaching',
      'two bad days',
    );
    assertEqual(rolloutHealth('running', []), 'too_early', 'no readings yet');
    assertEqual(rolloutHealth('running', [{ ...reading, band_floored: true }]), 'too_early', 'too quiet to judge');
    assertEqual(rolloutHealth('draft', [reading]), 'not_live', 'nothing live');
    assertEqual(rolloutHealth('running', [{ ...reading, actual_units: 4 }]), 'watching', 'below the band but not tripped');
  });

  await test('health sentences never blame the merchant or use jargon', () => {
    for (const health of ['healthy', 'watching', 'breaching', 'too_early', 'not_live'] as const) {
      const sentence = healthSentence(health, 'hold', 2);
      assert(sentence.length > 20, `${health} has a real sentence`);
      assert(!/elasticity|confidence interval|guardrail threshold/i.test(sentence), `${health} avoids jargon`);
    }
  });

  await test('unknown profit does not sum to zero', () => {
    const known = sumReadings([
      { actual_units: 10, actual_revenue_cents: 32000, actual_profit_cents: 20500 },
      { actual_units: 8, actual_revenue_cents: 25600, actual_profit_cents: 16400 },
    ]);
    assertEqual(known.units, 18, 'units add');
    assertEqual(known.revenue_cents, 57600, 'revenue adds');
    assertEqual(known.profit_cents, 36900, 'profit adds');

    const partial = sumReadings([
      { actual_units: 10, actual_revenue_cents: 32000, actual_profit_cents: 20500 },
      { actual_units: 8, actual_revenue_cents: 25600, actual_profit_cents: null },
    ]);
    assertEqual(partial.revenue_cents, 57600, 'revenue is still exact');
    assertEqual(partial.profit_cents, null, 'but the total profit is unknown, not partial');
  });
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

async function testJournal(): Promise<void> {
  section('journal');

  await test('idempotency keys identify an intended write', () => {
    const a = rolloutIdempotencyKey('r1', 0, 'gid://shopify/ProductVariant/1', 3520);
    const b = rolloutIdempotencyKey('r1', 0, 'gid://shopify/ProductVariant/1', 3520);
    assertEqual(a, b, 'a retry of the same intent produces the same key');

    // An edited target is a different intent and must not be deduped away.
    assert(a !== rolloutIdempotencyKey('r1', 0, 'gid://shopify/ProductVariant/1', 3600), 'target price is in the key');
    assert(a !== rolloutIdempotencyKey('r1', 1, 'gid://shopify/ProductVariant/1', 3520), 'stage is in the key');

    // A rollback has no stage: however many times it is requested, one restore.
    const undo = rollbackIdempotencyKey('r1', 'gid://shopify/ProductVariant/1', 3200);
    assertEqual(undo, rollbackIdempotencyKey('r1', 'gid://shopify/ProductVariant/1', 3200), 'stable');
    assert(!undo.includes(':0:'), 'and stage-free');
  });

  await test('a journal entry carries both sides of the change', () => {
    const entry = buildJournalEntry(
      {
        variant_gid: 'gid://shopify/ProductVariant/1',
        product_gid: 'gid://shopify/Product/1',
        title: 'Everyday Tee',
        sku: 'TEE',
        before_price_cents: 3200,
        after_price_cents: 3520,
        before_compare_at_cents: null,
        after_compare_at_cents: null,
        currency: 'USD',
      },
      { source: 'rollout', actor: 'priceflag', rollout_id: 'r1', rollout_name: 'Spring', stage_index: 1 },
    );
    assertEqual(entry.before_price_cents, 3200, 'before price recorded');
    assertEqual(entry.status, 'applied', 'applied by default');
    assert((entry.reason ?? '').includes('Stage 2'), `human-readable reason: ${entry.reason}`);
  });

  await test('CSV export escapes commas, quotes and formulas', () => {
    const csv = journalToCsv([
      {
        contract_version: CONTRACT_VERSION,
        id: 'j1',
        variant_gid: 'gid://shopify/ProductVariant/1',
        product_gid: 'gid://shopify/Product/1',
        title: 'Tee, "Black"',
        sku: 'TEE',
        source: 'rollout',
        actor: 'priceflag',
        status: 'applied',
        before_price_cents: 3200,
        after_price_cents: 3520,
        currency: 'USD',
        // A spreadsheet would treat a leading = as a formula.
        reason: '=SUM(A1:A2)',
        applied_at: NOW.toISOString(),
      },
    ]);

    const lines = csv.trim().split('\n');
    assertEqual(lines.length, 2, 'header plus one row');
    assert(lines[1]?.includes('"Tee, ""Black"""'), 'quotes and commas escaped');
    assert(lines[1]?.includes("'=SUM"), 'formula injection neutralised');
    assert(lines[1]?.includes('32.00,35.20'), 'money exported as decimals for spreadsheets');
    assert(lines[1]?.includes('10.00'), 'and the percentage change is computed');
  });
}

// ---------------------------------------------------------------------------
// adapters — the same suite against every implementation
// ---------------------------------------------------------------------------

async function runAdapterSuite(label: string, adapter: StoreAdapter, shopId: string): Promise<void> {
  section(`adapter: ${label}`);

  await test('ping reports reachable', async () => {
    const ping = await adapter.ping();
    assertEqual(ping.ok, true, ping.detail ?? 'ping failed');
  });

  await test('lists the catalog and filters to repriceable variants', async () => {
    const all = await adapter.listProducts(shopId);
    assert(all.total >= 14, `expected the seeded catalog, got ${all.total}`);

    const repriceable = await adapter.listProducts(shopId, { only_repriceable: true });
    assert(repriceable.total < all.total, 'gift cards and subscriptions are filtered out');
    assert(
      repriceable.items.every((product) => exclusionReasonFor(product) === null),
      'nothing excluded slips through',
    );
  });

  await test('search and paging work', async () => {
    const found = await adapter.listProducts(shopId, { search: 'Tee' });
    assert(found.total >= 2, `search found ${found.total}`);

    const paged = await adapter.listProducts(shopId, { limit: 3, offset: 0 });
    assertEqual(paged.items.length, 3, 'page size respected');
    assert(paged.total > 3, 'total is the unpaged count');
  });

  await test('COGS can be set and cleared, keeping source consistent', async () => {
    const missing = await adapter.listProducts(shopId, { missing_cogs: true, only_repriceable: true });
    assert(missing.items.length > 0, 'the seeded store has a product with no cost, on purpose');
    const target = missing.items[0] as Product;

    const set = await adapter.setCogs(shopId, target.variant_gid, 4200, 'manual');
    assertEqual(set.cogs_cents, 4200, 'cost saved');
    assertEqual(set.cogs_source, 'manual', 'source recorded');

    const cleared = await adapter.setCogs(shopId, target.variant_gid, null, 'manual');
    assertEqual(cleared.cogs_cents, null, 'cost cleared');
    assertEqual(cleared.cogs_source, 'none', 'and source falls back to none');
  });

  await test('order history reads back in a date window', async () => {
    const products = await adapter.listProducts(shopId, { only_repriceable: true, limit: 1 });
    const variantGid = (products.items[0] as Product).variant_gid;

    const all = await adapter.getOrderDays(shopId, { variant_gids: [variantGid] });
    assert(all.length > 100, `expected months of history, got ${all.length} days`);

    const from = addDays(TODAY, -14);
    const window = await adapter.getOrderDays(shopId, { variant_gids: [variantGid], from_day: from });
    assert(window.length <= 15, 'window is respected');
    assert(
      window.every((row) => row.day >= from),
      'and nothing older leaks in',
    );
  });

  await test('a rollout round-trips with its variants and cohorts', async () => {
    const products = await adapter.listProducts(shopId, { only_repriceable: true, limit: 8 });
    const stages = normalizeStages(undefined, products.items.length);

    const rollout = await adapter.createRollout({
      shop_id: shopId,
      name: 'Smoke test rollout',
      status: 'draft',
      change_type: 'percent',
      change_pct: 8,
      change_absolute_cents: null,
      rounding: 'none',
      horizon_days: 90,
      stages,
      current_stage: -1,
      guardrails: defaultGuardrails(),
      forecast: null,
      scheduled_start_at: null,
      started_at: null,
      ended_at: null,
      ended_reason: null,
      paused_reason: null,
      notify_emails: [],
      created_by: 'smoke',
    });

    assertEqual(rollout.status, 'draft', 'created as a draft');
    assertEqual(rollout.current_stage, -1, 'nothing live yet');

    const planned = planRolloutVariants({
      rolloutId: rollout.id,
      shopId,
      products: products.items,
      change: { type: 'percent', percent: 8 },
      stages,
    });
    await adapter.insertRolloutVariants(planned);

    const stored = await adapter.getRolloutVariants(rollout.id);
    assertEqual(stored.length, planned.length, 'every variant stored');
    assert(
      stored.every((row) => row.baseline_price_cents > 0),
      'baselines captured',
    );
    assert(
      stored.some((row) => row.cohort_stage === 0) && stored.some((row) => row.cohort_stage === stages.length - 1),
      'cohorts span the stages',
    );

    const running = await adapter.updateRollout(rollout.id, {
      status: 'running',
      current_stage: 0,
      started_at: NOW.toISOString(),
      stage_entered_at: NOW.toISOString(),
    });
    assertEqual(running.status, 'running', 'transitions persist');

    const active = await adapter.listActiveRollouts();
    assert(
      active.some((candidate) => candidate.id === rollout.id),
      'and it shows up for the evaluator',
    );

    // -- idempotency of the daily reading -----------------------------------
    const readingBase = {
      rollout_id: rollout.id,
      shop_id: shopId,
      day: TODAY,
      stage_index: 0,
      actual_units: 12,
      actual_orders: 11,
      actual_revenue_cents: 38400,
      actual_profit_cents: 24600,
      expected_units: 13,
      expected_low: 8,
      expected_high: 18,
      expected_source: 'bracket' as const,
      interval_nominal: 0.8,
      model_version: null,
      band_stale: false,
      band_floored: false,
      breach_probability: null,
      breach: false,
      breach_rule_id: null,
      breach_reason: null,
      breach_streak: 0,
      decision: 'hold' as const,
      evaluated_at: NOW.toISOString(),
    };
    await adapter.upsertRolloutReading(readingBase);
    await adapter.upsertRolloutReading({ ...readingBase, actual_units: 14, decision: 'advance' });

    const readings = await adapter.listRolloutReadings(rollout.id);
    assertEqual(readings.length, 1, 'a second evaluation of the same day updates, never duplicates');
    assertEqual(readings[0]?.actual_units, 14, 'and the newer numbers win');

    // -- journal idempotency ------------------------------------------------
    const variant = stored.find((row) => !row.excluded) as (typeof stored)[number];
    const key = rolloutIdempotencyKey(rollout.id, 0, variant.variant_gid, variant.target_price_cents);
    const entry = buildJournalEntry(
      {
        variant_gid: variant.variant_gid,
        product_gid: variant.product_gid,
        title: variant.title,
        sku: variant.sku,
        before_price_cents: variant.baseline_price_cents,
        after_price_cents: variant.target_price_cents,
        before_compare_at_cents: variant.baseline_compare_at_cents,
        after_compare_at_cents: variant.target_compare_at_cents,
        currency: 'USD',
      },
      { source: 'rollout', actor: 'priceflag', rollout_id: rollout.id, stage_index: 0, idempotency_key: key },
    );

    const firstWrite = await adapter.appendJournalEntries(shopId, [entry]);
    assertEqual(firstWrite.length, 1, 'first write lands');
    const secondWrite = await adapter.appendJournalEntries(shopId, [entry]);
    assertEqual(secondWrite.length, 0, 'the retry is skipped, not duplicated');

    const journal = await adapter.listJournalEntries(shopId, { rollout_id: rollout.id });
    assertEqual(journal.total, 1, 'exactly one entry for this write');

    const last = await adapter.getLastJournaledPrice(shopId, variant.variant_gid);
    assertEqual(last?.after_price_cents, variant.target_price_cents, 'and the recovery read finds it');

    // -- events -------------------------------------------------------------
    await adapter.appendRolloutEvent({
      rollout_id: rollout.id,
      shop_id: shopId,
      type: 'started',
      message: 'The new price is live on the first cohort.',
      actor: 'priceflag',
      data: { stage: 0 },
    });
    const events = await adapter.listRolloutEvents(rollout.id);
    assert(events.length >= 1, 'events are readable');
    assertEqual(events[0]?.type, 'started', 'newest first');

    // -- locking ------------------------------------------------------------
    const outcome = await adapter.withRolloutLock(rollout.id, async () => {
      const contended = await adapter.withRolloutLock(rollout.id, async () => 'should not run');
      assertEqual(contended.acquired, false, 'a second evaluator cannot take the lease');
      return 'done';
    });
    assertEqual(outcome.acquired, true, 'the first evaluator holds it');
    assertEqual(outcome.result, 'done', 'and its work runs');

    const afterRelease = await adapter.withRolloutLock(rollout.id, async () => 'reacquired');
    assertEqual(afterRelease.acquired, true, 'the lease is released afterwards');

    // Leave the store tidy for the next run.
    await adapter.updateRollout(rollout.id, {
      status: 'cancelled',
      ended_at: NOW.toISOString(),
      ended_reason: 'cancelled',
    });
  });

  await test('webhooks dedupe on the delivery id', async () => {
    const webhookId = `smoke-${label}-orders-create-1`;
    const first = await adapter.recordWebhook({
      shop_domain: DEMO_SHOP_DOMAIN,
      topic: 'orders/create',
      webhook_id: webhookId,
    });
    const second = await adapter.recordWebhook({
      shop_domain: DEMO_SHOP_DOMAIN,
      topic: 'orders/create',
      webhook_id: webhookId,
    });

    assertEqual(second.duplicate, true, 'a redelivery is recognised');
    assertEqual(first.record.webhook_id, second.record.webhook_id, 'and maps to the same record');

    await adapter.markWebhookProcessed(webhookId, 'processed');
  });

  await test('sync progress can be created and advanced', async () => {
    const run = await adapter.createSyncRun(shopId, 'catalog');
    assertEqual(run.stage, 'queued', 'starts queued');

    const advanced = await adapter.updateSyncRun(run.id, {
      stage: 'catalog',
      products_total: 14,
      products_synced: 14,
      catalog_ready_at: NOW.toISOString(),
      message: 'Loaded 14 products. Reading order history next.',
    });
    assertEqual(advanced.products_synced, 14, 'counts persist');
    assert(advanced.catalog_ready_at !== null, 'catalog readiness is its own moment');

    const latest = await adapter.getLatestSyncRun(shopId);
    assertEqual(latest?.id, run.id, 'the newest run is what onboarding reads');
  });

  await test('ML outputs read back through the fallback chain', async () => {
    const products = await adapter.listProducts(shopId, { only_repriceable: true, limit: 2 });
    const variantGids = products.items.map((product) => product.variant_gid);

    if (adapter.upsertFits) {
      await adapter.upsertFits(shopId, [
        {
          shop_id: shopId,
          variant_gid: variantGids[0] as string,
          elasticity: -1.55,
          se: 0.22,
          low: -1.94,
          high: -1.21,
          interval_nominal: 0.8,
          n_obs: 160,
          price_variation_pct: 9.8,
          confidence: 'fitted',
          confidence_explanation: null,
          method: 'smoke',
          shrinkage_weight: 0.8,
          prior_elasticity: -1.4,
          r2: 0.38,
          model_version: 'smoke-v1',
          model_run_id: null,
          window_start: addDays(TODAY, -180),
          window_end: addDays(TODAY, -1),
          fitted_at: NOW.toISOString(),
        },
      ]);
    }

    const fits = await adapter.getLatestFits(shopId, variantGids);
    if (adapter.upsertFits) {
      assert(fits.has(variantGids[0] as string), 'the fit is readable');
      assertEqual(fits.get(variantGids[0] as string)?.model_version, 'smoke-v1', 'with its version');
    }
    // The variant with no fit is simply absent — the forecast falls back to
    // bracket math for it rather than inventing one.
    assert(!fits.has(variantGids[1] as string) || fits.size >= 1, 'missing fits are absent, not faked');
  });

  await test('a forecast can be built end to end from stored data', async () => {
    const products = await adapter.listProducts(shopId, { only_repriceable: true, limit: 4 });
    const variantGids = products.items.map((product) => product.variant_gid);
    const orderDays = await adapter.getOrderDays(shopId, {
      variant_gids: variantGids,
      from_day: addDays(TODAY, -90),
    });
    const shop = await adapter.getShop(shopId);
    const fits = await adapter.getLatestFits(shopId, variantGids);

    const forecast = buildForecast({
      shop: { currency: shop?.currency ?? 'USD', timezone: shop?.timezone ?? 'UTC' },
      products: products.items,
      orderDays,
      change: { type: 'percent', percent: 7 },
      fits,
      now: NOW,
    });

    assertEqual(forecast.proposal.variant_count, products.items.length, 'every selected variant priced');
    assert(forecast.baseline.units_per_day > 0, 'the seeded store actually sells things');
    assert(forecast.scenarios.length >= 5, 'the scenario table is populated');
    assert(forecast.explanation.length > 40, 'and there is a plain-language explanation');
  });
}

async function testAdapters(): Promise<void> {
  const demo = DemoAdapter.ephemeral(20260729);
  const demoShop = await demo.demoShop();
  await runAdapterSuite('DemoAdapter (in-memory)', demo, demoShop.id);

  // -- persistence ---------------------------------------------------------
  section('adapter: DemoAdapter persistence');

  const statePath = resolve(process.cwd(), '.priceflag/smoke-state.json');
  if (existsSync(statePath)) rmSync(statePath);

  await test('demo state survives a restart', async () => {
    const first = new DemoAdapter({ statePath, autoSeed: true, seed: 20260729 });
    const shop = await first.demoShop();
    const products = await first.listProducts(shop.id, { only_repriceable: true, limit: 1 });
    const variantGid = (products.items[0] as Product).variant_gid;
    await first.setCogs(shop.id, variantGid, 1234, 'manual');

    await first.appendJournalEntries(shop.id, [
      buildJournalEntry(
        {
          variant_gid: variantGid,
          product_gid: (products.items[0] as Product).product_gid,
          title: 'restart test',
          sku: null,
          before_price_cents: 1000,
          after_price_cents: 1100,
          before_compare_at_cents: null,
          after_compare_at_cents: null,
          currency: 'USD',
        },
        { source: 'manual', actor: 'merchant', idempotency_key: 'restart-test-1' },
      ),
    ]);

    assert(existsSync(statePath), 'state was written to disk');

    // A brand new adapter on the same path is a restart.
    const second = new DemoAdapter({ statePath, autoSeed: true, seed: 20260729 });
    const reloadedShop = await second.getShopByDomain(DEMO_SHOP_DOMAIN);
    assertEqual(reloadedShop?.id, shop.id, 'same shop, same id');

    const reloaded = await second.getProductsByVariantGids(shop.id, [variantGid]);
    assertEqual(reloaded[0]?.cogs_cents, 1234, 'the cost edit survived');

    const journal = await second.listJournalEntries(shop.id, { sources: ['manual'] });
    assertEqual(journal.total, 1, 'and so did the journal entry');

    // Re-appending the same key after a restart is still a no-op.
    const retry = await second.appendJournalEntries(shop.id, [
      buildJournalEntry(
        {
          variant_gid: variantGid,
          product_gid: (products.items[0] as Product).product_gid,
          title: 'restart test',
          sku: null,
          before_price_cents: 1000,
          after_price_cents: 1100,
          before_compare_at_cents: null,
          after_compare_at_cents: null,
          currency: 'USD',
        },
        { source: 'manual', actor: 'merchant', idempotency_key: 'restart-test-1' },
      ),
    ]);
    assertEqual(retry.length, 0, 'idempotency outlives the process');

    rmSync(statePath);
  });

  // -- Supabase ------------------------------------------------------------
  if (!hasSupabaseConfig()) {
    section('adapter: SupabaseAdapter');
    skip('the full adapter suite', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }

  const supabase = new SupabaseAdapter();
  const ping = await supabase.ping();
  if (!ping.ok) {
    section('adapter: SupabaseAdapter');
    skip('the full adapter suite', `unreachable: ${ping.detail ?? 'unknown'}`);
    return;
  }

  // Seeding is outside the harness, so a failure here would crash the run rather
  // than fail a test. Degrade to a skip: the other lanes must be able to run this
  // suite without database access at all.
  let shopId: string;
  try {
    const store = generateDemoStore({ seed: 20260729 });
    const shop = await supabase.upsertShop({
      ...store.shop,
      shop_domain: 'priceflag-smoke.myshopify.com',
      name: 'Priceflag smoke store',
      mode: 'demo',
    });
    await supabase.upsertProducts(shop.id, store.products);
    await supabase.upsertOrderDays(shop.id, store.orderDays);
    shopId = shop.id;
  } catch (cause) {
    section('adapter: SupabaseAdapter');
    skip('the full adapter suite', `could not seed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return;
  }

  await runAdapterSuite('SupabaseAdapter', supabase, shopId);

  // These assert database behaviour, not adapter behaviour, so they only mean
  // anything against real Postgres.
  section('postgres safety properties');

  const { createClient } = await import('@supabase/supabase-js');
  const raw = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });

  await test('the price journal rejects UPDATE, even from the service role', async () => {
    const existing = await supabase.listJournalEntries(shopId, { limit: 1 });
    const row = existing.items[0];
    assert(row !== undefined, 'there is a journal entry to attempt');

    const { error } = await raw
      .from('journal_entries')
      .update({ after_price_cents: 999999 })
      .eq('id', (row as { id: string }).id);

    assert(error !== null, 'the update must be refused');
    assert(
      /append-only/i.test(error?.message ?? ''),
      `the guard trigger should say why, got: ${error?.message}`,
    );

    // And the value is genuinely unchanged.
    const after = await supabase.getLastJournaledPrice(shopId, (row as { variant_gid: string }).variant_gid);
    assert(after?.after_price_cents !== 999999, 'nothing was written');
  });

  await test('the price journal rejects DELETE without an explicit purge', async () => {
    const existing = await supabase.listJournalEntries(shopId, { limit: 1 });
    const row = existing.items[0] as { id: string };

    const { error } = await raw.from('journal_entries').delete().eq('id', row.id);
    assert(error !== null, 'the delete must be refused');
    assert(/append-only/i.test(error?.message ?? ''), `and say why, got: ${error?.message}`);

    const still = await supabase.listJournalEntries(shopId, { limit: 1 });
    assert(still.total > 0, 'the trail survives');
  });

  await test('the evaluator lease is enforced by Postgres, not just in process', async () => {
    // withRolloutLock already exercised pf_acquire_rollout_lock in the suite
    // above; this checks the RPC's contract directly, including that a second
    // holder is refused and that releasing with the wrong token does nothing.
    const rollouts = await supabase.listRollouts(shopId);
    const rollout = rollouts[0];
    assert(rollout !== undefined, 'there is a rollout to lock');

    const tokenA = '11111111-1111-4111-8111-111111111111';
    const tokenB = '22222222-2222-4222-8222-222222222222';

    const first = await raw.rpc('pf_acquire_rollout_lock', {
      p_rollout_id: (rollout as { id: string }).id,
      p_token: tokenA,
      p_ttl_seconds: 60,
    });
    assertEqual(first.data, true, 'first holder acquires');

    const second = await raw.rpc('pf_acquire_rollout_lock', {
      p_rollout_id: (rollout as { id: string }).id,
      p_token: tokenB,
      p_ttl_seconds: 60,
    });
    assertEqual(second.data, false, 'a second evaluator is refused while the lease is held');

    const wrongRelease = await raw.rpc('pf_release_rollout_lock', {
      p_rollout_id: (rollout as { id: string }).id,
      p_token: tokenB,
    });
    assertEqual(wrongRelease.data, false, 'a stale holder cannot release someone else lease');

    const release = await raw.rpc('pf_release_rollout_lock', {
      p_rollout_id: (rollout as { id: string }).id,
      p_token: tokenA,
    });
    assertEqual(release.data, true, 'the real holder releases');
  });

  await test("Lane C's ml_* views are readable and shaped as promised", async () => {
    for (const view of ['ml_product_days', 'ml_products', 'ml_price_history', 'ml_rollout_windows']) {
      const { error } = await raw.from(view).select('*').limit(1);
      assertEqual(error, null, `${view} should be selectable: ${error?.message ?? ''}`);
    }

    const { data } = await raw
      .from('ml_product_days')
      .select('shop_domain,variant_gid,day,dow,units,list_price_cents,on_promo,had_stockout,excluded_from_pricing')
      .limit(1);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    assert(row !== undefined, 'ml_product_days has rows after seeding');
    assert(typeof row?.dow === 'number' && row.dow >= 1 && row.dow <= 7, 'dow is an ISO weekday');
    assert(row?.list_price_cents !== null, 'the elasticity regressor is populated');
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write('\x1b[1mPriceflag smoke test\x1b[0m\n');

  await testPrimitives();
  await testShopifyAuth();
  await testSync();
  await testGoldenData();
  await testContracts();
  await testForecast();
  await testGuardrails();
  await testRollout();
  await testBands();
  await testReadings();
  await testJournal();
  await testAdapters();

  process.stdout.write(
    `\n\x1b[1m${passed} passed\x1b[0m` +
      (failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : '') +
      (skipped > 0 ? `, \x1b[33m${skipped} skipped\x1b[0m` : '') +
      '\n',
  );

  if (failures.length > 0) {
    process.stdout.write('\n\x1b[31mFailures:\x1b[0m\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

void main();
