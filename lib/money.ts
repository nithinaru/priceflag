/**
 * Money. Integer cents, always — the first ground rule in the repo.
 *
 * Floats are banned for money because `0.1 + 0.2 !== 0.3` eventually becomes a
 * price that is one cent off on a storefront, and because a rounding
 * disagreement between two lanes is a silent bug that only shows up in a
 * merchant's P&L. Every conversion in and out of Shopify's decimal strings goes
 * through this file.
 */

/** An integer number of cents. `1999` is $19.99. */
export type Cents = number;

export type Rounding = 'none' | 'end_99' | 'end_95' | 'end_00';

export const ROUNDING_MODES: readonly Rounding[] = ['none', 'end_99', 'end_95', 'end_00'];

/** Shopify prices must never be free or negative. */
export const MIN_STOREFRONT_PRICE_CENTS: Cents = 1;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: unknown, label = 'value'): Cents {
  if (!isCents(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${String(value)}`);
  }
  return value;
}

/** Defense shared by planning and the final write boundary. */
export function assertStorefrontPrice(value: unknown, label = 'price'): Cents {
  const cents = assertCents(value, label);
  if (cents < MIN_STOREFRONT_PRICE_CENTS) {
    throw new RangeError(`${label} must be at least ${MIN_STOREFRONT_PRICE_CENTS} cent, got ${String(cents)}`);
  }
  return cents;
}

/**
 * Round to whole cents, half away from zero.
 *
 * `Math.round` breaks ties toward +Infinity, so it rounds -0.5 to -0 and 0.5 to
 * 1 — asymmetric, which quietly biases signed deltas. Away-from-zero keeps a
 * profit delta and its mirror-image loss the same size.
 */
export function roundCents(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new TypeError(`cannot round non-finite value ${String(value)}`);
  }
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Parse Shopify's decimal money string ("19.99") into cents, exactly.
 *
 * Deliberately not `Math.round(parseFloat(s) * 100)`: that misreads values like
 * "1.005" and drifts on long decimals. Integer arithmetic on the digit string
 * has no such failure mode.
 */
export function parseMoneyToCents(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError(`cannot parse money from ${String(input)}`);
    return roundCents(input * 100);
  }

  const raw = input.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new TypeError(`cannot parse money from ${JSON.stringify(input)}`);
  }

  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] === '' ? '0' : (match[2] as string);
  const frac = match[3] ?? '';

  let cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  // Third decimal place and beyond: round half up on the magnitude.
  if (frac.length > 2 && (frac[2] as string) >= '5') cents += 1;

  return sign * cents;
}

/** Format cents as the decimal string Shopify's Admin API expects: `1999` -> "19.99". */
export function formatCentsAsShopifyMoney(cents: Cents): string {
  assertCents(cents, 'cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Merchant-facing money. Percentages and money are never rendered raw (R25). */
export function formatCents(cents: Cents, currency = 'USD', locale = 'en-US'): string {
  assertCents(cents, 'cents');
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** Signed percentage with an explicit sign, e.g. `+12.5%`. */
export function formatPct(pct: number, digits = 1): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

/** `pct` is in percentage points: `-10` is a 10% cut. */
export function applyPercent(base: Cents, pct: number): Cents {
  assertCents(base, 'base');
  if (!Number.isFinite(pct)) throw new TypeError(`pct must be finite, got ${String(pct)}`);
  return Math.max(0, roundCents(base * (1 + pct / 100)));
}

export function applyAbsolute(base: Cents, deltaCents: Cents): Cents {
  assertCents(base, 'base');
  assertCents(deltaCents, 'deltaCents');
  return Math.max(0, base + deltaCents);
}

/**
 * Snap a price to a psychological ending. Picks the nearest candidate so a
 * rounding rule never quietly moves a price by most of a dollar; ties go up,
 * because rounding a price down by accident costs the merchant margin.
 */
export function applyRounding(cents: Cents, mode: Rounding): Cents {
  assertCents(cents, 'cents');
  if (mode === 'none') return cents;
  if (cents <= 0) return cents;

  const ending = mode === 'end_99' ? 99 : mode === 'end_95' ? 95 : 0;
  const dollars = Math.floor(cents / 100);

  const candidates =
    ending === 0
      ? [dollars * 100, (dollars + 1) * 100]
      : [(dollars - 1) * 100 + ending, dollars * 100 + ending, (dollars + 1) * 100 + ending];

  let best = cents;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate < 1) continue;
    const distance = Math.abs(candidate - cents);
    // `<=` so that on a tie the later (higher) candidate wins.
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** ISO-4217 currencies Shopify stores with no subunit — prices are whole major units only. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Smallest representable price step in cents for `currency`. 100 for zero-decimal currencies. */
export function currencyQuantumCents(currency?: string): Cents {
  return currency !== undefined && ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 100 : 1;
}

/**
 * Snap to the nearest price Shopify can represent in `currency`. A fractional-yen
 * price would be silently rounded by Shopify and then fail our own write
 * verification, so unrepresentable targets must never leave the planner.
 */
export function snapToCurrency(cents: Cents, currency?: string): Cents {
  assertCents(cents, 'cents');
  const quantum = currencyQuantumCents(currency);
  if (quantum === 1) return cents;
  return Math.round(cents / quantum) * quantum;
}

/** Percentage change from `from` to `to`, in percentage points. `null` when undefined. */
export function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/** Sum with an integer guarantee — aggregates of cents are still cents. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total += assertCents(value, 'value');
  return total;
}
