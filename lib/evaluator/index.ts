/**
 * The evaluator. This is what makes the product real.
 *
 * Once a day, per shop-local day, for every running rollout: work out what
 * actually sold, compare it to what was expected, decide, and act.
 *
 * Four properties matter more than the arithmetic:
 *
 *   - **Idempotent per (rollout, day).** `rollout_readings` is uniquely keyed
 *     that way, so a second run on the same day updates rather than
 *     double-advancing. The cron fires every 15 minutes; almost every firing must
 *     be a no-op.
 *   - **Leased.** Two concurrent evaluators disagreeing about a stage advance is
 *     the failure mode; the loser skips rather than waits.
 *   - **Reconcile before deciding.** A stage that is only partly applied must be
 *     repaired before its results are judged — otherwise we would measure a price
 *     change that only half happened.
 *   - **Safety outranks progress.** A fired guardrail beats a ready-to-advance
 *     stage, always.
 */

import { MAX_BAND_AGE_DAYS } from '../contracts';
import type { StoreAdapter } from '../adapters/types';
import { addDays, dayInTimeZone, diffDays, nowIso, yesterday, type DayString } from '../dates';
import type { Cents } from '../money';
import { bracketBand, combineBands, type BandEstimate } from '../engine/bands';
import { evaluateGuardrails, type DailyObservation } from '../engine/guardrails';
import { decideNext } from '../engine/rollout';
import { readingVerdict } from '../engine/readings';
import type { AdminGraphqlClient } from '../shopify/client';
import { credentialsFromShop } from '../shopify/credentials';
import { AdminGraphqlClient as Client } from '../shopify/client';
import {
  applyStage,
  reconcileRollout,
  rollbackRollout,
  verifyRollback,
  type ApplyResult,
} from '../pricing/writer';
import type { EvaluationDecision, Rollout, RolloutReading, Shop } from '../types';
import { notify, type Notifier } from '../notify';

export interface EvaluateOptions {
  /** Defaults to yesterday in shop time — the last complete day. */
  asOfDay?: DayString;
  client?: AdminGraphqlClient;
  notifier?: Notifier;
  now?: Date;
  /** Skip the lease. Only for the scripted simulator, never for the cron. */
  skipLock?: boolean;
}

export interface EvaluateResult {
  rollout_id: string;
  day: DayString;
  skipped: 'locked' | 'not_running' | 'already_evaluated' | 'too_early' | null;
  decision: EvaluationDecision;
  reason: string;
  reading: RolloutReading | null;
  apply: ApplyResult | null;
  rollback_verified: boolean | null;
}

/** Actual units/revenue/profit for the variants a rollout has live. */
async function actualsForDay(
  adapter: StoreAdapter,
  shop: Shop,
  variantGids: readonly string[],
  cogsByVariant: ReadonlyMap<string, Cents | null>,
  day: DayString,
): Promise<{ units: number; orders: number; revenue: Cents; profit: Cents | null }> {
  const rows = await adapter.getOrderDays(shop.id, { variant_gids: [...variantGids], from_day: day, to_day: day });

  let units = 0;
  let orders = 0;
  let revenue = 0;
  let profit = 0;
  let profitKnown = true;

  for (const row of rows) {
    units += row.units;
    orders += row.orders;
    revenue += row.net_revenue_cents;

    const cogs = cogsByVariant.get(row.variant_gid) ?? null;
    if (cogs === null) profitKnown = false;
    else profit += row.net_revenue_cents - cogs * Math.max(0, row.units - row.refund_units);
  }

  return { units, orders, revenue, profit: profitKnown ? profit : null };
}

/**
 * The expected band, preferring Lane C's fitted bands and degrading honestly.
 *
 * Staleness is a safety property (R32): a band older than `MAX_BAND_AGE_DAYS` is
 * not silently served as fresh — it is marked stale, and the bracket fallback is
 * used instead.
 */
