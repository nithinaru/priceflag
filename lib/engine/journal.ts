/**
 * The price journal.
 *
 * Two jobs, and the second one is why this file is careful:
 *
 *   1. The merchant-facing history of every price change (R18).
 *   2. The recovery path. When something has gone wrong in a way the app cannot
 *      fix, `PILOT_RUNBOOK.md` restores prices from these rows with plain SQL.
 *      That only works if `before_price_cents` is always the true previous price.
 *
 * The idempotency key is the other half of safe price writes: the same intended
 * write produces the same key, the unique index rejects the duplicate, and a
 * retried stage application therefore cannot double-write or double-journal (R12).
 */

import { nowIso } from '../dates';
import { formatCents, type Cents } from '../money';
import type { JournalEntryContract } from '../contracts';
import { CONTRACT_VERSION } from '../contracts';
import type { JournalEntry, JournalEntryCreate, JournalSource, JournalStatus } from '../types';

/**
 * Key for a stage application. Includes the target price so that an *edited*
 * intent is a different write, but a *retried* identical intent is not.
 */
export function rolloutIdempotencyKey(
  rolloutId: string,
  stageIndex: number,
  variantGid: string,
  targetPriceCents: Cents,
): string {
  return `rollout:${rolloutId}:${stageIndex}:${variantGid}:${targetPriceCents}`;
}

/**
 * Key for a revert. Deliberately has no stage in it: a rollback restores one
 * baseline per variant, and a retried rollback must collapse onto the same row
 * however many times the evaluator asks for it.
 */
export function rollbackIdempotencyKey(
  rolloutId: string,
  variantGid: string,
  baselinePriceCents: Cents,
): string {
  return `rollback:${rolloutId}:${variantGid}:${baselinePriceCents}`;
}

export interface PriceWriteRecord {
  variant_gid: string;
  product_gid: string;
  title: string;
  sku: string | null;
  before_price_cents: Cents;
  after_price_cents: Cents;
  before_compare_at_cents: Cents | null;
  after_compare_at_cents: Cents | null;
  currency: string;
}

export interface JournalContext {
  source: JournalSource;
  actor: JournalEntry['actor'];
  rollout_id?: string | null;
  rollout_name?: string | null;
  stage_index?: number | null;
  reason?: string;
  status?: JournalStatus;
  idempotency_key?: string | null;
  error?: string | null;
  shopify_user_errors?: unknown;
  applied_at?: string;
}

export function buildJournalEntry(record: PriceWriteRecord, context: JournalContext): JournalEntryCreate {
  const status = context.status ?? 'applied';
  return {
    variant_gid: record.variant_gid,
    product_gid: record.product_gid,
    title: record.title,
    sku: record.sku,
    rollout_id: context.rollout_id ?? null,
    stage_index: context.stage_index ?? null,
    source: context.source,
    actor: context.actor,
    reason: context.reason ?? defaultReason(context, record),
    status,
    before_price_cents: record.before_price_cents,
    after_price_cents: record.after_price_cents,
    before_compare_at_cents: record.before_compare_at_cents,
    after_compare_at_cents: record.after_compare_at_cents,
    currency: record.currency,
    idempotency_key: context.idempotency_key ?? null,
    error: context.error ?? null,
    shopify_user_errors: context.shopify_user_errors ?? null,
    applied_at: context.applied_at ?? nowIso(),
  };
}

function defaultReason(context: JournalContext, record: PriceWriteRecord): string {
  const from = formatCents(record.before_price_cents, record.currency);
  const to = formatCents(record.after_price_cents, record.currency);

  switch (context.source) {
    case 'rollout':
      return context.stage_index === null || context.stage_index === undefined
        ? `Price changed from ${from} to ${to} by a Priceflag rollout.`
        : `Stage ${context.stage_index + 1} of ${context.rollout_name ?? 'a rollout'}: ${from} → ${to}.`;
    case 'rollback':
      return `Rolled back to ${to} from ${from}${context.rollout_name ? ` (${context.rollout_name})` : ''}.`;
    case 'kill_switch':
      return `Store-wide undo: restored to ${to}.`;
    case 'external':
      return `Changed outside Priceflag, from ${from} to ${to}.`;
    case 'manual':
      return `Changed by hand in Priceflag, from ${from} to ${to}.`;
    case 'seed':
      return 'Starting price recorded when the store was connected.';
    default:
      return `Price changed from ${from} to ${to}.`;
  }
}

