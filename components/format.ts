import { formatCents, type Cents } from "@/lib/money";

/**
 * Presentation helpers.
 *
 * Money formatting delegates to `lib/money.formatCents` — one implementation for
 * the whole app, so a price in the UI can never disagree with a price in an
 * email or a CSV. Everything here adds are the UI's own affordances: an em dash
 * for unknown, an explicit sign for deltas, and timezone-pinned dates.
 *
 * Money is integer cents everywhere; this file is the only place it becomes a
 * decimal string (CLAUDE.md).
 */

export type { Cents };

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
  if (!showCents) {
    const whole = Math.round(Math.abs(cents) / 100);
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(whole);
    return cents < 0 ? `${MINUS}${formatted}` : formatted;
  }
  const formatted = formatCents(Math.abs(cents), currency);
  return cents < 0 ? `${MINUS}${formatted}` : formatted;
}

/** Signed money, for deltas. Zero renders plainly, not as "+$0". */
export function formatMoneyDelta(
  cents: Cents | null | undefined,
  options: { currency?: string; showCents?: boolean } = {},
): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return DASH;
  if (cents === 0) return formatMoney(0, options);
  const magnitude = formatMoney(Math.abs(cents), options);
  return `${cents > 0 ? "+" : MINUS}${magnitude}`;
}

/**
 * Percentage **points**, the way the contracts carry them: `12.5` → `"12.5%"`
 * (contracts/README.md — percentages are plain numbers, not fractions).
 */
export function formatPct(points: number | null | undefined, digits = 1): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return DASH;
  const rounded = Math.abs(points);
  const text = digits === 0 ? Math.round(rounded).toString() : rounded.toFixed(digits);
  return `${text}%`;
}

/** Signed percentage points: `-8.5` → `"−8.5%"`. */
export function formatPctDelta(points: number | null | undefined, digits = 1): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return DASH;
  if (points === 0) return `${digits === 0 ? "0" : (0).toFixed(digits)}%`;
  return `${points > 0 ? "+" : MINUS}${formatPct(points, digits)}`;
}

export function formatUnits(units: number | null | undefined, digits = 0): string {
  if (units === null || units === undefined || !Number.isFinite(units)) return DASH;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(units);
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/** `"7 products"` — count and noun together, the way copy usually needs it. */
export function countOf(count: number, singular: string, plural?: string): string {
  return `${formatUnits(count)} ${pluralize(count, singular, plural)}`;
}

/** `"2026-07-23"` or an ISO instant → `"23 Jul"`. */
export function formatDay(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return DASH;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: TIME_ZONE,
  }).format(date);
}

export function formatDayLong(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return DASH;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(date);
}

/** `"23 Jul, 6:00 am"` — journal rows, event logs. */
export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return DASH;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TIME_ZONE,
  })
    .format(date)
    .replace(/\s?([ap])m/i, (_match, meridiem: string) => ` ${meridiem.toLowerCase()}m`);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Bare calendar days are read as UTC midnight, matching TIME_ZONE, so
  // "2026-07-23" never renders as the 22nd.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Margin as percentage points of price. `null` when cost is unknown — the caller
 * must render "profit unknown — add cost" rather than a fabricated number (R3).
 */
export function marginPct(priceCents: Cents, cogsCents: Cents | null): number | null {
  if (cogsCents === null || priceCents <= 0) return null;
  return ((priceCents - cogsCents) / priceCents) * 100;
}

/** Parses what a merchant types into a money field. Returns integer cents. */
export function parseMoneyToCents(input: string): Cents | null {
  const cleaned = input.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Cents → the string a money input should hold. `1250` → `"12.50"`. */
export function centsToInputValue(cents: Cents | null): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}

export { DASH, MINUS };
