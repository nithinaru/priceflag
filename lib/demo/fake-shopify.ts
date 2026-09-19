/**
 * A fake Shopify store: real price state, programmable failures, and a complete
 * write log so a caller can assert *exactly which variants were touched* (R22).
 *
 * Lives in lib/ rather than tests/ because two things drive the real price
 * writer against it: the adversarial integration suite, and the founder lab's
 * rollout simulator. One fake, so a failure mode the lab can show is one the
 * tests already cover.
 */

import type { AdminGraphqlClient } from '../shopify/client';
import { ShopifyApiError } from '../shopify/client';
import { formatCentsAsShopifyMoney, parseMoneyToCents, type Cents } from '../money';
import type { Product } from '../types';

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
