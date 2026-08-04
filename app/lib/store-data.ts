/**
 * The real-mode read layer.
 *
 * Every merchant page renders the same view-model shapes in both modes. Demo
 * mode gets them from `components/demo/*`, which simulates a store and runs the
 * engine over it; this module produces the identical shapes from `getAdapter()`
 * reads scoped to an authenticated shop. The page JSX is shared, so a
 * behaviour that differs between modes is a bug in one of the two read layers,
 * not in a page.
 *
 * Two rules, mirroring the demo layer's:
 *
 * 1. **No logic.** Health, sentences and verdicts come from `lib/engine/*` —
 *    the same functions the evaluator uses — so the UI can never show a verdict
 *    the machine did not compute. This file joins rows and counts things.
 * 2. **Real clock.** The demo pins "now" so builds are deterministic; a real
 *    store's baseline window ends yesterday in the *shop's* timezone, because
 *    today is a partial day and a partial day always reads as a dip.
 *
 * A freshly synced store is the common case here: products and order history,
 * zero rollouts, zero journal entries, costs missing. Everything below returns
 * empty collections for that state rather than throwing — the pages already
 * have empty states designed for it.
 */

import { getAdapter } from "@/lib/adapters";
import { BASELINE_WINDOW_DAYS } from "@/lib/contracts";
import { addDays, yesterday } from "@/lib/dates";
import { healthSentence, rolloutHealth } from "@/lib/engine/readings";
import {
  exclusionReasonFor,
  type JournalEntry,
  type Product,
  type Rollout,
  type RolloutEvent,
  type RolloutReading,
  type RolloutVariant,
  type Shop,
} from "@/lib/types";
import type { LiveResponse, RolloutBundle } from "@/components/demo/rollouts";
import type { StoreReadiness } from "@/components/onboarding/first-run";

/* --------------------------------------------------------------- bundles */

/**
 * A `RolloutBundle` from stored rows. The demo layer assembles the same shape
 * at the end of its simulation loop; here the rows already exist because the
 * evaluator wrote them, so this is pure assembly — every derived field comes
 * from `lib/engine/readings.ts` or is a count.
 */
function bundleFromRows(
  rollout: Rollout,
  variants: RolloutVariant[],
  readings: RolloutReading[],
  events: RolloutEvent[],
): RolloutBundle {
  const health = rolloutHealth(rollout.status, readings);
  const latest = readings.at(-1);
  // Applied and not since put back — `applied_at` stays set after a rollback
  // because the write really happened; `reverted_at` is what ends it.
  const variantsLive = variants.filter(
    (variant) => variant.applied_at !== null && variant.reverted_at === null,
  ).length;

  return {
    rollout,
    variants,
    readings,
    // The adapter returns events newest-first; pages hold them oldest-first
    // (the demo's order) and reverse at render time.
    events: [...events].sort((a, b) => a.at.localeCompare(b.at)),
    health,
    health_sentence: healthSentence(health, latest?.decision ?? "none", latest?.breach_streak ?? 0),
    live: {
      stage_index: rollout.current_stage,
      variants_live: variantsLive,
      variants_total: variants.filter((variant) => !variant.excluded).length,
      fraction:
        rollout.current_stage >= 0 ? (rollout.stages[rollout.current_stage]?.fraction ?? 0) : 0,
    },
    can: {
      rollback: variantsLive > 0 && (rollout.status === "running" || rollout.status === "paused"),
      cancel: rollout.status === "draft" || rollout.status === "scheduled",
      resume: rollout.status === "paused",
    },
  };
}

export async function getRealRolloutBundles(shop: Shop): Promise<RolloutBundle[]> {
  const adapter = getAdapter();
  const rollouts = await adapter.listRollouts(shop.id);
  return Promise.all(
    rollouts.map(async (rollout) => {
      const [variants, readings, events] = await Promise.all([
        adapter.getRolloutVariants(rollout.id),
        adapter.listRolloutReadings(rollout.id),
        adapter.listRolloutEvents(rollout.id),
      ]);
      return bundleFromRows(rollout, variants, readings, events);
    }),
  );
}

