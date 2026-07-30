/**
 * The sync pipeline.
 *
 * Order matters and is a product decision, not an implementation detail: shop
 * settings first (the timezone decides what a "day" is for everything that
 * follows), then the catalog, then order history. The catalog is marked ready as
 * soon as it lands so onboarding can say "you can start choosing products now"
 * while history is still downloading (R24).
 *
 * Re-running is safe. Every write is an upsert keyed the way the table is keyed,
 * so a second sync converges rather than duplicating.
 */

import { DEFAULT_HISTORY_DAYS } from '../contracts';
import type { SyncProgress } from '../contracts';
import { CONTRACT_VERSION } from '../contracts';
import { addDays, isValidTimeZone, today, type DayString } from '../dates';
import type { StoreAdapter } from '../adapters/types';
import type { Cents } from '../money';
import type { Shop, SyncRun } from '../types';
import { AdminGraphqlClient } from '../shopify/client';
import { ShopifyApiError } from '../shopify/client';
import { credentialsFromShop } from '../shopify/credentials';
import { COUNTS, SHOP_INFO } from '../shopify/queries';
import { syncProducts, type ProductSyncResult } from './products';
import { syncOrderDays, type OrderSyncResult } from './orders';

export interface SyncOptions {
  historyDays?: number;
  /** Skip the order phase — used by the catalog-only refresh after a webhook. */
  catalogOnly?: boolean;
  client?: AdminGraphqlClient;
  now?: Date;
}

export interface SyncOutcome {
  syncRunId: string;
  shop: Shop;
  products: ProductSyncResult;
  orders: OrderSyncResult | null;
  /** Set when the run ended in `error`. */
  error: { code: string; message: string; retryable: boolean } | null;
}

/**
 * Map a Shopify failure onto the sync_progress error contract, in language a
 * merchant can act on. "Shopify returned HTTP 401" is not an action; "reconnect
 * the app" is.
 */
function describeError(cause: unknown): { code: SyncErrorCode; message: string; retryable: boolean } {
  if (cause instanceof ShopifyApiError) {
    if (cause.status === 401 || cause.status === 403) {
      return {
        code: 'auth_expired',
        message: 'Priceflag lost access to your store. Reconnect the app and the sync will pick up where it left off.',
        retryable: false,
      };
    }
    if (cause.code === 'throttled') {
      return {
        code: 'rate_limited',
        message: 'Shopify is asking us to slow down. The sync will continue automatically in a few minutes.',
        retryable: true,
      };
    }
    if (/access denied|not approved|scope/i.test(cause.message)) {
      return {
        code: 'scope_missing',
        message: 'Priceflag is missing a permission it needs to read your orders. Reconnect the app to grant it.',
        retryable: false,
      };
    }
    return {
      code: 'shopify_error',
      message: 'Shopify returned an error while we were syncing. We will try again shortly.',
      retryable: true,
    };
  }
  return {
    code: 'internal',
    message: 'Something went wrong on our side during the sync. It will retry automatically.',
    retryable: true,
  };
}

type SyncErrorCode = NonNullable<SyncProgress['error']>['code'];

