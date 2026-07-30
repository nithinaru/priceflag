/**
 * Formatting is the only place in the app where integer cents become a decimal.
 * Nothing else divides by 100 (BUILD_BRIEF §2.7: money is integer cents).
 *
 * Every formatter here is deterministic and timezone-pinned, so a value renders
 * identically on the server and in the browser. Dates arriving from the engine
 * are store-local calendar days (`YYYY-MM-DD`) or instants (ISO); both are
 * formatted in UTC until Lane B exposes the shop timezone.
 */

export type Cents = number;

const DASH = "—";
/** U+2212 MINUS SIGN — aligns with digits; the ASCII hyphen does not. */
const MINUS = "−";

const TIME_ZONE = "UTC";

export function formatMoney(
  cents: Cents | null | undefined,
  options: { currency?: string; showCents?: boolean } = {},
): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return DASH;
  const { currency = "USD", showCents = true } = options;
  const digits = showCents ? 2 : 0;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(cents) / 100);
  return cents < 0 ? `${MINUS}${formatted}` : formatted;
}

/** Signed money, for deltas. Zero renders as an explicit "no change". */
export function formatMoneyDelta(
  cents: Cents | null | undefined,
  options: { currency?: string; showCents?: boolean } = {},
): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return DASH;
  if (cents === 0) return formatMoney(0, options);
  const magnitude = formatMoney(Math.abs(cents), options);
  return `${cents > 0 ? "+" : MINUS}${magnitude}`;
}

/** `0.0625` → `"6.3%"`. Takes a fraction, not a percentage. */
export function formatPercent(
  fraction: number | null | undefined,
  options: { digits?: number } = {},
): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH;
  const { digits = 1 } = options;
  return `${(Math.abs(fraction) * 100).toFixed(digits)}%`;
}

/** `-0.0625` → `"−6.3%"`. */
export function formatPercentDelta(
  fraction: number | null | undefined,
  options: { digits?: number } = {},
): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH;
  const { digits = 1 } = options;
  if (fraction === 0) return `${(0).toFixed(digits)}%`;
  return `${fraction > 0 ? "+" : MINUS}${formatPercent(fraction, options)}`;
}

/**
 * Whole percentage points, as merchants write them: `30` → `"30%"`.
 * Used for stage shares and guardrail sentences, which are always whole.
 */
export function formatPercentPoints(points: number | null | undefined): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return DASH;
  return `${Math.round(points)}%`;
}

export function formatUnits(units: number | null | undefined): string {
  if (units === null || units === undefined || !Number.isFinite(units)) return DASH;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(units);
}

/** `"12 units"` / `"1 unit"`. */
export function formatUnitsWithLabel(units: number | null | undefined): string {
  if (units === null || units === undefined || !Number.isFinite(units)) return DASH;
  return `${formatUnits(units)} ${Math.abs(units) === 1 ? "unit" : "units"}`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/** `"7 products"` — count and noun together, the way copy usually needs it. */
export function countOf(count: number, singular: string, plural?: string): string {
  return `${formatUnits(count)} ${pluralize(count, singular, plural)}`;
}

/** `"2026-07-23"` or an ISO instant → `"Jul 23"`. */
export function formatDay(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

/** `"Jul 23, 2026"` — for anything that might cross a year boundary. */
export function formatDayLong(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

/** `"Jul 23, 6:00 AM"` — journal rows, event logs. */
export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(date);
}

/** Whole days between two calendar days, inclusive of the first. */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  const ms = b.getTime() - a.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** `"Day 4 of 7"` phrasing for stage progress. */
export function formatDayOf(current: number, total: number): string {
  return `Day ${formatUnits(current)} of ${formatUnits(total)}`;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Bare calendar days are parsed as UTC midnight, matching TIME_ZONE, so
  // "2026-07-23" never renders as the 22nd.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Margin as a fraction of price. `null` when cost is unknown — the caller must
 * render the "profit unknown — add cost" state rather than a fabricated number
 * (PRD R3).
 */
export function marginFraction(priceCents: Cents, cogsCents: Cents | null): number | null {
  if (cogsCents === null || priceCents <= 0) return null;
  return (priceCents - cogsCents) / priceCents;
}

export { DASH, MINUS };
