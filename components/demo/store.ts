import { generateDemoStore, DEMO_CURRENCY, DEMO_SHOP_DOMAIN, DEMO_TIMEZONE } from "@/lib/demo/generator";
import { BASELINE_WINDOW_DAYS } from "@/lib/contracts";
import type { OrderDay, Product } from "@/lib/types";
import type { DayString } from "@/lib/dates";

/**
 * Lane A's read surface for demo mode.
 *
 * Lane B owns the golden demo store (`lib/demo/generator.ts`) and the API that
 * will eventually serve it (`contracts/api.md`), but only `GET /api/health`
 * exists today — every other route 404s. So this module does the one thing Lane
 * A legitimately has to do: turn the generator's upsert payloads into the row
 * shapes the pure engine functions take, and hand them to pages.
 *
 * Two rules it keeps:
 *
 * 1. **No logic.** Every derived number on screen comes from `lib/engine/*`.
 *    This file adds ids and timestamps, nothing else. When Lane B's routes land,
 *    pages swap `getDemoStore()` for a fetch and nothing else changes.
 * 2. **Deterministic.** `generateDemoStore()` defaults its last day to
 *    "yesterday", which would make every build differ and every statically
 *    rendered page disagree with the next deploy. Both `endDay` and `now` are
 *    pinned here (CLAUDE.md: no `Date.now()` in demo logic).
 */

/** The last day of generated history. Pinned — see rule 2 above. */
export const DEMO_END_DAY: DayString = "2026-07-28" as DayString;

/** "Now" for the demo store. One day after the last full day of history. */
export const DEMO_NOW = new Date("2026-07-29T12:00:00.000Z");

export const DEMO_TODAY: DayString = "2026-07-29" as DayString;

const SHOP_ID = "demo-shop";
const SEEDED_AT = "2026-07-29T06:00:00.000Z";

export type DemoShop = {
  id: string;
  domain: string;
  currency: string;
  timezone: string;
  mode: "demo";
};

export type DemoStoreData = {
  shop: DemoShop;
  products: Product[];
  orderDays: OrderDay[];
  window: { from: DayString; to: DayString; days: number };
};

let cached: DemoStoreData | null = null;

export function getDemoStore(): DemoStoreData {
  if (cached) return cached;

  const generated = generateDemoStore({ endDay: DEMO_END_DAY, now: DEMO_NOW });

  const products: Product[] = generated.products.map((upsert, index) => ({
    ...upsert,
    id: `demo-product-${index + 1}`,
    shop_id: SHOP_ID,
    first_synced_at: SEEDED_AT,
    last_synced_at: upsert.last_synced_at ?? SEEDED_AT,
    deleted_at: upsert.deleted_at ?? null,
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
  }));

  const orderDays: OrderDay[] = generated.orderDays.map((upsert) => ({
    ...upsert,
    shop_id: SHOP_ID,
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
  }));

  cached = {
    shop: {
      id: SHOP_ID,
      domain: DEMO_SHOP_DOMAIN,
      currency: DEMO_CURRENCY,
      timezone: DEMO_TIMEZONE,
      mode: "demo",
    },
    products,
    orderDays,
    window: generated.window,
  };

  return cached;
}

export function getProducts(): Product[] {
  return getDemoStore().products;
}

export function getProduct(variantGid: string): Product | undefined {
  return getDemoStore().products.find((product) => product.variant_gid === variantGid);
}

export function getProductsByGid(variantGids: readonly string[]): Product[] {
  const wanted = new Set(variantGids);
  return getDemoStore().products.filter((product) => wanted.has(product.variant_gid));
}

/** Product types present in the catalog, for the catalog's type filter. */
export function getProductTypes(): string[] {
  const types = new Set<string>();
  for (const product of getDemoStore().products) {
    if (product.product_type) types.add(product.product_type);
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

/**
 * Units sold per variant over the trailing baseline window. Not a product-row
 * field on purpose — Lane B derives it from `order_days`, so Lane A does too
 * rather than inventing a column.
 */
let unitsCache: Map<string, number> | null = null;

export function unitsInBaselineWindow(): ReadonlyMap<string, number> {
  if (unitsCache) return unitsCache;

  const cutoff = dayOffset(DEMO_END_DAY, -(BASELINE_WINDOW_DAYS - 1));
  const totals = new Map<string, number>();

  for (const row of getDemoStore().orderDays) {
    if (row.day < cutoff) continue;
    totals.set(row.variant_gid, (totals.get(row.variant_gid) ?? 0) + row.units);
  }

  unitsCache = totals;
  return unitsCache;
}

export function unitsFor(variantGid: string): number {
  return unitsInBaselineWindow().get(variantGid) ?? 0;
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` string, in UTC. */
export function dayOffset(day: DayString, deltaDays: number): DayString {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10) as DayString;
}

/** Whole days between two calendar days. */
export function daysBetweenDays(from: DayString, to: DayString): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