/** Scoped to the shop: a guessed rollout id from another store resolves to nothing. */
export async function getRealRolloutBundle(
  shop: Shop,
  rolloutId: string,
): Promise<RolloutBundle | undefined> {
  const adapter = getAdapter();
  const rollout = await adapter.getRollout(rolloutId);
  if (rollout === null || rollout.shop_id !== shop.id) return undefined;

  const [variants, readings, events] = await Promise.all([
    adapter.getRolloutVariants(rollout.id),
    adapter.listRolloutReadings(rollout.id),
    adapter.listRolloutEvents(rollout.id),
  ]);
  return bundleFromRows(rollout, variants, readings, events);
}

/** Variants currently holding a price Priceflag wrote and has not put back. */
function liveVariantGidsFrom(bundles: readonly RolloutBundle[]): string[] {
  return bundles
    .filter((bundle) => bundle.rollout.status !== "cancelled")
    .flatMap((bundle) =>
      bundle.variants
        .filter((variant) => variant.applied_at !== null && variant.reverted_at === null)
        .map((variant) => variant.variant_gid),
    );
}

/* ------------------------------------------------------------------ live */

/** The `GET /api/live` shape, from rows already loaded. Mirrors the demo's `getLive`. */
function liveFromBundles(
  shop: Shop,
  bundles: readonly RolloutBundle[],
  products: readonly Product[],
): LiveResponse {
  const live = bundles.filter(
    (bundle) => bundle.rollout.status === "running" || bundle.rollout.status === "paused",
  );

  return {
    anything_live: live.some((bundle) => bundle.live.variants_live > 0),
    kill_switch_engaged: shop.kill_switch_engaged_at !== null,
    skus_holding_priceflag_price: live.reduce((sum, bundle) => sum + bundle.live.variants_live, 0),
    rollouts: live.map((bundle) => ({
      id: bundle.rollout.id,
      name: bundle.rollout.name,
      status: bundle.rollout.status,
      stage_index: bundle.live.stage_index,
      stage_count: bundle.rollout.stages.length,
      fraction_live: bundle.live.fraction,
      variants_live: bundle.live.variants_live,
      variants_total: bundle.live.variants_total,
      health: bundle.health,
      health_sentence: bundle.health_sentence,
      next_decision_day: bundle.readings.at(-1) ? addDays(bundle.readings.at(-1)!.day, 1) : null,
      can: bundle.can,
    })),
    paused_for_external_change: bundles
      .filter((bundle) => bundle.rollout.status === "paused")
      .map((bundle) => bundle.rollout.id),
    products_missing_cost: products.filter(
      (product) => exclusionReasonFor(product) === null && product.cogs_cents === null,
    ).length,
  };
}

/** For the nav's live-status card, which loads nothing else. */
export async function getRealLive(shop: Shop): Promise<LiveResponse> {
  const [bundles, paged] = await Promise.all([
    getRealRolloutBundles(shop),
    getAdapter().listProducts(shop.id),
  ]);
  return liveFromBundles(shop, bundles, paged.items);
}

/* --------------------------------------------------------------- catalog */

export type CatalogData = {
  products: Product[];
  productTypes: string[];
  /** Units sold in the trailing baseline window, keyed by variant gid. */
  units: Record<string, number>;
  liveGids: string[];
  currency: string;
};

