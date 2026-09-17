"use client";

import { useId, useMemo, useState } from "react";
import { formatDay } from "@/components/format";
import { readingSentence } from "@/lib/engine/readings";
import type { RolloutReading } from "@/lib/types";

/** Accent blue for the expected band — not the mint surface tint. */
export const BAND_STROKE = "#1E2EDE";
const BAND_FILL = "rgba(30, 46, 222, 0.1)";
/** Navy actual stroke — matches `--pf-ink`. */
export const ACTUAL_STROKE = "#0d2168";
/** Neon is reserved for the live (latest) mark. */
const LIVE_MARK = "#d8f24b";

export type BandAccessors<T> = {
  day: (row: T) => string;
  actual: (row: T) => number | null;
  expected: (row: T) => number | null;
  low: (row: T) => number | null;
  high: (row: T) => number | null;
  bandFloored: (row: T) => boolean;
  stageIndex: (row: T) => number;
  sentence: (row: T) => string;
};

export const unitsAccessors: BandAccessors<RolloutReading> = {
  day: (row) => row.day,
  actual: (row) => row.actual_units,
  expected: (row) => row.expected_units,
  low: (row) => row.expected_low,
  high: (row) => row.expected_high,
  bandFloored: (row) => row.band_floored,
  stageIndex: (row) => row.stage_index,
  sentence: (row) => readingSentence(row),
};

export const revenueAccessors: BandAccessors<RolloutReading> = {
  day: (row) => row.day,
  actual: (row) => row.actual_revenue_cents,
  expected: (row) => row.expected_revenue_cents ?? null,
  low: (row) => row.expected_revenue_low_cents ?? null,
  high: (row) => row.expected_revenue_high_cents ?? null,
  bandFloored: (row) =>
    row.band_floored ||
    row.expected_revenue_low_cents == null ||
    row.expected_revenue_high_cents == null,
  stageIndex: (row) => row.stage_index,
  sentence: (row) => readingSentence(row),
};

export const profitAccessors: BandAccessors<RolloutReading> = {
  day: (row) => row.day,
  actual: (row) => row.actual_profit_cents,
  expected: (row) => row.expected_profit_cents ?? null,
  low: (row) => row.expected_profit_low_cents ?? null,
  high: (row) => row.expected_profit_high_cents ?? null,
  bandFloored: (row) =>
    row.band_floored ||
    row.actual_profit_cents === null ||
    row.expected_profit_low_cents == null ||
    row.expected_profit_high_cents == null,
  stageIndex: (row) => row.stage_index,
  sentence: (row) =>
    row.actual_profit_cents === null
      ? "Profit unknown — a cost is missing, so we will not draw one."
      : readingSentence(row),
};