async function expectedBandForDay(
  adapter: StoreAdapter,
  shop: Shop,
  rollout: Rollout,
  variantGids: readonly string[],
  day: DayString,
  now: Date,
): Promise<{ band: BandEstimate; source: 'model' | 'bracket'; modelVersion: string | null; stale: boolean; breachProbability: number | null }> {
  const modelBands = await adapter.getExpectedBands(shop.id, {
    variantGids,
    fromDay: day,
    toDay: day,
    rolloutId: undefined,
  });

  const usable = modelBands.filter((band) => {
    const ageDays = (now.getTime() - Date.parse(band.generated_at)) / 86_400_000;
    return Number.isFinite(ageDays) && ageDays <= MAX_BAND_AGE_DAYS;
  });

  if (usable.length > 0) {
    const combined = combineBands(
      usable.map((band) => ({
        expected_units: band.expected_units,
        low: band.low,
        high: band.high,
        interval: band.interval_nominal,
        floored: band.is_floored,
        source: 'bracket' as const,
        n_obs: 0,
      })),
    );
    // A counterfactual band from C5 carries a calibrated breach probability; take
    // the most pessimistic across the affected variants.
    const probabilities = usable
      .map((band) => band.breach_probability)
      .filter((value): value is number => value !== null && value !== undefined);

    return {
      band: combined,
      source: 'model',
      modelVersion: usable[0]?.model_version ?? null,
      stale: modelBands.length > usable.length,
      breachProbability: probabilities.length > 0 ? Math.max(...probabilities) : null,
    };
  }

  // Fallback: the transparent bracket band, built from history strictly BEFORE
  // the rollout started. Including days that already carry the new price would
  // let the band drift toward the very effect it exists to detect.
  const startDay = rollout.started_at === null ? day : dayInTimeZone(new Date(rollout.started_at), shop.timezone);
  const history = await adapter.getOrderDays(shop.id, {
    variant_gids: [...variantGids],
    from_day: addDays(startDay, -60),
    to_day: addDays(startDay, -1),
  });

  const byDay = new Map<DayString, number>();
  for (const row of history) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.units);

  const band = bracketBand(
    [...byDay.entries()].map(([bandDay, units]) => ({ day: bandDay, units })),
    day,
  );

  return {
    band,
    source: 'bracket',
    modelVersion: null,
    stale: modelBands.length > 0,
    breachProbability: null,
  };
}

