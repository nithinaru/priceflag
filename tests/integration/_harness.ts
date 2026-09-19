/**
 * Lane D integration-test harness.
 *
 * Deliberately dependency-free, like `scripts/smoke.ts`: one command, no
 * framework, runnable on a machine with nothing configured. What it adds over
 * the smoke test is an *adversarial* posture — a programmable fake Shopify that
 * can throttle, time out, half-fail, and lie with HTTP 200 + userErrors, plus a
 * seeded RNG so every fuzz failure is replayable from its printed seed.
 *
 * Nothing in here may import a product invariant in order to satisfy it. When a
 * test fails, the product is wrong until proven otherwise.
 */

import { randomUUID } from 'node:crypto';

import type { Cents } from '../../lib/money';
import type { Cents as C } from '../../lib/money';
import type { DayString } from '../../lib/dates';
import type { Guardrails } from '../../lib/contracts';
import { CONTRACT_VERSION } from '../../lib/contracts';
import type { Product, Rollout, RolloutCreate, Shop } from '../../lib/types';

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export interface Failure {
  suite: string;
  test: string;
  message: string;
}

const state = {
  suite: '<none>',
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [] as Failure[],
};

export function section(name: string): void {
  state.suite = name;
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n`);
}

export async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    state.passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } catch (cause) {
    state.failed += 1;
    const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    state.failures.push({ suite: state.suite, test: name, message });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n    \x1b[31m${message.split('\n')[0]}\x1b[0m\n`);
  }
}

export function skip(name: string, why: string): void {
  state.skipped += 1;
  process.stdout.write(`  \x1b[33m∘\x1b[0m ${name} \x1b[2m(${why})\x1b[0m\n`);
}

export function summary(): number {
  process.stdout.write('\n');
  if (state.failures.length > 0) {
    process.stdout.write(`\x1b[1m\x1b[31mFAILURES\x1b[0m\n`);
    for (const failure of state.failures) {
      process.stdout.write(`\n  \x1b[31m${failure.suite} › ${failure.test}\x1b[0m\n`);
      for (const line of failure.message.split('\n').slice(0, 6)) {
        process.stdout.write(`    ${line}\n`);
      }
    }
    process.stdout.write('\n');
  }
  const parts = [`\x1b[32m${state.passed} passed\x1b[0m`];
  if (state.failed > 0) parts.push(`\x1b[31m${state.failed} failed\x1b[0m`);
  if (state.skipped > 0) parts.push(`\x1b[33m${state.skipped} skipped\x1b[0m`);
  process.stdout.write(`\x1b[1m${parts.join(', ')}\x1b[0m\n`);
  return state.failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}\n      expected: ${String(expected)}\n      actual:   ${String(actual)}`);
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n      expected: ${b}\n      actual:   ${a}`);
}

