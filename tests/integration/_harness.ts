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

import type { AdminGraphqlClient } from '../../lib/shopify/client';
import { ShopifyApiError } from '../../lib/shopify/client';
import { formatCentsAsShopifyMoney, parseMoneyToCents, type Cents } from '../../lib/money';
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
// the programmable fake Shopify
// ---------------------------------------------------------------------------

export type FaultKind =
  | 'none'
  /** HTTP 429 with Retry-After — the throttle. */
  | 'throttle'
  /** HTTP 500. */
  | 'server_error'
  /** Socket timeout: the write LANDS in the store but the caller never hears back. */
  | 'timeout_after_write'
  /** Socket timeout before the store is touched. */
  | 'timeout_before_write'
  /** HTTP 200 carrying userErrors — the quiet lie. */
  | 'user_errors'
  /** Shopify mutates the store but returns no mutation acknowledgement. */
  | 'ack_null'
  /** Shopify mutates the store but omits the mutation payload entirely. */
  | 'ack_missing'
  /** Shopify mutates the store but acknowledges only part of the request. */
  | 'ack_partial'
  /** Shopify mutates the store but acknowledges a different variant id. */
  | 'ack_wrong_id'
  /** Shopify mutates the store but acknowledges an unrequested extra variant. */
  | 'ack_extra'
  /** Shopify mutates the store but acknowledges a different price. */
  | 'ack_wrong_price'
  /** Shopify mutates the store but acknowledges a different compare-at value. */
  | 'ack_wrong_compare_at';

export interface FaultPlan {
  kind: FaultKind;
  /** Fire only on these product gids. Empty = all. */
  products?: string[];
  /** Fire only on the Nth matching write (1-based). 0 = every time. */
  onCall?: number;
  /** Keep failing after the first fire. */
  persistent?: boolean;
}

export interface WriteLogEntry {
  productGid: string;
  variantGids: string[];
  prices: Cents[];
  outcome: 'applied' | FaultKind;
}

/**
 * A fake Shopify store: real price state, programmable failures, and a complete
 * write log so a test can assert *exactly which variants were touched* (R22).
 */
export class FakeShopify {
  readonly prices = new Map<string, { productGid: string; price: Cents; compareAt: Cents | null }>();
  readonly writeLog: WriteLogEntry[] = [];
  readonly readLog: string[][] = [];

  private fault: FaultPlan = { kind: 'none' };
  private faultCalls = 0;

  /** Variants the merchant deleted in Shopify mid-rollout. */
  readonly deleted = new Set<string>();

  seed(products: readonly Product[]): this {
    for (const product of products) {
      this.prices.set(product.variant_gid, {
        productGid: product.product_gid,
        price: product.price_cents,
        compareAt: product.compare_at_cents,
      });
    }
    return this;
  }

  setPrice(variantGid: string, priceCents: Cents, compareAt: Cents | null = null): void {
    const existing = this.prices.get(variantGid);
    this.prices.set(variantGid, {
      productGid: existing?.productGid ?? 'gid://shopify/Product/unknown',
      price: priceCents,
      compareAt,
    });
  }

  priceOf(variantGid: string): Cents | null {
    return this.prices.get(variantGid)?.price ?? null;
  }

  compareAtOf(variantGid: string): Cents | null {
    return this.prices.get(variantGid)?.compareAt ?? null;
  }

  deleteVariant(variantGid: string): void {
    this.deleted.add(variantGid);
    this.prices.delete(variantGid);
  }

  program(fault: FaultPlan): this {
    this.fault = fault;
    this.faultCalls = 0;
    return this;
  }

  clearFaults(): this {
    this.fault = { kind: 'none' };
    this.faultCalls = 0;
    return this;
  }

  /** Every variant gid this fake was ever asked to write. */
  writtenVariants(): Set<string> {
    const seen = new Set<string>();
    for (const entry of this.writeLog) for (const gid of entry.variantGids) seen.add(gid);
    return seen;
  }

  /** Variants actually mutated (excludes writes that failed). */
  mutatedVariants(): Set<string> {
    const seen = new Set<string>();
    for (const entry of this.writeLog) {
      if (entry.outcome !== 'applied') continue;
      for (const gid of entry.variantGids) seen.add(gid);
    }
    return seen;
  }

  private shouldFail(productGid: string): FaultKind {
    if (this.fault.kind === 'none') return 'none';
    if (this.fault.products && this.fault.products.length > 0 && !this.fault.products.includes(productGid)) {
      return 'none';
    }
    this.faultCalls += 1;
    const target = this.fault.onCall ?? 0;
    if (target === 0) return this.fault.kind;
    if (this.faultCalls === target) return this.fault.kind;
    if (this.fault.persistent && this.faultCalls > target) return this.fault.kind;
    return 'none';
  }

