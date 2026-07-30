import { cn } from "@/components/cn";

/**
 * The predicted range, drawn.
 *
 * A range is the whole point of an honest forecast, and a number pair reads as
 * two facts rather than one interval — so it gets a mark. Hand-authored SVG: no
 * chart dependency, and at this size a library would be 100 kB to draw four
 * shapes on a page merchants open on phones.
 *
 * Conventions (repo dataviz rules): one series so no legend box — the label
 * above names it; the band is a recessive fill with a defined edge; the expected
 * value is a single marker with a surface ring so it stays visible on the band;
 * "no change" is a real reference line, because whether the range crosses zero
 * is the actual question; values are direct-labelled at the ends rather than on
 * an axis; colour never carries meaning alone.
 */
export function RangeBar({
  low,
  high,
  expected,
  format,
  label,
  tone = "auto",
  className,
}: {
  low: number;
  high: number;
  /** Point estimate inside the range. */
  expected: number;
  format: (value: number) => string;
  /** Accessible name — the visible label lives above the bar in the caller. */
  label: string;
  /**
   * `auto` tints an entirely-below-zero range as bad, which is right for profit.
   * `neutral` is for measures where falling is simply expected — orders drop when
   * a price goes up, and painting that red would be editorialising.
   */
  tone?: "auto" | "neutral";
  className?: string;
}) {
  const width = 320;
  const height = 34;
  const padX = 2;
  const midY = 15;

  const min = Math.min(low, high, expected, 0);
  const max = Math.max(low, high, expected, 0);
  const span = max - min || 1;
  const x = (value: number) => padX + ((value - min) / span) * (width - padX * 2);

  const bandLeft = Math.min(x(low), x(high));
  const bandWidth = Math.max(2, Math.abs(x(high) - x(low)));
  const crossesZero = low < 0 && high > 0;
  const allBad = tone === "auto" && high <= 0;

  return (
    <div className={cn("space-y-1", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: between ${format(low)} and ${format(high)}, most likely ${format(
          expected,
        )}.`}
        className="overflow-visible"
      >
        {/* The full extent, so a narrow band still reads as a position. */}
        <line
          x1={padX}
          x2={width - padX}
          y1={midY}
          y2={midY}
          className="stroke-border"
          strokeWidth={1}
        />

        {/* "No change" — whether the range crosses it is the real question. */}
        <line
          x1={x(0)}
          x2={x(0)}
          y1={midY - 9}
          y2={midY + 9}
          className="stroke-border-strong"
          strokeWidth={1}
          strokeDasharray="2 2"
        />

        <rect
          x={bandLeft}
          y={midY - 5}
          width={bandWidth}
          height={10}
          rx={3}
          className={cn(
            allBad ? "fill-breach-tint stroke-breach-border" : "fill-accent-tint stroke-accent-border",
          )}
          strokeWidth={1}
        />

        <circle
          cx={x(expected)}
          cy={midY}
          r={4.5}
          className={cn(allBad ? "fill-breach" : "fill-accent", "stroke-surface")}
          strokeWidth={2}
        />
      </svg>

      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums text-ink-muted">
        <span>{format(low)}</span>
        {crossesZero ? (
          <span className="text-ink-subtle">could go either way</span>
        ) : null}
        <span>{format(high)}</span>
      </div>
    </div>
  );
}
