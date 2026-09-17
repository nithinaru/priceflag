import { reconstructExpectedEconomics } from "@/lib/evaluator";
import type { CumulativeDay } from "@/components/charts/aggregate-trading";
import type { Cents } from "@/lib/money";
import type { DayString } from "@/lib/dates";
import type { Rollout, RolloutReading, RolloutVariant } from "@/lib/types";

/**
 * Exact persisted money when present; otherwise the same frozen-SKU reconstruction
 * the report and evaluator use for legacy rows. Never invents profit.
 */
function moneyForReading(
  rollout: Rollout,
  variants: readonly RolloutVariant[],
  reading: RolloutReading,
) {
  const liveVariants = variants.filter(
    (variant) => !variant.excluded && variant.cohort_stage <= reading.stage_index,
  );
  const legacy = reconstructExpectedEconomics(
    rollout,
    liveVariants,
    reading.expected_units,
    reading.expected_low,
    reading.expected_high,
  );

  return {
    actual_revenue_cents: reading.actual_revenue_cents,
    actual_profit_cents: reading.actual_profit_cents,
    expected_revenue_cents: reading.expected_revenue_cents ?? legacy.expected_revenue_cents,
    expected_profit_cents: reading.expected_profit_cents ?? legacy.expected_profit_cents,
    expected_revenue_low_cents:
      reading.expected_revenue_low_cents ?? legacy.expected_revenue_low_cents,
    expected_revenue_high_cents:
      reading.expected_revenue_high_cents ?? legacy.expected_revenue_high_cents,
    expected_profit_low_cents:
      reading.expected_profit_low_cents ?? legacy.expected_profit_low_cents,
    expected_profit_high_cents:
      reading.expected_profit_high_cents ?? legacy.expected_profit_high_cents,
    counterfactual_units: reading.counterfactual_units ?? legacy.counterfactual_units,
    counterfactual_revenue_cents:
      reading.counterfactual_revenue_cents ?? legacy.counterfactual_revenue_cents,
    counterfactual_profit_cents:
      reading.counterfactual_profit_cents ?? legacy.counterfactual_profit_cents,
  } satisfies {
    actual_revenue_cents: Cents;
    actual_profit_cents: Cents | null;
    expected_revenue_cents: Cents;
    expected_profit_cents: Cents | null;
    expected_revenue_low_cents: Cents;
    expected_revenue_high_cents: Cents;
    expected_profit_low_cents: Cents | null;
    expected_profit_high_cents: Cents | null;
    counterfactual_units: number;
    counterfactual_revenue_cents: Cents;
    counterfactual_profit_cents: Cents | null;
  };
}

export function enrichReadings(
  rollout: Rollout,
  variants: readonly RolloutVariant[],
  readings: readonly RolloutReading[],
): RolloutReading[] {
  return readings.map((reading) => ({ ...reading, ...moneyForReading(rollout, variants, reading) }));
}

export function runningActualVsOldPrice(
  rollout: Rollout,
  variants: readonly RolloutVariant[],
  readings: readonly RolloutReading[],
): { revenue: CumulativeDay[]; profit: CumulativeDay[] } {
  const revenue: CumulativeDay[] = [];
  const profit: CumulativeDay[] = [];
  let actualRevenue = 0;
  let oldRevenue = 0;
  let actualProfit = 0;
  let oldProfit = 0;

  for (const reading of readings) {
    const money = moneyForReading(rollout, variants, reading);
    actualRevenue += money.actual_revenue_cents;
    oldRevenue += money.counterfactual_revenue_cents;
    revenue.push({
      day: reading.day as DayString,
      actual_cents: actualRevenue,
      baseline_cents: oldRevenue,
    });

    if (money.actual_profit_cents === null || money.counterfactual_profit_cents === null) {
      profit.push({ day: reading.day as DayString, actual_cents: null, baseline_cents: null });
      continue;
    }
    actualProfit += money.actual_profit_cents;
    oldProfit += money.counterfactual_profit_cents;
    profit.push({
      day: reading.day as DayString,
      actual_cents: actualProfit,
      baseline_cents: oldProfit,
    });
  }

  return { revenue, profit };
}