export function BandTimeSeries<T>({
  readings,
  accessors,
  format,
  stageCount,
  actualLabel,
  ariaLabel,
  padLeft = 30,
  liveLatest = false,
}: {
  readings: readonly T[];
  accessors: BandAccessors<T>;
  format: (value: number) => string;
  stageCount: number;
  actualLabel: string;
  ariaLabel: string;
  padLeft?: number;
  liveLatest?: boolean;
}) {
  const clipId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const geometry = useMemo(
    () => build(readings, accessors, padLeft),
    [readings, accessors, padLeft],
  );
  if (!geometry) return null;

  const { points, max, min, width, height, pad } = geometry;
  const active = hover !== null ? points[hover] : null;
  const last = points[points.length - 1]!;

  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          className="block h-[13rem] touch-none select-none sm:h-[15rem]"
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={`pf-clip-${clipId}`}>
              <rect x={pad.left} y={0} width={width - pad.left - pad.right} height={height} />
            </clipPath>
          </defs>
          {[min, 0, max]
            .filter((value, index, all) => all.indexOf(value) === index)
            .filter((value) => value === min || value === max || (min < 0 && max > 0 && value === 0))
            .map((value) => (
              <g key={value}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={geometry.y(value)}
                  y2={geometry.y(value)}
                  className="stroke-border"
                  strokeWidth={1}
                  strokeDasharray={value === 0 && min < 0 ? "2 2" : undefined}
                />
                <text
                  x={pad.left - 6}
                  y={geometry.y(value) + 3}
                  textAnchor="end"
                  className="fill-ink-subtle text-[9px] tabular-nums"
                >
                  {format(value)}
                </text>
              </g>
            ))}
          {geometry.stageMarks.map((mark) => (
            <g key={mark.stageIndex}>
              <line
                x1={mark.x}
                x2={mark.x}
                y1={8}
                y2={geometry.y(Math.min(0, min))}
                className="stroke-ink-subtle"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text x={mark.x + 4} y={14} className="fill-ink-subtle text-[9px]">
                Step {mark.stageIndex + 1} of {stageCount}
              </text>
            </g>
          ))}
          <g clipPath={`url(#pf-clip-${clipId})`}>
            {geometry.bandSegments.map((segment, index) => (
              <path key={index} d={segment} fill={BAND_FILL} stroke={BAND_STROKE} strokeWidth={1} />
            ))}
            {geometry.expectedSegments.map((segment, index) => (
              <path
                key={index}
                d={segment}
                fill="none"
                className="stroke-ink-subtle"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ))}
            {geometry.actualSegments.map((segment, index) => (
              <path
                key={index}
                d={segment}
                fill="none"
                stroke={ACTUAL_STROKE}
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
          </g>
          {points.map((point, index) => {
            const missing = point.actual === null;
            const floored = point.bandFloored;
            const below =
              !floored && point.actual !== null && point.low !== null && point.actual < point.low;
            const isLiveMark = liveLatest && index === points.length - 1 && !missing;
            return (
              <g key={point.day}>
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
                  aria-label={point.sentence}
                  className="cursor-pointer outline-none focus-visible:fill-accent-tint/40"
                />
                {missing ? null : (
                  <circle
                    cx={point.x}
                    cy={point.yActual}
                    r={hover === index ? 5.5 : 4.5}
                    strokeWidth={2}
                    className="stroke-surface"
                    fill={
                      isLiveMark ? LIVE_MARK : floored ? "#5a6790" : below ? "#bc2e27" : ACTUAL_STROKE
                    }
                  />
                )}
              </g>
            );
          })}
          {last.actual !== null ? (
            <text
              x={last.x}
              y={last.yActual - 12}
              textAnchor="end"
              className="fill-ink text-[11px] font-semibold tabular-nums"
            >
              {format(last.actual)}
            </text>
          ) : null}
          {geometry.dayLabels.map((label) => (
            <text
              key={`${label.x}-${label.day}`}
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
              transform: active.x > geometry.width * 0.6 ? "translateX(-104%)" : "translateX(4%)",
            }}
          >
            <p className="text-xs font-semibold text-ink">{formatDay(active.day)}</p>
            <p className="mt-0.5 text-xs text-ink-muted">{active.sentence}</p>
          </div>
        ) : null}
      </div>
      <figcaption className="mt-3">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
          <li className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-6 rounded-sm"
              style={{ background: BAND_FILL, border: `1px solid ${BAND_STROKE}` }}
              aria-hidden="true"
            />
            Range we expected
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0 w-6 border-t-2 border-dashed border-ink-subtle" aria-hidden="true" />
            What we expected
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0 w-6 border-t-2" style={{ borderColor: ACTUAL_STROKE }} aria-hidden="true" />
            {actualLabel}
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-breach ring-2 ring-surface" aria-hidden="true" />
            Below the range
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-ink-subtle ring-2 ring-surface" aria-hidden="true" />
            Too quiet to judge
          </li>
          {liveLatest ? (
            <li className="flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-full ring-2 ring-surface"
                style={{ background: LIVE_MARK }}
                aria-hidden="true"
              />
              Latest day
            </li>
          ) : null}
        </ul>
      </figcaption>
    </figure>
  );
}

type Point = {
  day: string;
  sentence: string;
  stageIndex: number;
  bandFloored: boolean;
  actual: number | null;
  expected: number | null;
  low: number | null;
  high: number | null;
  x: number;
  yActual: number;
  yLow: number;
  yHigh: number;
  yExpected: number;
};

function build<T>(readings: readonly T[], accessors: BandAccessors<T>, padLeft: number) {
  if (readings.length === 0) return null;
  const width = 640;
  const height = 200;
  const pad = { left: padLeft, right: 14, top: 22, bottom: 18 };
  let peak = 0;
  let floor = 0;
  for (const reading of readings) {
    const actual = accessors.actual(reading);
    const high = accessors.high(reading);
    const low = accessors.low(reading);
    const expected = accessors.expected(reading);
    const floored = accessors.bandFloored(reading);
    if (actual !== null) {
      peak = Math.max(peak, actual);
      floor = Math.min(floor, actual);
    }
    if (!floored) {
      if (high !== null) peak = Math.max(peak, high);
      if (low !== null) floor = Math.min(floor, low);
      if (expected !== null) {
        peak = Math.max(peak, expected);
        floor = Math.min(floor, expected);
      }
    }
  }
  const max = niceBound(peak, 1) || 10;
  const min = floor < 0 ? niceBound(floor, -1) : 0;
  const span = max - min || 1;
  const plotWidth = width - pad.left - pad.right;
  const step = readings.length > 1 ? plotWidth / (readings.length - 1) : plotWidth;
  const y = (value: number) =>
    height - pad.bottom - ((clamp(value, min, max) - min) / span) * (height - pad.top - pad.bottom);
  const x = (index: number) =>
    readings.length > 1 ? pad.left + index * step : pad.left + plotWidth / 2;
  const points: Point[] = readings.map((reading, index) => {
    const actual = accessors.actual(reading);
    const expected = accessors.expected(reading);
    const low = accessors.low(reading);
    const high = accessors.high(reading);
    return {
      day: accessors.day(reading),
      sentence: accessors.sentence(reading),
      stageIndex: accessors.stageIndex(reading),
      bandFloored: accessors.bandFloored(reading),
      actual,
      expected,
      low,
      high,
      x: x(index),
      yActual: y(actual ?? 0),
      yLow: y(low ?? 0),
      yHigh: y(high ?? 0),
      yExpected: y(expected ?? 0),
    };
  });
  const bandRuns: Point[][] = [];
  let bandRun: Point[] = [];
  for (const point of points) {
    const hasBand =
      !point.bandFloored && point.low !== null && point.high !== null && point.expected !== null;
    if (!hasBand) {
      if (bandRun.length > 0) bandRuns.push(bandRun);
      bandRun = [];
      continue;
    }
    bandRun.push(point);
  }
  if (bandRun.length > 0) bandRuns.push(bandRun);
  const bandSegments = bandRuns.map((segment) => {
    const top = segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.yHigh}`);
    const bottom = [...segment].reverse().map((point) => `L${point.x},${point.yLow}`);
    return `${top.join("")}${bottom.join("")}Z`;
  });
  const expectedSegments = bandRuns
    .filter((segment) => segment.length > 1)
    .map((segment) =>
      segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.yExpected}`).join(""),
    );
  const actualSegments = splitLine(points, (point) => point.actual !== null)
    .filter((segment) => segment.length > 1)
    .map((segment) =>
      segment.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.yActual}`).join(""),
    );
  const stageMarks: { stageIndex: number; x: number }[] = [];
  points.forEach((point, index) => {
    const previous = index === 0 ? null : points[index - 1]!;
    if (previous && point.stageIndex > previous.stageIndex) {
      stageMarks.push({ stageIndex: point.stageIndex, x: point.x });
    }
  });
  const lastIndex = points.length - 1;
  const middleIndex = Math.floor(lastIndex / 2);
  const dayLabels = [
    { x: points[0]!.x, day: points[0]!.day, anchor: "start" as const },
    ...(lastIndex > 2
      ? [{ x: points[middleIndex]!.x, day: points[middleIndex]!.day, anchor: "middle" as const }]
      : []),
    ...(lastIndex > 0
      ? [{ x: points[lastIndex]!.x, day: points[lastIndex]!.day, anchor: "end" as const }]
      : []),
  ];
  return {
    points,
    max,
    min,
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

function splitLine<P>(points: readonly P[], keep: (point: P) => boolean): P[][] {
  const runs: P[][] = [];
  let run: P[] = [];
  for (const point of points) {
    if (!keep(point)) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function niceBound(value: number, direction: 1 | -1): number {
  if (value === 0) return 0;
  const abs = Math.abs(value) * 1.12;
  const mag = Math.pow(10, Math.floor(Math.log10(abs)));
  const step = mag / 2;
  return (direction < 0 ? -1 : 1) * Math.ceil(abs / step) * step;
}