/** Evaluate one rollout for one day. */
export async function evaluateRollout(
  adapter: StoreAdapter,
  shop: Shop,
  rollout: Rollout,
  options: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const now = options.now ?? new Date();
  const day = options.asOfDay ?? yesterday(shop.timezone, now);
  const notifier = options.notifier ?? notify;

  const base: EvaluateResult = {
    rollout_id: rollout.id,
    day,
    skipped: null,
    decision: 'none',
    reason: '',
    reading: null,
    apply: null,
    rollback_verified: null,
  };

  if (rollout.status !== 'running') {
    return { ...base, skipped: 'not_running', reason: `Rollout is ${rollout.status}.` };
  }

  const run = async (): Promise<EvaluateResult> => {
    const client = options.client ?? new Client(credentialsFromShop(shop));
    const context = { adapter, client, shop };

    // --- 1. repair before judging ----------------------------------------
    const apply = await reconcileRollout(context, rollout);

    if (apply.external_changes.length > 0) {
      await adapter.updateRollout(rollout.id, {
        status: 'paused',
        paused_reason: 'A price was changed outside Priceflag.',
      });
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'paused_external_change',
        actor: 'shopify_admin',
        message:
          'Paused: a price in this rollout was changed outside Priceflag, so the results would no longer mean what we predicted.',
        data: { external_changes: apply.external_changes },
      });
      await notifier({ kind: 'paused_external', shop, rollout, detail: apply.external_changes.length });
      return { ...base, decision: 'pause', reason: 'External price change.', apply };
    }

    // --- 2. what happened -------------------------------------------------
    const variants = (await adapter.getRolloutVariants(rollout.id)).filter(
      (variant) => !variant.excluded && variant.cohort_stage <= rollout.current_stage,
    );
    if (variants.length === 0) {
      return { ...base, skipped: 'too_early', reason: 'No prices are live yet.' };
    }

    const variantGids = variants.map((variant) => variant.variant_gid);
    const cogs = new Map(variants.map((variant) => [variant.variant_gid, variant.cogs_cents_at_creation]));

    const actual = await actualsForDay(adapter, shop, variantGids, cogs, day);
    const expected = await expectedBandForDay(adapter, shop, rollout, variantGids, day, now);

    // Expected revenue and profit follow from expected units at the prices that
    // are actually live, so a units-based band drives all three metrics.
    const liveUnitPrice =
      variants.reduce((sum, variant) => sum + variant.target_price_cents, 0) / Math.max(1, variants.length);
    const liveUnitCost = variants.every((variant) => variant.cogs_cents_at_creation !== null)
      ? variants.reduce((sum, variant) => sum + (variant.cogs_cents_at_creation as number), 0) / variants.length
      : null;

    const expectedRevenue = Math.round(expected.band.expected_units * liveUnitPrice);
    const expectedProfit =
      liveUnitCost === null ? null : Math.round(expected.band.expected_units * (liveUnitPrice - liveUnitCost));

    // --- 3. guardrails ----------------------------------------------------
    const previous = await adapter.listRolloutReadings(rollout.id);
    const history: DailyObservation[] = previous
      .filter((reading) => reading.day < day)
      .map((reading) => ({
        day: reading.day,
        stage_index: reading.stage_index,
        actual_units: reading.actual_units,
        actual_revenue_cents: reading.actual_revenue_cents,
        actual_profit_cents: reading.actual_profit_cents,
        expected_units: reading.expected_units,
        expected_low: reading.expected_low,
        expected_high: reading.expected_high,
        expected_revenue_cents: Math.round(reading.expected_units * liveUnitPrice),
        expected_profit_cents:
          liveUnitCost === null ? null : Math.round(reading.expected_units * (liveUnitPrice - liveUnitCost)),
        breach_probability: reading.breach_probability,
      }));

    const todayObservation: DailyObservation = {
      day,
      stage_index: rollout.current_stage,
      actual_units: actual.units,
      actual_revenue_cents: actual.revenue,
      actual_profit_cents: actual.profit,
      expected_units: expected.band.expected_units,
      expected_low: expected.band.low,
      expected_high: expected.band.high,
      expected_revenue_cents: expectedRevenue,
      expected_profit_cents: expectedProfit,
      breach_probability: expected.breachProbability,
    };
    history.push(todayObservation);

    const assessment = evaluateGuardrails(rollout.guardrails, history, shop.currency);
    const decision = decideNext({ rollout, assessment, asOf: day, timezone: shop.timezone });

    // --- 4. record BEFORE acting -----------------------------------------
    // The reading is the idempotency record. Writing it first means a crash
    // mid-action cannot cause the same day to be evaluated twice.
    const reading = await adapter.upsertRolloutReading({
      rollout_id: rollout.id,
      shop_id: shop.id,
      day,
      stage_index: rollout.current_stage,
      actual_units: actual.units,
      actual_orders: actual.orders,
      actual_revenue_cents: actual.revenue,
      actual_profit_cents: actual.profit,
      expected_units: expected.band.expected_units,
      expected_low: expected.band.low,
      expected_high: expected.band.high,
      expected_source: expected.source,
      interval_nominal: expected.band.interval,
      model_version: expected.modelVersion,
      band_stale: expected.stale,
      band_floored: expected.band.floored,
      breach_probability: expected.breachProbability,
      breach: assessment.breach,
      breach_rule_id: assessment.rule_id,
      breach_reason: assessment.reason,
      breach_streak: assessment.streak,
      decision: decision.decision,
      evaluated_at: nowIso(now),
    });

    for (const skip of assessment.skipped) {
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'note',
        actor: 'system',
        message: skip.why,
        data: { rule_id: skip.rule_id },
      });
    }

    // --- 5. act -----------------------------------------------------------
    let rollbackVerified: boolean | null = null;

    switch (decision.decision) {
      case 'rollback': {
        const undo = await rollbackRollout(context, rollout, { reason: decision.reason });
        const check = await verifyRollback(context, rollout);
        rollbackVerified = check.mismatched.length === 0;

        await adapter.updateRollout(rollout.id, {
          status: 'rolled_back',
          ended_at: nowIso(now),
          ended_reason: 'guardrail_breach',
        });
        await adapter.appendRolloutEvent({
          rollout_id: rollout.id,
          shop_id: shop.id,
          type: 'auto_rollback',
          actor: 'priceflag',
          message: `${decision.reason} Every price has been put back to what it was.`,
          data: { restored: undo.applied + undo.skipped_noop, verified: rollbackVerified, mismatched: check.mismatched },
        });
        await notifier({ kind: 'auto_rollback', shop, rollout, detail: undo.applied, reason: decision.reason });
        break;
      }

      case 'pause': {
        await adapter.updateRollout(rollout.id, { status: 'paused', paused_reason: decision.reason });
        await adapter.appendRolloutEvent({
          rollout_id: rollout.id,
          shop_id: shop.id,
          type: 'breach_detected',
          actor: 'priceflag',
          message: decision.reason,
          data: {},
        });
        await notifier({ kind: 'breach', shop, rollout, reason: decision.reason });
        break;
      }

      case 'advance': {
        // The gate: never advance while the current stage is not fully applied.
        if (!apply.fully_applied) {
          await adapter.appendRolloutEvent({
            rollout_id: rollout.id,
            shop_id: shop.id,
            type: 'held',
            actor: 'priceflag',
            message: 'Holding: some prices in the current stage have not gone through yet. Retrying automatically.',
            data: { failures: apply.failures },
          });
          return { ...base, decision: 'hold', reason: 'Current stage not fully applied.', reading, apply };
        }

        const nextStage = decision.next_stage as number;
        const advanced = await adapter.updateRollout(rollout.id, {
          current_stage: nextStage,
          stage_entered_at: nowIso(now),
        });
        const applied = await applyStage(context, advanced, nextStage);

        await adapter.appendRolloutEvent({
          rollout_id: rollout.id,
          shop_id: shop.id,
          type: 'stage_advanced',
          actor: 'priceflag',
          message: decision.reason,
          data: { stage: nextStage, applied: applied.applied, failed: applied.failed },
        });
        await notifier({ kind: 'stage_advanced', shop, rollout: advanced, detail: nextStage + 1 });
        return { ...base, decision: 'advance', reason: decision.reason, reading, apply: applied };
      }

      case 'complete': {
        await adapter.updateRollout(rollout.id, {
          status: 'completed',
          ended_at: nowIso(now),
          ended_reason: 'completed',
        });
        await adapter.appendRolloutEvent({
          rollout_id: rollout.id,
          shop_id: shop.id,
          type: 'completed',
          actor: 'priceflag',
          message: 'This rollout finished. The new prices are live on everything you selected.',
          data: {},
        });
        await notifier({ kind: 'completed', shop, rollout });
        break;
      }

      default: {
        await adapter.appendRolloutEvent({
          rollout_id: rollout.id,
          shop_id: shop.id,
          type: 'evaluated',
          actor: 'priceflag',
          message: decision.reason,
          data: {
            units: actual.units,
            expected: expected.band.expected_units,
            verdict: readingVerdict(actual.units, expected.band.low, expected.band.high),
          },
        });
      }
    }

    await adapter.updateRollout(rollout.id, { last_evaluated_at: nowIso(now), last_evaluated_day: day });

    return {
      ...base,
      decision: decision.decision,
      reason: decision.reason,
      reading,
      apply,
      rollback_verified: rollbackVerified,
    };
  };

  if (options.skipLock === true) return run();

  const outcome = await adapter.withRolloutLock(rollout.id, run);
  if (!outcome.acquired) {
    return { ...base, skipped: 'locked', reason: 'Another evaluation is already running for this rollout.' };
  }
  return outcome.result as EvaluateResult;
}

