"use client";

import { useId, useMemo, useState } from "react";
import { cn } from "@/components/cn";
import { formatDay, formatUnits } from "@/components/format";
import { readingSentence, verdictForReading } from "@/lib/engine/readings";
import type { RolloutReading } from "@/lib/types";

/**
 * Orders against the range we expected, over the life of the rollout (R16).
 *
 * Hand-authored SVG — no chart dependency, on a page merchants open on phones.
 * Conventions from the repo dataviz rules:
 *
 * - Two series, so a legend is always present, and the latest actual value is
 *   direct-labelled rather than every point carrying a number.
 * - The band is the *whole point*: a recessive fill with a defined edge, drawn
 *   first so the actual line reads on top of it. Markers are ringed in the
 *   surface colour so they stay legible against the band.
 * - Status colour never carries meaning alone: below-range days are called out in
 *   the tooltip and in the table beneath, which is also the accessible view.
 * - `band_floored` days have **no honest band to draw**. They are shown as a gap
 *   with a hollow marker, because a drawn range there would invite a reading the
 *   data cannot support.
 * - One axis. Units only; the price change is a stage annotation, not a series.
 */
export function OrdersChart({
  readings,
  stageCount,
}: {
  readings: readonly RolloutReading[];
  stageCount: number;
}) {
  const clipId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => build(readings), [readings]);
  if (!geometry) return null;

  const { points, max, width, height, pad } = geometry;
  const active = hover !== null ? points[hover] : null;

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          className="block h-[13rem] touch-none select-none sm:h-[15rem]"
          role="img"
          aria-label={`Daily orders against the expected range, ${formatDay(
            points[0]!.reading.day,
          )} to ${formatDay(points[points.length - 1]!.reading.day)}. ${readings.length} days. The table below has the same numbers.`}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={`pf-clip-${clipId}`}>
              <rect x={pad.left} y={0} width={width - pad.left - pad.right} height={height} />
            </clipPath>
          </defs>

          {/* Two gridlines only: zero, and the top of the scale. Recessive. */}
          {[0, max].map((value) => (
            <g key={value}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={geometry.y(value)}
                y2={geometry.y(value)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={geometry.y(value) + 3}
                textAnchor="end"
                className="fill-ink-subtle text-[9px] tabular-nums"
              >
                {formatUnits(value)}
              </text>
            </g>
          ))}

          {/* Stage boundaries: where more products joined the change. */}
          {geometry.stageMarks.map((mark) => (
            <g key={mark.stageIndex}>
              <line
                x1={mark.x}
                x2={mark.x}
                y1={8}
                y2={geometry.y(0)}
                className="stroke-border-strong"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text x={mark.x + 4} y={14} className="fill-ink-subtle text-[9px]">
                Step {mark.stageIndex + 1} of {stageCount}
              </text>
            </g>
          ))}

          <g clipPath={`url(#pf-clip-${clipId})`}>
            {/* The expected range. Drawn first: the actual line reads on top. */}
            {geometry.bandSegments.map((segment, index) => (
              <path
                key={index}
                d={segment}
                className="fill-accent-tint stroke-accent-border"
                strokeWidth={1}
              />
            ))}

            {/* What we expected to land on, inside that range. */}
            {geometry.expectedSegments.map((segment, index) => (
              <path
                key={index}
                d={segment}
                fill="none"
                className="stroke-border-strong"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ))}

            {/* What actually happened. */}
            {geometry.actualSegments.map((segment, index) => (
              <path
                key={index}
                d={segment}
                fill="none"
                className="stroke-ink"
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
          </g>

          {points.map((point, index) => {
            const verdict = verdictForReading(point.reading);
            const floored = point.reading.band_floored;
            return (
              <g key={point.reading.day}>
                {/* Hit target, deliberately wider than the mark. */}
                <rect
                  x={point.x - geometry.step / 2}
                  y={0}
                  width={geometry.step}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  role="button"
                  aria-label={readingSentence(point.reading)}
                  className="cursor-pointer outline-none focus-visible:fill-accent-tint/40"
                />
                <circle
                  cx={point.x}
                  cy={point.yActual}
                  r={hover === index ? 5.5 : 4.5}
                  strokeWidth={2}
                  className={cn(
                    "stroke-surface",
                    floored
                      ? "fill-ink-subtle"
                      : verdict === "below"
                        ? "fill-breach"
                        : verdict === "above"
                          ? "fill-live"
                          : "fill-ink",
                  )}
                />
              </g>
            );
          })}

          {/* Direct label on the most recent day only — never every point. */}
          <text
            x={points[points.length - 1]!.x}
            y={points[points.length - 1]!.yActual - 12}
            textAnchor="end"
            className="fill-ink text-[11px] font-semibold tabular-nums"
          >
            {formatUnits(points[points.length - 1]!.reading.actual_units)}
          </text>

          {/* Sparse day labels: first, last, and the middle. */}
          {geometry.dayLabels.map((label) => (
            <text
              key={label.x}
              x={label.x}
              y={height - 4}
              textAnchor={label.anchor}
              className="fill-ink-subtle text-[9px]"
            >
              {formatDay(label.day)}
            </text>
          ))}
        </svg>

        {active ? (
          <div
            className="pointer-events-none absolute z-10 w-56 rounded-md border border-border bg-surface p-2.5 shadow-md"
            style={{
              left: `${(active.x / geometry.width) * 100}%`,
              top: 0,
              transform:
                active.x > geometry.width * 0.6 ? "translateX(-104%)" : "translateX(4%)",
            }}
          >
            <p className="text-xs font-semibold text-ink">{formatDay(active.reading.day)}</p>
            <p className="mt-0.5 text-xs text-ink-muted">{readingSentence(active.reading)}</p>
          </div>
        ) : null}
      </div>

      <figcaption className="mt-3">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
          <li className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-6 rounded-sm border border-accent-border bg-accent-tint"
              aria-hidden="true"
            />
            Range we expected
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0 w-6 border-t-2 border-dashed border-border-strong" aria-hidden="true" />
            What we expected
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0 w-6 border-t-2 border-ink" aria-hidden="true" />
            Orders you got
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-breach ring-2 ring-surface" aria-hidden="true" />
            Below the range
          </li>
          <li className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-full bg-ink-subtle ring-2 ring-surface"
              aria-hidden="true"
            />
            Too quiet to judge
          </li>
        </ul>
      </figcaption>
    </figure>
  );
}

type Point = {
  reading: RolloutReading;
  x: number;
  yActual: number;
  yLow: number;
  yHigh: number;
  yExpected: number;
};

function build(readings: readonly RolloutReading[]) {
  if (readings.length === 0) return null;

  const width = 640;
  const height = 200;
  const pad = { left: 30, right: 14, top: 22, bottom: 18 };

  const max =
    Math.ceil(
      (readings.reduce(
        (peak, reading) =>
          Math.max(peak, reading.actual_units, reading.band_floored ? 0 : reading.expected_high),
        0,
      ) *
        1.12) /
        5,
    ) * 5 || 10;

  const plotWidth = width - pad.left - pad.right;
  const step = readings.length > 1 ? plotWidth / (readings.length - 1) : plotWidth;
  const y = (value: number) =>
    height - pad.bottom - (Math.min(value, max) / max) * (height - pad.top - pad.bottom);
  const x = (index: number) =>
    readings.length > 1 ? pad.left + index * step : pad.left + plotWidth / 2;

  const points: Point[] = readings.map((reading, index) => ({
    reading,
    x: x(index),
    yActual: y(reading.actual_units),
    yLow: y(reading.expected_low),
    yHigh: y(reading.expected_high),
    yExpected: y(reading.expected_units),
  }));

  // Floored days break every series: there is no band to draw, so the line is
  // segmented around them rather than bridged over a gap we cannot vouch for.
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    if (point.reading.band_floored) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);

  const bandSegments = runs
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const top = segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.yHigh}`);
      const bottom = [...segment]
        .reverse()
        .map((point) => `L${point.x},${point.yLow}`);
      return `${top.join("")}${bottom.join("")}Z`;
    });

  const expectedSegments = runs
    .filter((segment) => segment.length > 1)
    .map((segment) =>
      segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.yExpected}`).join(""),
    );

  // The actual line spans every day, including floored ones — orders happened
  // even on days the band cannot judge.
  const actualSegments =
    points.length > 1
      ? [points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.yActual}`).join("")]
      : [];

  const stageMarks: { stageIndex: number; x: number }[] = [];
  points.forEach((point, index) => {
    const previous = index === 0 ? null : points[index - 1]!;
    if (previous && point.reading.stage_index > previous.reading.stage_index) {
      stageMarks.push({ stageIndex: point.reading.stage_index, x: point.x });
    }
  });

  const lastIndex = points.length - 1;
  const middleIndex = Math.floor(lastIndex / 2);
  const dayLabels = [
    { x: points[0]!.x, day: points[0]!.reading.day, anchor: "start" as const },
    ...(lastIndex > 2
      ? [{ x: points[middleIndex]!.x, day: points[middleIndex]!.reading.day, anchor: "middle" as const }]
      : []),
    ...(lastIndex > 0
      ? [{ x: points[lastIndex]!.x, day: points[lastIndex]!.reading.day, anchor: "end" as const }]
      : []),
  ];

  return {
    points,
    max,
    width,
    height,
    pad,
    step,
    y,
    bandSegments,
    expectedSegments,
    actualSegments,
    stageMarks,
    dayLabels,
  };
}
