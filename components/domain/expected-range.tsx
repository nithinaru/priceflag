import { cn } from "@/components/cn";
import { formatUnits } from "@/components/format";
import { verdictForReading } from "@/lib/engine/readings";
import type { RolloutReading } from "@/lib/types";

/**
 * One day's orders against the range we expected, as an interval mark.
 *
 * Deliberately a mark, not a chart: BUILD_BRIEF gives the actual-vs-expected
 * chart with its uncertainty band to A4. Conventions kept so A4 builds on this
 * rather than replacing it — the scale is shared across every row (rows must be
 * comparable), the band is recessive, the actual value is one marker with a 2px
 * surface ring so it stays legible on top of the band, and status colour never
 * carries the meaning alone: every row also has a worded verdict beside it.
 */
export function ExpectedRangeMark({
  reading,
  domainMax,
}: {
  reading: RolloutReading;
  /** Shared upper bound for every row of the same table. */
  domainMax: number;
}) {
  const verdict = verdictForReading(reading);
  const scale = (value: number) => `${clamp((value / domainMax) * 100, 0, 100)}%`;

  if (reading.band_floored) {
    // No honest range to draw. Saying so beats drawing a band nobody should read.
    return (
      <div className="flex h-5 items-center text-xs text-ink-subtle">
        Too few orders a day to draw a range
      </div>
    );
  }

  return (
    <div
      className="relative h-5 w-full min-w-[8rem]"
      role="img"
      aria-label={`${formatUnits(reading.actual_units)} orders against an expected ${formatUnits(
        reading.expected_low,
        1,
      )} to ${formatUnits(reading.expected_high, 1)}.`}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-sm bg-surface-inset" />

      <div
        className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm border border-border-strong bg-surface-muted"
        style={{
          left: scale(reading.expected_low),
          width: `${clamp(
            ((reading.expected_high - reading.expected_low) / domainMax) * 100,
            0.5,
            100,
          )}%`,
        }}
      />

      <div
        className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-border-strong"
        style={{ left: scale(reading.expected_units) }}
      />

      <div
        className={cn(
          "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface",
          verdict === "below" && "bg-breach",
          verdict === "above" && "bg-live",
          verdict === "within" && "bg-ink",
        )}
        style={{ left: scale(reading.actual_units) }}
      />
    </div>
  );
}

/** Shared scale for a set of readings: 0 → a little past the largest value. */
export function readingsDomainMax(readings: readonly RolloutReading[]): number {
  const largest = readings.reduce(
    (max, reading) => Math.max(max, reading.expected_high, reading.actual_units),
    0,
  );
  return largest > 0 ? Math.ceil((largest * 1.08) / 5) * 5 : 10;
}

/** Legend for the mark. Present whenever the mark is — identity, not colour. */
export function ExpectedRangeLegend({ className }: { className?: string }) {
  return (
    <ul
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted",
        className,
      )}
    >
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
