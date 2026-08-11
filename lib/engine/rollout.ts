/**
 * The rollout state machine: stage plans, SKU cohorts, and the advance / hold /
 * rollback decision.
 *
 * The load-bearing constraint of the whole product lives here: a rollout is
 * staged by **fraction of the selected SKUs** and by **time**, never by traffic.
 * Every visitor always sees the same price for a given SKU. If a change here ever
 * seems to require splitting traffic, it is the wrong change.
 */

import { CANARY_STAGE_PLAN, DEFAULT_STAGE_PLAN } from '../contracts';
import type { StageSpec } from '../contracts';
import { dayInTimeZone, diffDays, type DayString } from '../dates';
import type { Cents } from '../money';
import type { EvaluationDecision, Product, Rollout, RolloutStatus, RolloutVariantCreate } from '../types';
import { exclusionReasonFor } from '../types';
import type { GuardrailAssessment } from './guardrails';
import { computeTargetPrice, resolveCompareAt, type PriceChangeSpec } from './forecast';

export class RolloutError extends Error {
  constructor(
    readonly code: 'invalid_stages' | 'no_eligible_variants' | 'illegal_transition',
    message: string,
  ) {
    super(message);
    this.name = 'RolloutError';
  }
}

/**
 * Durable state marker written before a rollback mutation. Webhook handling uses
 * this prefix to distinguish Priceflag restoring a frozen baseline from a
 * merchant edit arriving through products/update.
 */
export const ROLLBACK_IN_PROGRESS_PREFIX = 'priceflag:rollback-in-progress:';

export function rollbackInProgressReason(kind: 'manual' | 'automatic' | 'kill_switch'): string {
  return `${ROLLBACK_IN_PROGRESS_PREFIX}${kind} — Priceflag is restoring frozen baseline prices.`;
}

export const START_ATTENTION_REASON =
  'Priceflag could not verify every first-stage price. The rollout is paused and safe to retry or roll back.';

// ---------------------------------------------------------------------------
// stage plans
// ---------------------------------------------------------------------------

/**
 * Resolve the stage plan. A single-variant selection cannot be split into
 * cohorts, so it becomes a time canary instead: the same one price goes live and
 * the stages are purely holds (R11).
 */
export function normalizeStages(
  requested: readonly { fraction: number; hold_days: number }[] | undefined,
  variantCount: number,
): StageSpec[] {
  if (variantCount < 1) {
    throw new RolloutError('no_eligible_variants', 'a rollout needs at least one repriceable variant');
  }
  if (variantCount === 1) return CANARY_STAGE_PLAN.map((stage) => ({ ...stage }));
  if (!requested || requested.length === 0) return DEFAULT_STAGE_PLAN.map((stage) => ({ ...stage }));

  const stages: StageSpec[] = [];
  let previousFraction = 0;

  requested.forEach((stage, index) => {
    if (!(stage.fraction > 0) || stage.fraction > 1) {
      throw new RolloutError('invalid_stages', `stage ${index} fraction must be in (0, 1], got ${stage.fraction}`);
    }
    if (stage.fraction < previousFraction) {
      throw new RolloutError(
        'invalid_stages',
        `stage fractions are cumulative and must not decrease (stage ${index}: ${stage.fraction} after ${previousFraction})`,
      );
    }
    if (!Number.isInteger(stage.hold_days) || stage.hold_days < 1 || stage.hold_days > 30) {
      throw new RolloutError('invalid_stages', `stage ${index} hold_days must be an integer 1–30`);
    }
    previousFraction = stage.fraction;
    stages.push({ index, fraction: stage.fraction, hold_days: stage.hold_days });
  });

  const last = stages[stages.length - 1] as StageSpec;
  if (last.fraction !== 1) {
    throw new RolloutError(
      'invalid_stages',
      `the final stage must reach the whole selection (fraction 1), got ${last.fraction}`,
    );
  }
  return stages;
}

// ---------------------------------------------------------------------------
// cohorts
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Small, stable across runtimes, and good enough to shuffle SKUs. */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Which stage each variant flips at. `cohort_stage = k` means "carries the new
 * price from stage k onward".
 *
 * Deterministic from the rollout id and the variant gid, so the cohorts are
 * reproducible: the same rollout re-planned after a crash picks the same SKUs,
 * and a merchant asking "why was this one first?" gets a stable answer. Salting
 * with the rollout id keeps a second rollout from repeatedly picking the same
 * unlucky products first.
 */
