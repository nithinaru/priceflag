import { cn } from "@/components/cn";
import { formatUnits } from "@/components/format";
import type { RolloutReading } from "@/components/mock/engine";

/**
 * One day's orders against the range we expected, as an interval mark.
 *
 * Deliberately a mark, not a chart: A1's job is legibility on the primitives,
 * and BUILD_BRIEF gives the actual-vs-expected chart with its uncertainty band
 * to A4. Rules kept from the repo dataviz conventions so A4 can build on it:
 * the scale is shared across every row (rows must be comparable), the band is
 * recessive, the actual value is a single marker with a 2px surface ring so it
 * stays visible on top of the band, and status colour never carries the meaning
 * alone — every row also has a worded verdict badge beside it.
 */
export function ExpectedRangeMark({
  reading,
  domainMax,
}: {
  reading: RolloutReading;
  /** Shared upper bound for every row of the same table. */
  domainMax: number;
}) {
  const scale = (value: number) => `${clamp((value / domainMax) * 100, 0, 100)}%`;
  const belowRange = reading.verdict === "below";
  const aboveRange = reading.verdict === "above";

  return (
    <div
      className="relative h-5 w-full min-w-[8rem]"
      role="img"
      aria-label={
        `${formatUnits(reading.actualUnits)} orders against an expected ` +
        `${formatUnits(reading.expectedLow)} to ${formatUnits(reading.expectedHigh)}.`
      }
    >
      {/* Baseline: the full scale, so an empty day still reads as a day. */}
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-sm bg-surface-inset" />

      {/* The expected range. */}
      <div
        className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm border border-border-strong bg-surface-muted"
        style={{
          left: scale(reading.expectedLow),
          width: `${clamp(
            ((reading.expectedHigh - reading.expectedLow) / domainMax) * 100,
            0.5,
            100,
          )}%`,
        }}
      />

      {/* Where we expected to land inside that range. */}
      <div
        className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-border-strong"
        style={{ left: scale(reading.expectedUnits) }}
      />

      {/* What actually happened. */}
      <div
        className={cn(
          "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface",
          belowRange && "bg-breach",
          aboveRange && "bg-live",
          !belowRange && !aboveRange && "bg-ink",
        )}
        style={{ left: scale(reading.actualUnits) }}
      />
    </div>
  );
}

/** Shared scale for a set of readings: 0 → a little past the largest value. */
export function readingsDomainMax(readings: RolloutReading[]): number {
  const largest = readings.reduce(
    (max, reading) => Math.max(max, reading.expectedHigh, reading.actualUnits),
    0,
  );
  return largest > 0 ? Math.ceil((largest * 1.08) / 5) * 5 : 10;
}

/** Legend for the mark. Present whenever the mark is (identity, not colour). */
export function ExpectedRangeLegend({ className }: { className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted", className)}>
      <li className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-6 rounded-sm border border-border-strong bg-surface-muted"
          aria-hidden="true"
        />
        Range we expected
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-ink ring-2 ring-surface" aria-hidden="true" />
        Orders you got
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-breach ring-2 ring-surface" aria-hidden="true" />
        Below the range
      </li>
    </ul>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