/**
 * A price change we did not make, detected from `products/update` (R4). It is
 * journalled as `external` and it pauses any rollout touching the variant —
 * mis-attributing somebody's manual promo to our own price change would poison
 * both the guardrails and the post-rollout report.
 */
export function buildExternalChangeEntry(
  record: PriceWriteRecord,
  options: { rollout_id?: string | null; detected_at?: string } = {},
): JournalEntryCreate {
  return buildJournalEntry(record, {
    source: 'external',
    actor: 'shopify_admin',
    rollout_id: options.rollout_id ?? null,
    status: 'applied',
    applied_at: options.detected_at ?? nowIso(),
    // No idempotency key: this records an observation, and observing the same
    // price twice at different times is legitimately two facts.
    idempotency_key: null,
  });
}

/** Row -> contract shape for API responses. */
export function toJournalContract(row: JournalEntry, rolloutName?: string | null): JournalEntryContract {
  return {
    contract_version: CONTRACT_VERSION,
    id: row.id,
    variant_gid: row.variant_gid,
    product_gid: row.product_gid,
    title: row.title,
    sku: row.sku,
    rollout_id: row.rollout_id,
    rollout_name: rolloutName ?? null,
    stage_index: row.stage_index,
    source: row.source,
    actor: row.actor,
    reason: row.reason ?? undefined,
    status: row.status,
    before_price_cents: row.before_price_cents,
    after_price_cents: row.after_price_cents,
    before_compare_at_cents: row.before_compare_at_cents,
    after_compare_at_cents: row.after_compare_at_cents,
    currency: row.currency,
    error: row.error,
    applied_at: row.applied_at,
    created_at: row.created_at,
  };
}

const CSV_COLUMNS = [
  'applied_at',
  'title',
  'sku',
  'variant_gid',
  'source',
  'actor',
  'status',
  'before_price',
  'after_price',
  'change_pct',
  'before_compare_at',
  'after_compare_at',
  'currency',
  'rollout_name',
  'stage',
  'reason',
] as const;

/**
 * CSV export (R18). Prices are written as decimal strings because that is what a
 * spreadsheet and an accountant expect; the integer-cents rule is internal.
 */
export function journalToCsv(rows: readonly JournalEntryContract[]): string {
  const lines = [CSV_COLUMNS.join(',')];

  for (const row of rows) {
    const changePct =
      row.before_price_cents > 0
        ? (((row.after_price_cents - row.before_price_cents) / row.before_price_cents) * 100).toFixed(2)
        : '';

    lines.push(
      [
        row.applied_at,
        row.title ?? '',
        row.sku ?? '',
        row.variant_gid,
        row.source,
        row.actor,
        row.status,
        decimal(row.before_price_cents),
        decimal(row.after_price_cents),
        changePct,
        row.before_compare_at_cents === null || row.before_compare_at_cents === undefined
          ? ''
          : decimal(row.before_compare_at_cents),
        row.after_compare_at_cents === null || row.after_compare_at_cents === undefined
          ? ''
          : decimal(row.after_compare_at_cents),
        row.currency ?? '',
        row.rollout_name ?? '',
        row.stage_index === null || row.stage_index === undefined ? '' : String(row.stage_index + 1),
        row.reason ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

function decimal(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function csvCell(value: string): string {
  // Leading =, +, @ or - makes a spreadsheet treat the cell as a formula.
  const guarded = /^[=+@\t\r-]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
