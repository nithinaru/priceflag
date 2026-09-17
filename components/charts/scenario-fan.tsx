"use client";

import { formatMoneyDelta, formatPctDelta } from "@/components/format";
import { ACTUAL_STROKE, BAND_STROKE } from "@/components/charts/band-time-series";
import type { ForecastResult } from "@/lib/contracts";

/**
 * Profit against unit-sales change at each scenario. Hidden when there is no
 * trading, and omitted entirely if any scenario's profit is unknown.
 */
export function ScenarioFan({ forecast }: { forecast: ForecastResult }) {
  if (forecast.baseline.units_per_day <= 0) return null;
  if (forecast.scenarios.some((scenario) => scenario.profit_delta_cents === null)) return null;
  const geometry = buildFan(forecast);
  if (!geometry) return null;
  const money = (cents: number) =>
    formatMoneyDelta(cents, { currency: forecast.currency, showCents: false });
  const { points, width, height, pad, breakeven } = geometry;

  return (
    <figure className="m-0 px-4 py-4 sm:px-5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        className="block h-[12rem] sm:h-[14rem]"
        role="img"
        aria-label={`Profit against unit-sales change at each scenario. Breakeven is ${
          breakeven
            ? `${formatPctDelta(breakeven.units_change_pct, 1)} unit sales, ${money(
                breakeven.profit_delta_cents,
              )} profit.`
            : "marked where profit is unchanged"
        }. The table below has the same numbers.`}
      >
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={geometry.y(0)}
          y2={geometry.y(0)}
          className="stroke-border"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
        <text x={pad.left - 6} y={geometry.y(0) + 3} textAnchor="end" className="fill-ink-subtle text-[9px] tabular-nums">
          {money(0)}
        </text>
        <text x={pad.left - 6} y={geometry.y(geometry.maxY) + 3} textAnchor="end" className="fill-ink-subtle text-[9px] tabular-nums">
          {money(geometry.maxY)}
        </text>
        {geometry.minY < 0 ? (
          <text x={pad.left - 6} y={geometry.y(geometry.minY) + 3} textAnchor="end" className="fill-ink-subtle text-[9px] tabular-nums">
            {money(geometry.minY)}
          </text>
        ) : null}
        <line
          x1={geometry.x(0)}
          x2={geometry.x(0)}
          y1={pad.top}
          y2={height - pad.bottom}
          className="stroke-border"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
        <path d={geometry.line} fill="none" stroke={ACTUAL_STROKE} strokeWidth={2} />
        {points.map((point) => (
          <g key={point.label}>
            <circle
              cx={point.x}
              cy={point.y}
              r={point.is_breakeven ? 5.5 : 4}
              fill={point.is_breakeven ? BAND_STROKE : ACTUAL_STROKE}
              className="stroke-surface"
              strokeWidth={2}
            />
            {point.is_breakeven ? (
              <text x={point.x + 8} y={point.y - 8} className="fill-ink text-[10px] font-medium">
                Breakeven
              </text>
            ) : null}
          </g>
        ))}
        {geometry.xLabels.map((label) => (
          <text
            key={label.pct}
            x={label.x}
            y={height - 4}
            textAnchor={label.anchor}
            className="fill-ink-subtle text-[9px] tabular-nums"
          >
            {formatPctDelta(label.pct, 0)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-2">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-muted">
          <li className="flex items-center gap-1.5">
            <span className="h-0 w-6 border-t-2" style={{ borderColor: ACTUAL_STROKE }} aria-hidden="true" />
            Profit if unit sales change by this much
          </li>
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full ring-2 ring-surface" style={{ background: BAND_STROKE }} aria-hidden="true" />
            Breakeven — profit unchanged
          </li>
        </ul>
      </figcaption>
    </figure>
  );
}

function buildFan(forecast: ForecastResult) {
  const scenarios = [...forecast.scenarios].sort((a, b) => a.units_change_pct - b.units_change_pct);
  if (scenarios.length === 0) return null;
  if (scenarios.some((scenario) => scenario.profit_delta_cents === null)) return null;
  const width = 640;
  const height = 180;
  const pad = { left: 56, right: 16, top: 18, bottom: 18 };
  const xs = scenarios.map((scenario) => scenario.units_change_pct);
  const ys = scenarios.map((scenario) => scenario.profit_delta_cents as number);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0, ...xs);
  let minY = Math.min(0, ...ys);
  let maxY = Math.max(0, ...ys);
  if (minY === maxY) {
    maxY = minY + 100;
    minY = minY - 100;
  }
  const padY = (maxY - minY) * 0.12;
  minY -= padY;
  maxY += padY;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const x = (pct: number) => pad.left + ((pct - minX) / spanX) * (width - pad.left - pad.right);
  const y = (cents: number) =>
    height - pad.bottom - ((cents - minY) / spanY) * (height - pad.top - pad.bottom);
  const points = scenarios.map((scenario) => ({
    label: scenario.label,
    units_change_pct: scenario.units_change_pct,
    profit_delta_cents: scenario.profit_delta_cents as number,
    is_breakeven: scenario.is_breakeven,
    x: x(scenario.units_change_pct),
    y: y(scenario.profit_delta_cents as number),
  }));
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join("");
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    points,
    width,
    height,
    pad,
    minY,
    maxY,
    x,
    y,
    line,
    xLabels: [
      { x: first.x, pct: first.units_change_pct, anchor: "start" as const },
      { x: last.x, pct: last.units_change_pct, anchor: "end" as const },
    ],
    breakeven: points.find((point) => point.is_breakeven) ?? null,
  };
}