export function assignCohorts(
  rolloutId: string,
  variantGids: readonly string[],
  stages: readonly StageSpec[],
): Map<string, number> {
  const ordered = [...variantGids].sort((a, b) => {
    const hashA = hash32(`${rolloutId}:${a}`);
    const hashB = hash32(`${rolloutId}:${b}`);
    return hashA === hashB ? a.localeCompare(b) : hashA - hashB;
  });

  const total = ordered.length;
  const cohorts = new Map<string, number>();

  let assigned = 0;
  stages.forEach((stage, stageIndex) => {
    const isLast = stageIndex === stages.length - 1;
    const target = isLast ? total : Math.min(total, Math.max(assigned, Math.round(stage.fraction * total)));
    for (let i = assigned; i < target; i += 1) {
      cohorts.set(ordered[i] as string, stageIndex);
    }
    assigned = target;
  });

  // Defensive: anything unassigned goes live at the last stage rather than never.
  for (const gid of ordered) {
    if (!cohorts.has(gid)) cohorts.set(gid, stages.length - 1);
  }
  return cohorts;
}

export function cohortSizes(cohorts: ReadonlyMap<string, number>, stageCount: number): number[] {
  const sizes = new Array<number>(stageCount).fill(0);
  for (const stage of cohorts.values()) {
    if (stage >= 0 && stage < stageCount) sizes[stage] = (sizes[stage] as number) + 1;
  }
  return sizes;
}