/**
 * How many missed days a single tick will work through. A rollout that has been
 * unevaluated for longer than this has a bigger problem than catch-up, and
 * grinding through months of history inside one function invocation would just
 * time out.
 */
export const MAX_CATCHUP_DAYS = 14;

/**
 * Evaluate every shop-local day that has closed but never been evaluated.
 *
 * The scheduler can miss windows — a failed workflow run, a deploy, an outage,
 * GitHub Actions being late. Without catch-up those days are simply never judged:
 * a breach that happened on a skipped day would never fire, because the evaluator
 * only ever looked at yesterday. Guardrails that silently skip a day are worse
 * than no guardrails, because the merchant believes they are covered.
 *
 * Days are processed oldest first, so `breach_streak` accumulates in the right
 * order, and the loop stops the moment the rollout stops running.
 */
export async function evaluateRolloutWithCatchUp(
  adapter: StoreAdapter,
  shop: Shop,
  rollout: Rollout,
  options: EvaluateOptions = {},
): Promise<EvaluateResult[]> {
  const now = options.now ?? new Date();
  const target = options.asOfDay ?? yesterday(shop.timezone, now);

  // Start the day after whatever was last evaluated; failing that, the day the
  // rollout started. Never before it went live — there is nothing to judge.
  const startedDay =
    rollout.started_at === null ? target : dayInTimeZone(new Date(rollout.started_at), shop.timezone);
  const firstUnevaluated =
    rollout.last_evaluated_day === null ? startedDay : addDays(rollout.last_evaluated_day, 1);

  let from = firstUnevaluated > startedDay ? firstUnevaluated : startedDay;
  if (from > target) from = target;

  // Cap the backlog, oldest first.
  const span = diffDays(from, target);
  if (span > MAX_CATCHUP_DAYS) from = addDays(target, -MAX_CATCHUP_DAYS);

  const results: EvaluateResult[] = [];
  let current: Rollout | null = rollout;

  for (let day = from; day <= target && current !== null; day = addDays(day, 1)) {
    const outcome = await evaluateRollout(adapter, shop, current, { ...options, asOfDay: day, now });
    results.push(outcome);

    // A lease we could not take, or a rollout that has ended: stop, do not churn
    // through the remaining days.
    if (outcome.skipped === 'locked' || outcome.skipped === 'not_running') break;
    if (outcome.decision === 'rollback' || outcome.decision === 'complete' || outcome.decision === 'pause') break;

    current = await adapter.getRollout(rollout.id);
    if (current === null || current.status !== 'running') break;
  }

  return results;
}

