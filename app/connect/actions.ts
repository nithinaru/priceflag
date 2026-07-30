"use server";

import { CONTRACT_VERSION, type SyncProgress } from "@/lib/contracts";
import { getDemoStore } from "@/components/demo/store";

/**
 * `POST /api/sync` stands in until Lane B's route is reachable from a connected
 * store. It returns a real `sync_progress.schema.json` object so the UI that
 * renders it is the same UI either way.
 *
 * Deliberately returns a **finished** sync rather than animating a fake one: the
 * demo store is already loaded, and a progress bar that counts up to nothing is
 * exactly the sort of theatre this product is supposed to avoid.
 */

export type StartSyncReply =
  | { ok: true; progress: SyncProgress }
  | { ok: false; message: string };

export async function startDemoSync(shopDomain: string): Promise<StartSyncReply> {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return {
      ok: false,
      message: "That does not look like a Shopify store address. It should end in .myshopify.com.",
    };
  }

  const store = getDemoStore();
  const now = "2026-07-29T06:00:00.000Z";

  return {
    ok: true,
    progress: {
      contract_version: CONTRACT_VERSION,
      stage: "done",
      message: `Loaded ${store.products.length} products and ${store.window.days} days of sales from the demo store. On a real store this takes a minute or two, and you can leave the page while it runs.`,
      catalog: {
        ready: true,
        products_synced: store.products.length,
        products_total: store.products.length,
        ready_at: now,
      },
      history: {
        ready: true,
        days_synced: store.window.days,
        days_target: store.window.days,
        orders_processed: store.orderDays.length,
        ready_at: now,
      },
      eta_seconds: 0,
      error: null,
      started_at: now,
      updated_at: now,
      finished_at: now,
    },
  };
}
