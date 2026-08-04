/**
 * Reading and writing variant prices.
 *
 * `productVariantsBulkUpdate` is scoped to **one product**. A rollout stage that
 * touches twelve products is therefore twelve mutations, and the eighth can fail
 * while the first seven have already been applied. That is the central hazard of
 * this file, and it is handled in two layers:
 *
 *   1. **Within a product** — `allowPartialUpdates: false` makes Shopify apply
 *      every variant in the call or none of them. Passed explicitly rather than
 *      relying on the default, because the default is not a promise.
 *   2. **Across products** — cannot be made atomic by any API Shopify offers, so
 *      `lib/pricing/writer.ts` reconciles instead: the database records what
 *      *should* be live, and every subsequent tick re-applies whatever is not.
 *
 * Verified against the live 2026-07 schema by introspection.
 */

import { assertNoUserErrors, ShopifyApiError, type AdminGraphqlClient, type GraphqlUserError } from './client';
import { formatCentsAsShopifyMoney, parseMoneyToCents, type Cents } from '../money';

export const VARIANT_PRICES_QUERY = /* GraphQL */ `
  query PriceflagVariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        compareAtPrice
        product {
          id
        }
      }
    }
  }
`;

export const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation PriceflagVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants {
        id
        price
        compareAtPrice
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

export interface LivePrice {
  variantGid: string;
  productGid: string;
  priceCents: Cents;
  compareAtCents: Cents | null;
}

/** What Shopify currently shows. The authority for compare-before-write. */
export async function readLivePrices(
  client: AdminGraphqlClient,
  variantGids: readonly string[],
): Promise<Map<string, LivePrice>> {
  const live = new Map<string, LivePrice>();
  if (variantGids.length === 0) return live;

  // `nodes` accepts at most 250 ids.
  for (let i = 0; i < variantGids.length; i += 250) {
    const chunk = variantGids.slice(i, i + 250);
    const data = await client.request<{
      nodes: ({ id: string; price: string; compareAtPrice: string | null; product: { id: string } } | null)[];
    }>(VARIANT_PRICES_QUERY, { ids: chunk });

    for (const node of data.nodes) {
      // A null node means the variant no longer exists. Absent from the map, so
      // callers see "unknown" rather than a fabricated price.
      if (node === null) continue;
      live.set(node.id, {
        variantGid: node.id,
        productGid: node.product.id,
        priceCents: parseMoneyToCents(node.price),
        compareAtCents: node.compareAtPrice === null ? null : parseMoneyToCents(node.compareAtPrice),
      });
    }
  }
  return live;
}

export interface PriceWrite {
  variantGid: string;
  priceCents: Cents;
  /** `null` clears compare-at (R13). `undefined` leaves it untouched. */
  compareAtCents?: Cents | null;
}

export interface BulkWriteResult {
  productGid: string;
  applied: { variantGid: string; priceCents: Cents; compareAtCents: Cents | null }[];
  userErrors: GraphqlUserError[];
}

/**
 * Write prices for the variants of a single product, atomically.
 *
 * Throws on `userErrors` rather than returning them quietly: Shopify reports
 * business-rule failures with HTTP 200, and treating that as success is the
 * easiest possible way to believe a price was written when it was not.
 */
export async function writeProductVariantPrices(
  client: AdminGraphqlClient,
  productGid: string,
  writes: readonly PriceWrite[],
): Promise<BulkWriteResult> {
  if (writes.length === 0) return { productGid, applied: [], userErrors: [] };

  const requested = new Map<string, PriceWrite>();
  for (const write of writes) {
    if (requested.has(write.variantGid)) {
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) was given duplicate variant ${write.variantGid}.`,
      );
    }
    requested.set(write.variantGid, write);
  }

  const variants = writes.map((write) => {
    const input: Record<string, unknown> = {
      id: write.variantGid,
      price: formatCentsAsShopifyMoney(write.priceCents),
    };
    if (write.compareAtCents !== undefined) {
      input.compareAtPrice = write.compareAtCents === null ? null : formatCentsAsShopifyMoney(write.compareAtCents);
    }
    return input;
  });

  const data = await client.request<{
    productVariantsBulkUpdate?: {
      productVariants: ({ id: string; price: string; compareAtPrice: string | null } | null)[] | null;
      userErrors?: GraphqlUserError[];
    } | null;
  }>(VARIANTS_BULK_UPDATE, { productId: productGid, variants });

  const payload = data.productVariantsBulkUpdate;
  assertNoUserErrors(payload?.userErrors, `productVariantsBulkUpdate(${productGid})`);

  if (payload === null || payload === undefined || !Array.isArray(payload.productVariants)) {
    throw new ShopifyApiError(
      'invalid_response',
      `productVariantsBulkUpdate(${productGid}) returned no variant acknowledgement. The write will be reconciled from live Shopify state.`,
    );
  }
  if (payload.productVariants.length !== writes.length) {
    throw new ShopifyApiError(
      'invalid_response',
      `productVariantsBulkUpdate(${productGid}) acknowledged ${payload.productVariants.length} of ${writes.length} requested variants. The write will be reconciled from live Shopify state.`,
      payload.productVariants,
    );
  }

  const seen = new Set<string>();
  const applied: BulkWriteResult['applied'] = [];
  for (const variant of payload.productVariants) {
    if (
      variant === null ||
      typeof variant.id !== 'string' ||
      typeof variant.price !== 'string' ||
      (variant.compareAtPrice !== null && typeof variant.compareAtPrice !== 'string')
    ) {
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) returned a malformed variant acknowledgement. The write will be reconciled from live Shopify state.`,
        variant,
      );
    }

    const expected = requested.get(variant.id);
    if (expected === undefined || seen.has(variant.id)) {
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) acknowledged an unexpected or duplicate variant ${variant.id}. The write will be reconciled from live Shopify state.`,
        variant,
      );
    }

    let priceCents: Cents;
    let compareAtCents: Cents | null;
    try {
      priceCents = parseMoneyToCents(variant.price);
      compareAtCents = variant.compareAtPrice === null ? null : parseMoneyToCents(variant.compareAtPrice);
    } catch (cause) {
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) returned invalid money for ${variant.id}. The write will be reconciled from live Shopify state.`,
        cause,
      );
    }

    if (priceCents !== expected.priceCents) {
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) acknowledged ${variant.id} at ${variant.price}, not the requested ${formatCentsAsShopifyMoney(expected.priceCents)}. The write will be reconciled from live Shopify state.`,
        variant,
      );
    }
    if (expected.compareAtCents !== undefined && compareAtCents !== expected.compareAtCents) {
      const expectedCompareAt =
        expected.compareAtCents === null ? 'null' : formatCentsAsShopifyMoney(expected.compareAtCents);
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) acknowledged ${variant.id} with compare-at ${variant.compareAtPrice ?? 'null'}, not the requested ${expectedCompareAt}. The write will be reconciled from live Shopify state.`,
        variant,
      );
    }

    seen.add(variant.id);
    applied.push({ variantGid: variant.id, priceCents, compareAtCents });
  }

  for (const variantGid of requested.keys()) {
    if (!seen.has(variantGid)) {
      throw new ShopifyApiError(
        'invalid_response',
        `productVariantsBulkUpdate(${productGid}) did not acknowledge requested variant ${variantGid}. The write will be reconciled from live Shopify state.`,
      );
    }
  }

  return {
    productGid,
    applied,
    userErrors: payload.userErrors ?? [],
  };
}