export interface EvaluateAllResult {
  evaluated: number;
  skipped_locked: number;
  advanced: number;
  held: number;
  rolled_back: number;
  completed: number;
  paused: number;
  started: number;
  /** Extra days processed because the scheduler had missed them. */
  caught_up: number;
  errors: { rollout_id: string; message: string }[];
}

/** One cron tick: every active rollout across every shop. */
export async function evaluateAll(
  adapter: StoreAdapter,
  options: EvaluateOptions = {},
): Promise<EvaluateAllResult> {
  const now = options.now ?? new Date();
  const result: EvaluateAllResult = {
    evaluated: 0,
    skipped_locked: 0,
    advanced: 0,
    held: 0,
    rolled_back: 0,
    completed: 0,
    paused: 0,
    started: 0,
    caught_up: 0,
    errors: [],
  };

  for (const rollout of await adapter.listActiveRollouts()) {
    const shop = await adapter.getShop(rollout.shop_id);
    if (shop === null) continue;

    // A shop with the kill switch engaged is not evaluated at all: nothing should
    // be advancing while a merchant has pulled the cord.
    if (shop.kill_switch_engaged_at !== null) continue;

    try {
      // R14: a scheduled rollout whose time has come starts here.
      if (rollout.status === 'scheduled' && rollout.scheduled_start_at !== null) {
        if (Date.parse(rollout.scheduled_start_at) <= now.getTime()) {
          await startRollout(adapter, shop, rollout, options);
          result.started += 1;
        }
        continue;
      }

      // Catch-up, not just "yesterday": a day the scheduler missed must still be
      // judged, or a breach that happened on it would never fire.
      const outcomes = await evaluateRolloutWithCatchUp(adapter, shop, rollout, options);

      for (const outcome of outcomes) {
        if (outcome.skipped === 'locked') {
          result.skipped_locked += 1;
          continue;
        }
        if (outcome.skipped !== null) continue;

        result.evaluated += 1;
        if (outcome.decision === 'advance') result.advanced += 1;
        else if (outcome.decision === 'hold') result.held += 1;
        else if (outcome.decision === 'rollback') result.rolled_back += 1;
        else if (outcome.decision === 'complete') result.completed += 1;
        else if (outcome.decision === 'pause') result.paused += 1;
      }
      if (outcomes.length > 1) result.caught_up += outcomes.length - 1;
    } catch (cause) {
      result.errors.push({
        rollout_id: rollout.id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return result;
}

/** Put stage 0 live. */
export async function startRollout(
  adapter: StoreAdapter,
  shop: Shop,
  rollout: Rollout,
  options: EvaluateOptions = {},
): Promise<ApplyResult> {
  const now = options.now ?? new Date();
  const client = options.client ?? new Client(credentialsFromShop(shop));

  const started = await adapter.updateRollout(rollout.id, {
    status: 'running',
    current_stage: 0,
    stage_entered_at: nowIso(now),
    started_at: rollout.started_at ?? nowIso(now),
  });

  const applied = await applyStage({ adapter, client, shop }, started, 0);

  await adapter.appendRolloutEvent({
    rollout_id: rollout.id,
    shop_id: shop.id,
    type: 'started',
    actor: 'priceflag',
    message: `Started. The new price is live on ${applied.applied + applied.skipped_noop} product${
      applied.applied + applied.skipped_noop === 1 ? '' : 's'
    }.`,
    data: { applied: applied.applied, failed: applied.failed },
  });

  await (options.notifier ?? notify)({ kind: 'started', shop, rollout: started, detail: applied.applied });
  return applied;
}

/** How many whole days a rollout has been in its current stage. */
export function daysInStage(rollout: Rollout, timezone: string, now = new Date()): number {
  if (rollout.stage_entered_at === null) return 0;
  return diffDays(dayInTimeZone(new Date(rollout.stage_entered_at), timezone), dayInTimeZone(now, timezone));
}
