"use client";

import { BandTimeSeries, unitsAccessors } from "@/components/charts/band-time-series";
import { formatDay, formatUnits } from "@/components/format";
import type { RolloutReading } from "@/lib/types";

/**
 * Units sold against the range we expected, over the life of the rollout (R16).
 * Geometry lives in `BandTimeSeries`; this is the units accessor wrapper.
 */
export function UnitsChart({
  readings,
  stageCount,
  liveLatest = false,
}: {
  readings: readonly RolloutReading[];
  stageCount: number;
  liveLatest?: boolean;
}) {
  if (readings.length === 0) return null;
  return (
    <BandTimeSeries
      readings={readings}
      accessors={unitsAccessors}
      format={formatUnits}
      stageCount={stageCount}
      actualLabel="Units sold"
      ariaLabel={`Daily units sold against the expected range, ${formatDay(
        readings[0]!.day,
      )} to ${formatDay(readings[readings.length - 1]!.day)}. ${readings.length} days. The table below has the same numbers.`}
      liveLatest={liveLatest}
    />
  );
}
