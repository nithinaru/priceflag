import type { Cents } from "@/lib/money";
import type { OrderDay, Product } from "@/lib/types";
import type { DayString } from "@/lib/dates";

export const TRADING_WINDOW_DAYS = 30;

export type DailyTrading = {
  day: DayString;
  units: number;
  revenue_cents: Cents;
  /** null when any selling variant that day is missing cost — a gap, not zero. */
  profit_cents: Cents | null;
};

export type CumulativeDay = {
  day: DayString;
  actual_cents: Cents | null;
  baseline_cents: Cents | null;
};

export type TradingTotals = {
  units: number;
  revenue_cents: Cents;
  profit_cents: Cents | null;
};

/**
 * One point per calendar day that has order rows. Profit is
 * `net_revenue - units * cogs` only when every variant with units that day has
 * a cost; otherwise the day is a gap.
 */
export function aggregateDailyTrading(
  orderDays: readonly OrderDay[],
  products: readonly Pick<Product, "variant_gid" | "cogs_cents">[],
): DailyTrading[] {
  const cogsByVariant = new Map(products.map((product) => [product.variant_gid, product.cogs_cents]));
  const rowsByDay = new Map<DayString, OrderDay[]>();

  for (const row of orderDays) {
    const existing = rowsByDay.get(row.day);
    if (existing) existing.push(row);
    else rowsByDay.set(row.day, [row]);
  }

  return [...rowsByDay.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => summarizeDay(rowsByDay.get(day)!, cogsByVariant));
}

export function tradingTotals(days: readonly DailyTrading[]): TradingTotals {
  let units = 0;
  let revenue = 0;
  let profit = 0;
  let profitKnown = true;

  for (const day of days) {
    units += day.units;
    revenue += day.revenue_cents;
    if (day.profit_cents === null) profitKnown = false;
    else profit += day.profit_cents;
  }

  return {
    units,
    revenue_cents: revenue,
    profit_cents: profitKnown ? profit : null,
  };
}

function summarizeDay(
  rows: readonly OrderDay[],
  cogsByVariant: ReadonlyMap<string, Cents | null>,
): DailyTrading {
  let units = 0;
  let revenue = 0;
  for (const row of rows) {
    units += row.units;
    revenue += row.net_revenue_cents;
  }

  const selling = rows.filter((row) => row.units > 0);
  const costsKnown = selling.every((row) => {
    const cogs = cogsByVariant.get(row.variant_gid);
    return cogs !== null && cogs !== undefined;
  });

  if (!costsKnown) {
    return { day: rows[0]!.day, units, revenue_cents: revenue, profit_cents: null };
  }

  let profit = 0;
  for (const row of rows) {
    const cogs = cogsByVariant.get(row.variant_gid) ?? 0;
    profit += row.net_revenue_cents - row.units * cogs;
  }

  return { day: rows[0]!.day, units, revenue_cents: revenue, profit_cents: profit };
}
