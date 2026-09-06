"use client";

import { useMemo } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { buttonClasses } from "@/components/ui";
import {
  BandTimeSeries,
  profitAccessors,
  revenueAccessors,
  unitsAccessors,
  type BandAccessors,
} from "@/components/charts/band-time-series";
import { formatDay, formatMoney, formatUnits } from "@/components/format";
import type { RolloutReading } from "@/lib/types";

type Metric = "units" | "revenue" | "profit";

export function RolloutMetricCharts({
  readings,
  stageCount,
  currency,
  liveLatest,
}: {
  readings: readonly RolloutReading[];
  stageCount: number;
  currency: string;
  liveLatest: boolean;
}) {
  const showProfit = readings.some((reading) => reading.actual_profit_cents !== null);
  const from = formatDay(readings[0]?.day);
  const to = formatDay(readings[readings.length - 1]?.day);
  const money = (cents: number) => formatMoney(cents, { currency, showCents: false });

  const revenueChartAccessors = useMemo<BandAccessors<RolloutReading>>(
    () => ({
      ...revenueAccessors,
      sentence: (row) =>
        bandSentence(
          row.actual_revenue_cents,
          row.expected_revenue_cents ?? null,
          row.expected_revenue_low_cents ?? null,
          row.expected_revenue_high_cents ?? null,
          revenueAccessors.bandFloored(row),
          money,
          "revenue",
        ),
    }),
    [currency],
  );

  const profitChartAccessors = useMemo<BandAccessors<RolloutReading>>(
    () => ({
      ...profitAccessors,
      sentence: (row) =>
        row.actual_profit_cents === null
          ? "Profit unknown — a cost is missing, so we will not draw one."
          : bandSentence(
              row.actual_profit_cents,
              row.expected_profit_cents ?? null,
              row.expected_profit_low_cents ?? null,
              row.expected_profit_high_cents ?? null,
              profitAccessors.bandFloored(row),
              money,
              "profit",
            ),
    }),
    [currency],
  );

  const tabClass = (state: { active: boolean }) =>
    buttonClasses(state.active ? "primary" : "secondary", "sm");

  return (
    <Tabs.Root defaultValue={"units" satisfies Metric}>
      <Tabs.List className="mb-3 flex flex-wrap gap-2" aria-label="What to plot">
        <Tabs.Tab value="units" className={tabClass}>
          Units
        </Tabs.Tab>
        <Tabs.Tab value="revenue" className={tabClass}>
          Revenue
        </Tabs.Tab>
        {showProfit ? (
          <Tabs.Tab value="profit" className={tabClass}>
            Profit
          </Tabs.Tab>
        ) : null}
      </Tabs.List>
      <Tabs.Panel value="units">
        <BandTimeSeries
          readings={readings}
          accessors={unitsAccessors}
          format={formatUnits}
          stageCount={stageCount}
          actualLabel="Units sold"
          ariaLabel={`Daily units sold against the expected range, ${from} to ${to}. ${readings.length} days. The table below has the same numbers.`}
          liveLatest={liveLatest}
        />
      </Tabs.Panel>
      <Tabs.Panel value="revenue">
        <BandTimeSeries
          readings={readings}
          accessors={revenueChartAccessors}
          format={money}
          stageCount={stageCount}
          actualLabel="Revenue"
          ariaLabel={`Daily revenue against the expected range, ${from} to ${to}. ${readings.length} days. The table below has the same numbers.`}
          padLeft={56}
          liveLatest={liveLatest}
        />
      </Tabs.Panel>
      {showProfit ? (
        <Tabs.Panel value="profit">
          <BandTimeSeries
            readings={readings}
            accessors={profitChartAccessors}
            format={money}
            stageCount={stageCount}
            actualLabel="Profit"
            ariaLabel={`Daily profit against the expected range, ${from} to ${to}. Days without a cost are left blank. The table below has the same numbers.`}
            padLeft={56}
            liveLatest={liveLatest}
          />
        </Tabs.Panel>
      ) : null}
    </Tabs.Root>
  );
}

function bandSentence(
  actual: number | null,
  expected: number | null,
  low: number | null,
  high: number | null,
  floored: boolean,
  format: (value: number) => string,
  noun: string,
): string {
  if (actual === null) return "Profit unknown — a cost is missing, so we will not draw one.";
  if (floored || low === null || high === null || expected === null) {
    return `${format(actual)} ${noun} — too quiet to judge against a range.`;
  }
  if (actual < low) {
    return `${format(actual)} against ${format(expected)} expected — below the range we expected.`;
  }
  if (actual > high) {
    return `${format(actual)} against ${format(expected)} expected — above the range we expected.`;
  }
  return `${format(actual)} against ${format(expected)} expected — inside the range we expected.`;
}
