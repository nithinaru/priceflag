/**
 * Catalog sync: Shopify products and variants → the `products` table.
 *
 * The catalog is deliberately the first thing to land, because it is usable
 * immediately: a merchant can browse, add costs and build a proposal while 180
 * days of order history is still downloading (R2/R24).
 *
 * Re-running is a no-op for unchanged rows — every write is an upsert keyed on
 * `(shop_id, variant_gid)`, and variants that have disappeared are marked
 * `deleted_at` rather than removed, because the price journal still refers to them.
 */

import type { StoreAdapter } from '../adapters/types';
import { parseMoneyToCents, type Cents } from '../money';
import type { ProductUpsert } from '../types';
import type { AdminGraphqlClient } from '../shopify/client';
import { PRODUCTS_PAGE, PRODUCT_VARIANTS_PAGE } from '../shopify/queries';

const PRODUCTS_PER_PAGE = 50;
const VARIANTS_PER_PAGE = 100;

interface GqlMoney {
  amount: string;
}

interface GqlVariant {
  id: string;
  title: string | null;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  availableForSale: boolean;
  sellingPlanGroupsCount: { count: number } | null;
  inventoryItem: { id: string; unitCost: GqlMoney | null } | null;
}

interface GqlProduct {
  id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  vendor: string | null;
  productType: string | null;
  tags: string[];
  isGiftCard: boolean;
  /** Shopify's own last-modified time, the version marker for out-of-order webhooks. */
  updatedAt?: string | null;
  requiresSellingPlan: boolean;
  sellingPlanGroupsCount: { count: number } | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  variants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GqlVariant[];
  };
}

interface ProductsPage {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GqlProduct[];
  };
}

export interface ProductSyncResult {
  productsSeen: number;
  variantsWritten: number;
  variantsDeleted: number;
  withCost: number;
  withoutCost: number;
  excluded: number;
  currency: string;
}

export interface ProductSyncOptions {
  onProgress?: (written: number) => void | Promise<void>;
  /** Mark variants that Shopify no longer returns as deleted. */
  reconcileDeletions?: boolean;
}

function variantToUpsert(product: GqlProduct, variant: GqlVariant, currency: string): ProductUpsert {
  const unitCost = variant.inventoryItem?.unitCost?.amount;
  // A cost of exactly zero is almost always "never filled in" rather than a genuinely
  // free product, and treating it as known would produce a 100%-margin forecast.
  const cogsCents: Cents | null =
    unitCost === undefined || unitCost === null ? null : parseMoneyToCents(unitCost) || null;

  return {
    product_gid: product.id,
    variant_gid: variant.id,
    inventory_item_gid: variant.inventoryItem?.id ?? null,
    title: product.title,
    variant_title: variant.title,
    sku: variant.sku,
    vendor: product.vendor,
    product_type: product.productType,
    tags: product.tags ?? [],
    image_url: product.featuredMedia?.preview?.image?.url ?? null,
    status: product.status,
    price_cents: parseMoneyToCents(variant.price),
    compare_at_cents: variant.compareAtPrice === null ? null : parseMoneyToCents(variant.compareAtPrice),
    currency,
    cogs_cents: cogsCents,
    cogs_source: cogsCents === null ? 'none' : 'shopify',
    cogs_updated_at: cogsCents === null ? null : new Date().toISOString(),
    is_gift_card: product.isGiftCard,
    requires_selling_plan: product.requiresSellingPlan,
    // Either level can carry a selling plan; both mean "subscription", which v1
    // never reprices (R22).
    has_selling_plan:
      (product.sellingPlanGroupsCount?.count ?? 0) > 0 || (variant.sellingPlanGroupsCount?.count ?? 0) > 0,
    inventory_quantity: variant.inventoryQuantity,
    available_for_sale: variant.availableForSale,
    shopify_updated_at: product.updatedAt ?? null,
  };
}

export async function syncProducts(
  client: AdminGraphqlClient,
  adapter: StoreAdapter,
  shopId: string,
  currency: string,
  options: ProductSyncOptions = {},
): Promise<ProductSyncResult> {
  let cursor: string | null = null;
  let productsSeen = 0;
  let variantsWritten = 0;
  let withCost = 0;
  let excluded = 0;

  const seenVariantGids = new Set<string>();

  for (;;) {
    const page: ProductsPage = await client.request<ProductsPage>(PRODUCTS_PAGE, {
      first: PRODUCTS_PER_PAGE,
      cursor,
      variantsFirst: VARIANTS_PER_PAGE,
    });

    const batch: ProductUpsert[] = [];

    for (const product of page.products.nodes) {
      productsSeen += 1;
      const variants = [...product.variants.nodes];

      // A product with more variants than one page holds is rare but real, and
      // silently syncing only the first 100 would leave prices we would later
      // fail to roll back.
      let variantCursor = product.variants.pageInfo.endCursor;
      let hasMore = product.variants.pageInfo.hasNextPage;
      while (hasMore) {
        const more = await client.request<{
          product: { variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlVariant[] } } | null;
        }>(PRODUCT_VARIANTS_PAGE, { id: product.id, first: VARIANTS_PER_PAGE, cursor: variantCursor });

        const connection = more.product?.variants;
        if (!connection) break;
        variants.push(...connection.nodes);
        hasMore = connection.pageInfo.hasNextPage;
        variantCursor = connection.pageInfo.endCursor;
      }

      for (const variant of variants) {
        const row = variantToUpsert(product, variant, currency);
        seenVariantGids.add(variant.id);
        if (row.cogs_cents !== null) withCost += 1;
        if (row.is_gift_card || row.has_selling_plan || row.requires_selling_plan || row.status !== 'ACTIVE') {
          excluded += 1;
        }
        batch.push(row);
      }
    }

    if (batch.length > 0) {
      await adapter.upsertProducts(shopId, batch);
      variantsWritten += batch.length;
      await options.onProgress?.(variantsWritten);
    }

    if (!page.products.pageInfo.hasNextPage) break;
    cursor = page.products.pageInfo.endCursor;
  }

  let variantsDeleted = 0;
  if (options.reconcileDeletions !== false) {
    const stored = await adapter.listProducts(shopId, {});
    const gone = stored.items
      .filter((product) => !seenVariantGids.has(product.variant_gid))
      .map((product) => product.variant_gid);
    if (gone.length > 0) variantsDeleted = await adapter.markProductsDeleted(shopId, gone);
  }

  return {
    productsSeen,
    variantsWritten,
    variantsDeleted,
    withCost,
    withoutCost: variantsWritten - withCost,
    excluded,
    currency,
  };
}
