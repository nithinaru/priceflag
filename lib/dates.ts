/**
 * Calendar days in the shop's timezone.
 *
 * Every daily aggregate and every evaluator decision is about a day in the
 * *merchant's* calendar. Doing this in UTC means a store in Los Angeles has its
 * day boundary at 5pm local, so a rollout advances or rolls back on the wrong
 * day's data — and the merchant is looking at a different number than the
 * evaluator is.
 *
 * A "day" here is always the string `YYYY-MM-DD`.
 */

export type DayString = string;

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDayString(value: unknown): value is DayString {
  return typeof value === 'string' && DAY_PATTERN.test(value);
}

export function assertDayString(value: unknown, label = 'day'): DayString {
  if (!isDayString(value)) throw new TypeError(`${label} must be YYYY-MM-DD, got ${String(value)}`);
  return value;
}

/** The calendar day `instant` falls on, in `timeZone`. */
export function dayInTimeZone(instant: Date, timeZone = 'UTC'): DayString {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function today(timeZone = 'UTC', now: Date = new Date()): DayString {
  return dayInTimeZone(now, timeZone);
}

export function yesterday(timeZone = 'UTC', now: Date = new Date()): DayString {
  return addDays(today(timeZone, now), -1);
}

/**
 * Day arithmetic via UTC noon. Anchoring at noon means a ±1h DST shift can never
 * push the result into the neighbouring date, which midnight anchoring can.
 */
export function addDays(day: DayString, delta: number): DayString {
  assertDayString(day);
  const anchor = Date.parse(`${day}T12:00:00Z`);
  return new Date(anchor + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function diffDays(from: DayString, to: DayString): number {
  assertDayString(from, 'from');
  assertDayString(to, 'to');
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

/** Inclusive list of days. */
export function dayRange(from: DayString, to: DayString): DayString[] {
  const span = diffDays(from, to);
  if (span < 0) return [];
  const days: DayString[] = [];
  for (let i = 0; i <= span; i += 1) days.push(addDays(from, i));
  return days;
}

/** ISO day of week, 1 = Monday … 7 = Sunday. Matches Postgres `isodow`. */
export function isoDayOfWeek(day: DayString): number {
  assertDayString(day);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return weekday === 0 ? 7 : weekday;
}

export function isWeekend(day: DayString): boolean {
  return isoDayOfWeek(day) >= 6;
}

/** Midnight-to-midnight UTC instants spanning a shop-timezone day. */
export function dayBoundsUtc(day: DayString, timeZone = 'UTC'): { start: Date; end: Date } {
  assertDayString(day);
  // Find the UTC instant whose shop-local day is `day` and local time is 00:00,
  // by probing the offset at noon of that day. One probe is enough: a day
  // boundary is never inside a DST transition for any real IANA zone.
  const noonUtc = Date.parse(`${day}T12:00:00Z`);
  const offsetMinutes = timeZoneOffsetMinutes(new Date(noonUtc), timeZone);
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + DAY_MS);
  return { start, end };
}

/** Offset of `timeZone` from UTC in minutes at `instant` (east positive). */
export function timeZoneOffsetMinutes(instant: Date, timeZone = 'UTC'): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** True when the timezone name is one this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * A day as a merchant reads it: `25 Jul`. Never an ISO string.
 *
 * Requested by Lane A (REQ-A-005): every date the UI formats itself renders this
 * way, but sentences generated here are rendered verbatim, so an ISO date reached
 * the screen through the event log. Formatting at the point of generation keeps
 * one implementation.
 */
export function formatDayShort(day: DayString, locale = 'en-GB'): string {
  assertDayString(day);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