export async function assertThrows(fn: () => unknown, message: string): Promise<Error> {
  try {
    await fn();
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  throw new Error(`${message} — expected a throw, got none`);
}

/** Assert an integer that is genuinely an integer, not a float that prints like one. */
export function assertExactCents(actual: unknown, expected: Cents, message: string): void {
  if (typeof actual !== 'number' || !Number.isInteger(actual)) {
    throw new Error(`${message} — ${String(actual)} is not an integer number of cents`);
  }
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// seeded RNG — every fuzz failure is replayable from its printed seed
// ---------------------------------------------------------------------------

/** mulberry32, matching `lib/demo/generator.ts` so failures reproduce identically. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

export function intBetween(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

// ---------------------------------------------------------------------------
// the programmable fake Shopify — lives in lib/demo so the founder lab can use it
// ---------------------------------------------------------------------------

export { FakeShopify } from '../../lib/demo/fake-shopify';
export type { FaultKind, FaultPlan, WriteLogEntry } from '../../lib/demo/fake-shopify';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ISO = '2026-07-01T00:00:00.000Z';

export function makeShop(overrides: Partial<Shop> = {}): Shop {
  return {
    id: 'shop_test',
    shop_domain: 'lane-d-test.myshopify.com',
    name: 'Lane D Test Store',
    email: null,
    access_token_enc: null,
    scopes: 'read_products,write_products,read_orders',
    api_version: '2026-07',
    currency: 'USD',
    timezone: 'America/New_York',
    plan_name: null,
    mode: 'demo',
    kill_switch_engaged_at: null,
    kill_switch_reason: null,
    notify_emails: [],
    installed_at: ISO,
    uninstalled_at: null,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
}

export interface ProductSpec {
  priceCents: Cents;
  compareAtCents?: Cents | null;
  cogsCents?: Cents | null;
  giftCard?: boolean;
  subscription?: boolean;
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  /** Put several variants under one product gid to exercise the bulk-update grouping. */
  productIndex?: number;
}

export function makeProduct(index: number, spec: ProductSpec, shopId = 'shop_test'): Product {
  const productIndex = spec.productIndex ?? index;
  return {
    id: `prod_${index}`,
    shop_id: shopId,
    product_gid: `gid://shopify/Product/${1000 + productIndex}`,
    variant_gid: `gid://shopify/ProductVariant/${2000 + index}`,
    inventory_item_gid: `gid://shopify/InventoryItem/${3000 + index}`,
    title: `Test Product ${index}`,
    variant_title: null,
    sku: `SKU-${index}`,
    vendor: 'Lane D',
    product_type: 'Test',
    tags: [],
    image_url: null,
    status: spec.status ?? 'ACTIVE',
    price_cents: spec.priceCents,
    compare_at_cents: spec.compareAtCents ?? null,
    currency: 'USD',
    cogs_cents: spec.cogsCents === undefined ? Math.round(spec.priceCents * 0.4) : spec.cogsCents,
    cogs_source: spec.cogsCents === null ? 'none' : 'shopify',
    cogs_updated_at: ISO,
    is_gift_card: spec.giftCard ?? false,
    requires_selling_plan: spec.subscription ?? false,
    has_selling_plan: spec.subscription ?? false,
    inventory_quantity: 100,
    available_for_sale: true,
    first_synced_at: ISO,
    last_synced_at: ISO,
    deleted_at: null,
    created_at: ISO,
    updated_at: ISO,
  };
}

export function makeGuardrails(overrides: Partial<Guardrails> = {}): Guardrails {
  return {
    contract_version: CONTRACT_VERSION,
    auto_rollback: true,
    rules: [
      {
        id: 'units_drop',
        metric: 'units',
        comparison: 'below_expected_pct',
        threshold_pct: 30,
        consecutive_days: 2,
        scope: 'rollout',
        action: 'rollback_all',
        sentence: 'If daily units fall more than 30% below expected for 2 days in a row, revert everything automatically.',
      },
    ],
    ...overrides,
  } as Guardrails;
}

export function makeRolloutCreate(overrides: Partial<RolloutCreate> = {}): RolloutCreate {
  return {
    shop_id: 'shop_test',
    name: 'Lane D test rollout',
    status: 'draft',
    change_type: 'percent',
    change_pct: 10,
    change_absolute_cents: null,
    rounding: 'none',
    horizon_days: 90,
    stages: [
      { index: 0, fraction: 0.25, hold_days: 3 },
      { index: 1, fraction: 0.5, hold_days: 3 },
      { index: 2, fraction: 1, hold_days: 3 },
    ],
    current_stage: -1,
    stage_entered_at: null,
    guardrails: makeGuardrails(),
    forecast: null,
    scheduled_start_at: null,
    started_at: null,
    ended_at: null,
    ended_reason: null,
    paused_reason: null,
    notify_emails: [],
    created_by: 'lane-d',
    ...overrides,
  } as RolloutCreate;
}

/** A notifier that records instead of sending. */
export function recordingNotifier(): { calls: unknown[]; notifier: (payload: unknown) => Promise<void> } {
  const calls: unknown[] = [];
  return {
    calls,
    notifier: async (payload: unknown) => {
      calls.push(payload);
    },
  };
}

export function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export type { C as CentsAlias, Rollout, DayString };
