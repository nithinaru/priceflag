"use client";

import { useId, useMemo, useState } from "react";
import type { DailyTrading } from "@/components/charts/aggregate-trading";
import { ACTUAL_STROKE, BAND_STROKE } from "@/components/charts/band-time-series";
import { formatDay, formatMoney, formatUnits } from "@/components/format";

/**
 * Daily net revenue. Profit is a second series only on days every selling
 * variant has a cost; otherwise that day is a gap, never zero.
 */
export function StoreSeries({ days, currency }: { days: readonly DailyTrading[]; currency: string }) {
  const clipId = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const money = (cents: number) => formatMoney(cents, { currency, showCents: false });
  const showProfit = days.some((day) => day.profit_cents !== null);
  const geometry = useMemo(() => buildStore(days, showProfit), [days, showProfit]);
  if (!geometry) return null;
  const { points, width, height, pad } = geometry;
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
          aria-label={`Daily net revenue${showProfit ? " and profit" : ""} from ${formatDay(
            points[0]!.day,
          )} to ${formatDay(last.day)}. ${
            showProfit
              ? "Profit is omitted on days a selling product is missing a cost."
              : "Profit is unknown because a cost is missing."
          }`}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={`pf-store-${clipId}`}>
              <rect x={pad.left} y={0} width={width - pad.left - pad.right} height={height} />
            </clipPath>
          </defs>
          {[geometry.min, 0, geometry.max]
            .filter((value, index, all) => all.indexOf(value) === index)
            .filter(
              (value) =>
                value === geometry.min ||
                value === geometry.max ||
                (geometry.min < 0 && geometry.max > 0 && value === 0),
            )
            .map((value) => (
              <g key={value}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={geometry.y(value)}
                  y2={geometry.y(value)}
                  className="stroke-border"
                  strokeWidth={1}
                  strokeDasharray={value === 0 && geometry.min < 0 ? "2 2" : undefined}
                />
                <text x={pad.left - 6} y={geometry.y(value) + 3} textAnchor="end" className="fill-ink-subtle text-[9px] tabular-nums">
                  {money(value)}
                </text>
              </g>
            ))}
          <g clipPath={`url(#pf-store-${clipId})`}>
            {geometry.revenueSegments.map((d, index) => (
              <path key={`r-${index}`} d={d} fill="none" stroke={ACTUAL_STROKE} strokeWidth={2} strokeLinecap="round" />
            ))}
            {geometry.profitSegments.map((d, index) => (
              <path key={`p-${index}`} d={d} fill="none" stroke={BAND_STROKE} strokeWidth={1.5} strokeDasharray="4 3" />
            ))}
          </g>
          {points.map((point, index) => (
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
                aria-label={`${formatDay(point.day)}: ${money(point.revenue)} revenue, ${
                  point.profit === null ? "profit unknown" : `${money(point.profit)} profit`
                }, ${formatUnits(point.units)} units.`}
                className="cursor-pointer outline-none"
              />
              <circle
                cx={point.x}
                cy={point.yRevenue}
                r={hover === index ? 5 : 4}
                fill={ACTUAL_STROKE}
                className="stroke-surface"
                strokeWidth={2}
              />
            </g>
          ))}
          <text x={last.x} y={last.yRevenue - 12} textAnchor="end" className="fill-ink text-[11px] font-semibold tabular-nums">
            {money(last.revenue)}
          </text>
          {geometry.dayLabels.map((label) => (
            <text key={label.day} x={label.x} y={height - 4} textAnchor={label.anchor} className="fill-ink-subtle text-[9px]">
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
            <p className="mt-0.5 text-xs text-ink-muted">
              {money(active.revenue)} net revenue, {formatUnits(active.units)} units
              {active.profit === null
                ? ". Profit unknown — a selling product is missing a cost."
                : `, ${money(active.profit)} profit.`}
            </p>
          </div>
        ) : null}
      </div>
      {showProfit ? (
        <figcaption className="mt-3">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
            <li className="flex items-center gap-1.5">
              <span className="h-0 w-6 border-t-2" style={{ borderColor: ACTUAL_STROKE }} aria-hidden="true" />
              Net revenue
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-0 w-6 border-t-2 border-dashed" style={{ borderColor: BAND_STROKE }} aria-hidden="true" />
              Profit (gaps where a cost is missing)
            </li>
          </ul>
        </figcaption>
      ) : (
        <figcaption className="mt-3 text-xs text-ink-muted">
          Profit is not drawn — at least one selling product is missing a cost.
        </figcaption>
      )}
    </figure>
  );
}

function buildStore(days: readonly DailyTrading[], showProfit: boolean) {
  if (days.length === 0) return null;
  const width = 640;
  const height = 200;
  const pad = { left: 56, right: 14, top: 22, bottom: 18 };
  let peak = 0;
  let floor = 0;
  for (const day of days) {
    peak = Math.max(peak, day.revenue_cents);
    floor = Math.min(floor, day.revenue_cents);
    if (showProfit && day.profit_cents !== null) {
      peak = Math.max(peak, day.profit_cents);
      floor = Math.min(floor, day.profit_cents);
    }
  }
  const max = nice(peak, 1) || 10;
  const min = floor < 0 ? nice(floor, -1) : 0;
  const span = max - min || 1;
  const plotWidth = width - pad.left - pad.right;
  const step = days.length > 1 ? plotWidth / (days.length - 1) : plotWidth;
  const y = (value: number) =>
    height - pad.bottom - ((clamp(value, min, max) - min) / span) * (height - pad.top - pad.bottom);
  const x = (index: number) =>
    days.length > 1 ? pad.left + index * step : pad.left + plotWidth / 2;
  const points = days.map((day, index) => ({
    day: day.day,
    units: day.units,
    revenue: day.revenue_cents,
    profit: day.profit_cents,
    x: x(index),
    yRevenue: y(day.revenue_cents),
    yProfit: y(day.profit_cents ?? 0),
  }));
  const revenueSegments =
    points.length > 1
      ? [points.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.yRevenue}`).join("")]
      : [];
  const profitSegments = showProfit
    ? split(points, (point) => point.profit !== null)
        .filter((run) => run.length > 1)
        .map((run) => run.map((point, i) => `${i === 0 ? "M" : "L"}${point.x},${point.yProfit}`).join(""))
    : [];
  const lastIndex = points.length - 1;
  const middleIndex = Math.floor(lastIndex / 2);
  const dayLabels = [
    { x: points[0]!.x, day: points[0]!.day, anchor: "start" as const },
    ...(lastIndex > 2
      ? [{ x: points[middleIndex]!.x, day: points[middleIndex]!.day, anchor: "middle" as const }]
      : []),
    ...(lastIndex > 0 ? [{ x: points[lastIndex]!.x, day: points[lastIndex]!.day, anchor: "end" as const }] : []),
  ];
  return { points, min, max, width, height, pad, step, y, revenueSegments, profitSegments, dayLabels };
}

function split<P>(points: readonly P[], keep: (point: P) => boolean): P[][] {
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

function nice(value: number, direction: 1 | -1): number {
  if (value === 0) return 0;
  const abs = Math.abs(value) * 1.12;
  const mag = Math.pow(10, Math.floor(Math.log10(abs)));
  const step = mag / 2;
  return (direction < 0 ? -1 : 1) * Math.ceil(abs / step) * step;
}