/** Cumulative count of variants carrying the new price at `stageIndex`. */
export function liveCountAtStage(cohorts: ReadonlyMap<string, number>, stageIndex: number): number {
  let count = 0;
  for (const stage of cohorts.values()) if (stage <= stageIndex) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// planning a rollout
// ---------------------------------------------------------------------------

export interface PlanRolloutInput {
  rolloutId: string;
  shopId: string;
  products: readonly Product[];
  change: PriceChangeSpec;
  stages: readonly StageSpec[];
  baselineUnitsPerDay?: ReadonlyMap<string, number>;
}

/**
 * Freeze the selection: target prices, compare-at decisions, cohorts, and — the
 * important part — the baseline prices. Those baselines are captured once, here,
 * and are the only thing a rollback ever reads (R12). Recomputing them later
 * would read back the price we ourselves changed.
 */
export function planRolloutVariants(input: PlanRolloutInput): RolloutVariantCreate[] {
  const eligible = input.products.filter((product) => exclusionReasonFor(product) === null);
  const excluded = input.products.filter((product) => exclusionReasonFor(product) !== null);

  if (eligible.length === 0) {
    throw new RolloutError(
      'no_eligible_variants',
      'every selected product is excluded from repricing (gift card, subscription, or not active)',
    );
  }

  const cohorts = assignCohorts(
    input.rolloutId,
    eligible.map((product) => product.variant_gid),
    input.stages,
  );

  const rows: RolloutVariantCreate[] = eligible.map((product) => {
    const targetPriceCents = computeTargetPrice(product.price_cents, input.change);
    const compareAt = resolveCompareAt(product.price_cents, product.compare_at_cents, targetPriceCents);

    return {
      rollout_id: input.rolloutId,
      shop_id: input.shopId,
      variant_gid: product.variant_gid,
      product_gid: product.product_gid,
      title: product.title,
      sku: product.sku,
      baseline_price_cents: product.price_cents,
      baseline_compare_at_cents: product.compare_at_cents,
      target_price_cents: targetPriceCents,
      target_compare_at_cents: compareAt.target,
      compare_at_action: compareAt.action,
      baseline_units_per_day: input.baselineUnitsPerDay?.get(product.variant_gid) ?? null,
      cogs_cents_at_creation: product.cogs_cents,
      cohort_stage: cohorts.get(product.variant_gid) ?? input.stages.length - 1,
      excluded: false,
      exclusion_reason: null,
    };
  });

  // Excluded variants are recorded too, so the rollout page can say *why* a
  // product the merchant selected is not moving (R22) instead of dropping it.
  for (const product of excluded) {
    rows.push({
      rollout_id: input.rolloutId,
      shop_id: input.shopId,
      variant_gid: product.variant_gid,
      product_gid: product.product_gid,
      title: product.title,
      sku: product.sku,
      baseline_price_cents: product.price_cents,
      baseline_compare_at_cents: product.compare_at_cents,
      target_price_cents: product.price_cents,
      target_compare_at_cents: product.compare_at_cents,
      compare_at_action: 'none',
      baseline_units_per_day: input.baselineUnitsPerDay?.get(product.variant_gid) ?? null,
      cogs_cents_at_creation: product.cogs_cents,
      cohort_stage: input.stages.length - 1,
      excluded: true,
      exclusion_reason: exclusionReasonFor(product),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<RolloutStatus, readonly RolloutStatus[]> = {
  draft: ['scheduled', 'running', 'cancelled'],
  scheduled: ['running', 'cancelled', 'paused'],
  running: ['paused', 'completed', 'rolled_back'],
  paused: ['running', 'rolled_back', 'cancelled', 'completed'],
  completed: [],
  rolled_back: [],
  cancelled: [],
};

export function canTransition(from: RolloutStatus, to: RolloutStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: RolloutStatus, to: RolloutStatus): void {
  if (!canTransition(from, to)) {
    throw new RolloutError('illegal_transition', `a rollout cannot go from ${from} to ${to}`);
  }
}

/** Terminal statuses are terminal: a completed or rolled-back rollout never restarts. */
export function isTerminal(status: RolloutStatus): boolean {
  return status === 'completed' || status === 'rolled_back' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// the daily decision
// ---------------------------------------------------------------------------

export interface StageDecision {
  decision: EvaluationDecision;
  /** One sentence for the event log, written for a merchant (R25). */
  reason: string;
  /** Set only for `advance`. */
  next_stage: number | null;
}

export interface DecideInput {
  rollout: Pick<Rollout, 'status' | 'stages' | 'current_stage' | 'stage_entered_at' | 'guardrails'>;
  assessment: GuardrailAssessment;
  asOf: DayString;
  timezone: string;
}

/**
 * Advance, hold, pause, roll back, or complete.
 *
 * Order matters: safety first. A guardrail that has fired outranks a stage that
 * is ready to advance, because advancing a rollout that is already failing is
 * the single worst thing this system could do.
 */
export function decideNext(input: DecideInput): StageDecision {
  const { rollout, assessment, asOf, timezone } = input;

  if (rollout.status !== 'running') {
    return { decision: 'none', reason: `Nothing to decide: this rollout is ${rollout.status}.`, next_stage: null };
  }

  if (assessment.action === 'rollback_all') {
    return {
      decision: 'rollback',
      reason: assessment.reason ?? 'A guardrail you set was crossed, so every price is being restored.',
      next_stage: null,
    };
  }
  if (assessment.action === 'pause') {
    return {
      decision: 'pause',
      reason: assessment.reason ?? 'A guardrail you set was crossed, so the rollout is paused for your decision.',
      next_stage: null,
    };
  }

  const stages = rollout.stages;
  const stageIndex = rollout.current_stage;
  if (stageIndex < 0) {
    return { decision: 'hold', reason: 'Waiting to put the first cohort live.', next_stage: null };
  }
  const stage = stages[stageIndex];
  if (!stage) {
    return { decision: 'complete', reason: 'Every stage is already live.', next_stage: null };
  }

  const enteredDay = rollout.stage_entered_at
    ? dayInTimeZone(new Date(rollout.stage_entered_at), timezone)
    : asOf;
  const daysHeld = Math.max(0, diffDays(enteredDay, asOf));
  const remaining = stage.hold_days - daysHeld;

  if (remaining > 0) {
    const sentence =
      assessment.breach && assessment.streak > 0
        ? `${assessment.reason} That is ${assessment.streak} day${assessment.streak === 1 ? '' : 's'} so far; your guardrail needs more before acting.`
        : `Holding this stage for ${remaining} more day${remaining === 1 ? '' : 's'} — results are inside the expected range.`;
    return { decision: 'hold', reason: sentence, next_stage: null };
  }

  const isLast = stageIndex >= stages.length - 1;
  if (isLast) {
    return {
      decision: 'complete',
      reason: 'The final stage has run its full hold with results inside the expected range.',
      next_stage: null,
    };
  }

  const next = stages[stageIndex + 1] as StageSpec;
  return {
    decision: 'advance',
    reason: `Results held up, so the new price is going live on ${Math.round(next.fraction * 100)}% of the selected products.`,
    next_stage: stageIndex + 1,
  };
}

/** R14: is a scheduled rollout due? */
export function isDueToStart(
  rollout: Pick<Rollout, 'status' | 'scheduled_start_at'>,
  now: Date = new Date(),
): boolean {
  if (rollout.status !== 'scheduled' || rollout.scheduled_start_at === null) return false;
  return Date.parse(rollout.scheduled_start_at) <= now.getTime();
}

/** Prices to write when entering `stageIndex`: the newly-live cohort only. */
export function pricesForStage(
  variants: readonly { variant_gid: string; cohort_stage: number; target_price_cents: Cents; excluded: boolean }[],
  stageIndex: number,
): { variant_gid: string; price_cents: Cents }[] {
  return variants
    .filter((variant) => !variant.excluded && variant.cohort_stage === stageIndex)
    .map((variant) => ({ variant_gid: variant.variant_gid, price_cents: variant.target_price_cents }));
}

/** Every variant this rollout has put a new price on, for a full restore. */
export function pricesForRollback(
  variants: readonly {
    variant_gid: string;
    baseline_price_cents: Cents;
    baseline_compare_at_cents: Cents | null;
    applied_at: string | null;
    excluded: boolean;
  }[],
): { variant_gid: string; price_cents: Cents; compare_at_cents: Cents | null }[] {
  return variants
    .filter((variant) => !variant.excluded && variant.applied_at !== null)
    .map((variant) => ({
      variant_gid: variant.variant_gid,
      price_cents: variant.baseline_price_cents,
      compare_at_cents: variant.baseline_compare_at_cents,
    }));
}