export async function getRealCatalog(shop: Shop): Promise<CatalogData> {
  const adapter = getAdapter();
  // The window ends on the last *full* day in the shop's timezone — today is a
  // partial day, and a partial day always reads as a dip.
  const endDay = yesterday(shop.timezone);
  const fromDay = addDays(endDay, -(BASELINE_WINDOW_DAYS - 1));

  const [paged, orderDays, bundles] = await Promise.all([
    adapter.listProducts(shop.id),
    adapter.getOrderDays(shop.id, { from_day: fromDay, to_day: endDay }),
    getRealRolloutBundles(shop),
  ]);

  const units: Record<string, number> = {};
  for (const row of orderDays) {
    units[row.variant_gid] = (units[row.variant_gid] ?? 0) + row.units;
  }

  const types = new Set<string>();
  for (const product of paged.items) {
    if (product.product_type) types.add(product.product_type);
  }

  return {
    products: paged.items,
    productTypes: [...types].sort((a, b) => a.localeCompare(b)),
    units,
    liveGids: liveVariantGidsFrom(bundles),
    currency: shop.currency,
  };
}

/* --------------------------------------------------------------- journal */

export async function getRealJournal(shop: Shop): Promise<JournalEntry[]> {
  const paged = await getAdapter().listJournalEntries(shop.id);
  return paged.items;
}

/** Rollout id → name, for the journal's "which change was this" column. */
export async function getRealRolloutNames(shop: Shop): Promise<Record<string, string>> {
  const rollouts = await getAdapter().listRollouts(shop.id);
  return Object.fromEntries(rollouts.map((rollout) => [rollout.id, rollout.name]));
}

export async function getRealJournalForRollout(
  shop: Shop,
  rolloutId: string,
): Promise<JournalEntry[]> {
  const paged = await getAdapter().listJournalEntries(shop.id, { rollout_id: rolloutId });
  return paged.items;
}

/* -------------------------------------------------------------- overview */

export type OverviewData = {
  shopDomain: string;
  currency: string;
  live: LiveResponse;
  /** Every bundle, keyed by rollout id — the live cards look details up here. */
  bundles: ReadonlyMap<string, RolloutBundle>;
  /** The most recent price changes, newest first. */
  journal: JournalEntry[];
  upcoming: Rollout[];
  readiness: StoreReadiness;
};

export async function getRealOverview(shop: Shop): Promise<OverviewData> {
  const adapter = getAdapter();
  const [paged, orderDays, bundles, journalPage] = await Promise.all([
    adapter.listProducts(shop.id),
    adapter.getOrderDays(shop.id),
    getRealRolloutBundles(shop),
    adapter.listJournalEntries(shop.id, { limit: 4 }),
  ]);

  const products = paged.items;
  const rollouts = bundles.map((bundle) => bundle.rollout);
  const repriceable = products.filter((product) => exclusionReasonFor(product) === null);

  return {
    shopDomain: shop.shop_domain,
    currency: shop.currency,
    live: liveFromBundles(shop, bundles, products),
    bundles: new Map(bundles.map((bundle) => [bundle.rollout.id, bundle])),
    journal: journalPage.items,
    upcoming: rollouts.filter(
      (rollout) => rollout.status === "scheduled" || rollout.status === "draft",
    ),
    readiness: {
      productCount: products.length,
      repriceableCount: repriceable.length,
      missingCostCount: repriceable.filter((product) => product.cogs_cents === null).length,
      // Days with an actual sale, not days of history: a store synced for 180
      // days that sold nothing has no baseline, and that is the state that
      // matters.
      daysWithSales: new Set(orderDays.filter((day) => day.units > 0).map((day) => day.day)).size,
      hasAnyRollout: rollouts.length > 0,
    },
  };
}

/* -------------------------------------------------------------- settings */

export type SettingsData = {
  shopDomain: string;
  currency: string;
  timezone: string;
  productCount: number;
  liveCount: number;
  notifyEmails: string[];
};

export async function getRealSettings(shop: Shop): Promise<SettingsData> {
  const [paged, bundles] = await Promise.all([
    getAdapter().listProducts(shop.id),
    getRealRolloutBundles(shop),
  ]);

  return {
    shopDomain: shop.shop_domain,
    currency: shop.currency,
    timezone: shop.timezone,
    productCount: paged.total,
    liveCount: liveVariantGidsFrom(bundles).length,
    notifyEmails: shop.notify_emails,
  };
}