  /** The AdminGraphqlClient surface the writer actually uses. */
  asClient(): AdminGraphqlClient {
    return { request: (query: string, variables: Record<string, unknown> = {}) => this.request(query, variables) } as unknown as AdminGraphqlClient;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    if (query.includes('PriceflagVariantPrices')) {
      const ids = (variables.ids as string[]) ?? [];
      this.readLog.push([...ids]);
      return {
        nodes: ids.map((id) => {
          const row = this.prices.get(id);
          if (row === undefined) return null; // deleted in Shopify
          return {
            id,
            price: formatCentsAsShopifyMoney(row.price),
            compareAtPrice: row.compareAt === null ? null : formatCentsAsShopifyMoney(row.compareAt),
            product: { id: row.productGid },
          };
        }),
      };
    }

    if (query.includes('PriceflagVariantsBulkUpdate')) {
      const productGid = variables.productId as string;
      const inputs = (variables.variants as { id: string; price: string; compareAtPrice?: string | null }[]) ?? [];
      const variantGids = inputs.map((input) => input.id);
      const prices = inputs.map((input) => parseMoneyToCents(input.price));

      const fault = this.shouldFail(productGid);

      const apply = (): void => {
        for (const input of inputs) {
          const existing = this.prices.get(input.id);
          this.prices.set(input.id, {
            productGid,
            price: parseMoneyToCents(input.price),
            compareAt:
              input.compareAtPrice === undefined
                ? (existing?.compareAt ?? null)
                : input.compareAtPrice === null
                  ? null
                  : parseMoneyToCents(input.compareAtPrice),
          });
        }
      };

      const acknowledgements = inputs.map((input) => ({
        id: input.id,
        price: input.price,
        compareAtPrice: input.compareAtPrice ?? null,
      }));

      switch (fault) {
        case 'throttle':
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'throttle' });
          throw new ShopifyApiError('throttled', 'Throttled by Shopify.', null, 429);
        case 'server_error':
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'server_error' });
          throw new ShopifyApiError('http_error', 'Shopify returned 500.', null, 500);
        case 'timeout_before_write':
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'timeout_before_write' });
          throw new Error('socket hang up');
        case 'timeout_after_write':
          // The dangerous one: the store IS mutated, the caller never learns.
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'timeout_after_write' });
          throw new Error('socket hang up');
        case 'user_errors':
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'user_errors' });
          return {
            productVariantsBulkUpdate: {
              productVariants: [],
              userErrors: [{ code: 'INVALID', field: ['price'], message: 'Price must be greater than or equal to 0' }],
            },
          };
        case 'ack_null':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_null' });
          return {
            productVariantsBulkUpdate: { productVariants: null, userErrors: [] },
          };
        case 'ack_missing':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_missing' });
          return {};
        case 'ack_partial':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_partial' });
          return {
            productVariantsBulkUpdate: { productVariants: acknowledgements.slice(0, -1), userErrors: [] },
          };
        case 'ack_wrong_id':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_wrong_id' });
          return {
            productVariantsBulkUpdate: {
              productVariants: acknowledgements.map((item, index) =>
                index === 0 ? { ...item, id: `${item.id}-unexpected` } : item,
              ),
              userErrors: [],
            },
          };
        case 'ack_extra':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_extra' });
          return {
            productVariantsBulkUpdate: {
              productVariants: [
                ...acknowledgements,
                { id: 'gid://shopify/ProductVariant/unrequested', price: '12.34', compareAtPrice: null },
              ],
              userErrors: [],
            },
          };
        case 'ack_wrong_price':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_wrong_price' });
          return {
            productVariantsBulkUpdate: {
              productVariants: acknowledgements.map((item, index) =>
                index === 0 ? { ...item, price: '0.01' } : item,
              ),
              userErrors: [],
            },
          };
        case 'ack_wrong_compare_at':
          apply();
          this.writeLog.push({ productGid, variantGids, prices, outcome: 'ack_wrong_compare_at' });
          return {
            productVariantsBulkUpdate: {
              productVariants: acknowledgements.map((item, index) =>
                index === 0
                  ? { ...item, compareAtPrice: item.compareAtPrice === null ? '999.99' : null }
                  : item,
              ),
              userErrors: [],
            },
          };
        default:
          break;
      }

      apply();
      this.writeLog.push({ productGid, variantGids, prices, outcome: 'applied' });
      return {
        productVariantsBulkUpdate: {
          productVariants: acknowledgements,
          userErrors: [],
        },
      };
    }

    throw new Error(`FakeShopify received an unexpected query:\n${query.slice(0, 120)}`);
  }
}

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