export async function runSync(
  adapter: StoreAdapter,
  shop: Shop,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const now = options.now ?? new Date();
  const historyDays = options.historyDays ?? DEFAULT_HISTORY_DAYS;

  const client = options.client ?? new AdminGraphqlClient(credentialsFromShop(shop));
  const run = await adapter.createSyncRun(shop.id, options.catalogOnly === true ? 'catalog' : 'full');

  let currentShop = shop;
  let products: ProductSyncResult | null = null;
  let orders: OrderSyncResult | null = null;

  try {
    // --- shop settings ----------------------------------------------------
    // The timezone has to be right before anything writes a `day`.
    const info = await client.request<{
      shop: {
        name: string;
        myshopifyDomain: string;
        ianaTimezone: string;
        currencyCode: string;
        contactEmail: string | null;
        plan: { displayName: string } | null;
      };
    }>(SHOP_INFO);

    const timezone = isValidTimeZone(info.shop.ianaTimezone) ? info.shop.ianaTimezone : 'UTC';
    currentShop = await adapter.updateShop(shop.id, {
      name: info.shop.name,
      email: info.shop.contactEmail ?? undefined,
      timezone,
      currency: info.shop.currencyCode,
      plan_name: info.shop.plan?.displayName ?? null,
    });

    const toDay = today(timezone, now);
    const fromDay = addDays(toDay, -(historyDays - 1));

    // --- counts, so progress has a denominator ----------------------------
    let productsTotal: number | null = null;
    let ordersTotal: number | null = null;
    try {
      const counts = await client.request<{
        productsCount: { count: number } | null;
        ordersCount: { count: number; precision: string } | null;
      }>(COUNTS, { ordersQuery: `created_at:>=${fromDay} created_at:<=${toDay}` });
      productsTotal = counts.productsCount?.count ?? null;
      ordersTotal = counts.ordersCount?.count ?? null;
    } catch {
      // A missing count is cosmetic. Never fail a sync over the progress bar.
    }

    await adapter.updateSyncRun(run.id, {
      stage: 'catalog',
      products_total: productsTotal,
      days_target: historyDays,
      message: 'Loading your products…',
    });

    // --- catalog ----------------------------------------------------------
    products = await syncProducts(client, adapter, shop.id, currentShop.currency, {
      onProgress: async (written) => {
        await adapter.updateSyncRun(run.id, {
          products_synced: written,
          message:
            productsTotal === null
              ? `Loaded ${written} products so far…`
              : `Loaded ${written} of about ${productsTotal} products…`,
        });
      },
    });

    const catalogReadyAt = new Date().toISOString();
    await adapter.updateSyncRun(run.id, {
      products_synced: products.variantsWritten,
      products_total: products.variantsWritten,
      catalog_ready_at: catalogReadyAt,
      stage: options.catalogOnly === true ? 'done' : 'history',
      message:
        options.catalogOnly === true
          ? `Loaded ${products.variantsWritten} products.`
          : `Loaded ${products.variantsWritten} products — you can start choosing what to reprice. Now reading ${historyDays} days of order history.`,
    });

    if (options.catalogOnly === true) {
      await adapter.updateSyncRun(run.id, { finished_at: new Date().toISOString(), eta_seconds: 0 });
      return { syncRunId: run.id, shop: currentShop, products, orders: null, error: null };
    }

    // --- order history ----------------------------------------------------
    const listPrices = new Map<string, Cents>();
    const catalog = await adapter.listProducts(shop.id, {});
    for (const product of catalog.items) listPrices.set(product.variant_gid, product.price_cents);

    orders = await syncOrderDays(client, adapter, shop.id, timezone, fromDay, toDay, {
      listPrices,
      onProgress: async (processed) => {
        await adapter.updateSyncRun(run.id, {
          orders_processed: processed,
          message:
            ordersTotal === null || ordersTotal === 0
              ? `Read ${processed} orders so far…`
              : `Read ${processed} of about ${ordersTotal} orders…`,
        });
      },
    });

    const finishedAt = new Date().toISOString();
    await adapter.updateSyncRun(run.id, {
      stage: 'done',
      days_synced: historyDays,
      orders_processed: orders.ordersProcessed,
      history_ready_at: finishedAt,
      finished_at: finishedAt,
      eta_seconds: 0,
      message: summarise(products, orders, historyDays),
    });

    return { syncRunId: run.id, shop: currentShop, products, orders, error: null };
  } catch (cause) {
    const described = describeError(cause);
    await adapter.updateSyncRun(run.id, {
      stage: 'error',
      error_code: described.code,
      error_message: described.message,
      error_retryable: described.retryable,
      finished_at: new Date().toISOString(),
      message: described.message,
    });
    return { syncRunId: run.id, shop: currentShop, products: products ?? emptyProducts(currentShop.currency), orders, error: described };
  }
}

function emptyProducts(currency: string): ProductSyncResult {
  return {
    productsSeen: 0,
    variantsWritten: 0,
    variantsDeleted: 0,
    withCost: 0,
    withoutCost: 0,
    excluded: 0,
    currency,
  };
}

function summarise(products: ProductSyncResult, orders: OrderSyncResult, historyDays: number): string {
  const parts = [`Loaded ${products.variantsWritten} products`];

  if (orders.ordersProcessed === 0) {
    // Honest, and actionable: an empty history is not a failure, but every
    // forecast will be assumption-tier until there are sales to learn from.
    parts.push(
      `and found no orders in the last ${historyDays} days. Forecasts will use plain margin arithmetic until this store has sales history.`,
    );
    return `${parts.join(' ')}`;
  }

  parts.push(
    `and ${orders.ordersProcessed} orders across ${historyDays} days (${orders.variantsWithSales} products have sales).`,
  );
  if (products.withoutCost > 0) {
    parts.push(`${products.withoutCost} products have no cost saved, so their profit is unknown until you add one.`);
  }
  return parts.join(' ');
}

/** `sync_runs` row → the `sync_progress` contract Lane A polls. */
export function syncProgressFromRun(run: SyncRun | null): SyncProgress {
  if (run === null) {
    const nowIso = new Date().toISOString();
    return {
      contract_version: CONTRACT_VERSION,
      stage: 'queued',
      message: 'No sync has run yet for this store.',
      catalog: { ready: false, products_synced: 0, products_total: null, ready_at: null },
      history: { ready: false, days_synced: 0, days_target: DEFAULT_HISTORY_DAYS, orders_processed: 0, ready_at: null },
      eta_seconds: null,
      error: null,
      started_at: nowIso,
      updated_at: nowIso,
      finished_at: null,
    };
  }

  return {
    contract_version: CONTRACT_VERSION,
    stage: run.stage,
    message: run.message,
    catalog: {
      ready: run.catalog_ready_at !== null,
      products_synced: run.products_synced,
      products_total: run.products_total,
      ready_at: run.catalog_ready_at,
    },
    history: {
      ready: run.history_ready_at !== null,
      days_synced: run.days_synced,
      days_target: run.days_target,
      orders_processed: run.orders_processed,
      ready_at: run.history_ready_at,
    },
    eta_seconds: run.eta_seconds,
    error:
      run.error_code === null
        ? null
        : {
            code: run.error_code as SyncErrorCode,
            message: run.error_message ?? 'The sync failed.',
            retryable: run.error_retryable ?? true,
          },
    started_at: run.started_at,
    updated_at: run.updated_at,
    finished_at: run.finished_at,
  };
}

export type { DayString };
export { syncProducts, syncOrderDays };
