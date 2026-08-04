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
import {
  bracketBand,
  combineBands,
  conditionBandOnDemandEffect,
  type BandEstimate,
} from '../engine/bands';
import { evaluateGuardrails, type DailyObservation } from '../engine/guardrails';
import { decideNext, rollbackInProgressReason, START_ATTENTION_REASON } from '../engine/rollout';
import { readingVerdict } from '../engine/readings';
import type { AdminGraphqlClient } from '../shopify/client';
import { credentialsFromShop } from '../shopify/credentials';
import { AdminGraphqlClient as Client } from '../shopify/client';
import {
  applyStage,
  reconcileRollout,
  rollbackRollout,
  verifyFrozenBaselines,
  verifyRollback,
  verifyStage,
  type ApplyResult,
} from '../pricing/writer';
import type {
  EvaluationDecision,
  ExpectedBandRow,
  Rollout,
  RolloutReading,
  RolloutVariant,
  Shop,
} from '../types';
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

  const usable = selectExpectedBandsForRollout(modelBands, rollout.id, now);

  const expectedVariantCount = new Set(variantGids).size;
  if (usable.length > 0 && usable.length === expectedVariantCount) {
    const demandMultiplier = forecastDemandMultiplier(rollout);
    const combined = combineBands(
      usable.map((band) => {
        const estimate: BandEstimate = {
          expected_units: band.expected_units,
          low: band.low,
          high: band.high,
          interval: band.interval_nominal,
          floored: band.is_floored,
          source: 'bracket',
          n_obs: 0,
        };
        return band.band_kind === 'counterfactual'
          ? estimate
          : conditionBandOnDemandEffect(estimate, demandMultiplier);
      }),
    );
    // Only this rollout's counterfactual bands carry a probability meaningful
    // for this decision. Prior rollouts and baseline rows were excluded above.
    const probabilities = usable
      .filter((band) => band.band_kind === 'counterfactual' && band.rollout_id === rollout.id)
      .map((band) => band.breach_probability)
      .filter((value): value is number => value !== null && value !== undefined);

    return {
      band: combined,
      source: 'model',
      modelVersion: usable.map((band) => band.model_version).sort().at(-1) ?? null,
      // Every selected row passed the freshness gate. Irrelevant stale versions
      // or another rollout's rows must not make this chosen band look stale.
      stale: false,
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

  const band = conditionBandOnDemandEffect(
    bracketBand(
      [...byDay.entries()].map(([bandDay, units]) => ({ day: bandDay, units })),
      day,
    ),
    forecastDemandMultiplier(rollout),
  );

  return {
    band,
    source: 'bracket',
    modelVersion: null,
    stale: modelBands.length > 0,
    breachProbability: null,
  };
}

/**
 * Return exactly one model output per variant/day. Matching counterfactuals win;
 * otherwise the latest baseline wins. Another rollout's band is never eligible.
 */
export function selectExpectedBandsForRollout(
  bands: readonly ExpectedBandRow[],
  rolloutId: string,
  now: Date,
): ExpectedBandRow[] {
  const eligible = bands.filter((band) => {
    const ageDays = (now.getTime() - Date.parse(band.generated_at)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays > MAX_BAND_AGE_DAYS || ageDays < -1) return false;
    if (band.band_kind === 'counterfactual') return band.rollout_id === rolloutId;
    return band.band_kind === 'baseline' && band.rollout_id === null;
  });

  const grouped = new Map<string, ExpectedBandRow[]>();
  for (const band of eligible) {
    const key = `${band.variant_gid}\u0000${band.day}`;
    const group = grouped.get(key) ?? [];
    group.push(band);
    grouped.set(key, group);
  }

  const selected: ExpectedBandRow[] = [];
  for (const group of grouped.values()) {
    const counterfactuals = group.filter((band) => band.band_kind === 'counterfactual');
    const candidates = counterfactuals.length > 0 ? counterfactuals : group;
    candidates.sort((a, b) =>
      b.generated_at.localeCompare(a.generated_at) ||
      b.model_version.localeCompare(a.model_version) ||
      b.id.localeCompare(a.id),
    );
    const latest = candidates[0];
    if (latest) selected.push(latest);
  }

  return selected.sort((a, b) =>
    a.variant_gid.localeCompare(b.variant_gid) || a.day.localeCompare(b.day),
  );
}

const FALLBACK_ELASTICITY = -1.5;

export function forecastDemandMultiplier(rollout: Rollout): number {
  const changePct = rollout.forecast?.fitted?.expected.units_change_pct;
  if (changePct !== null && changePct !== undefined && Number.isFinite(changePct)) {
    return Math.max(0, 1 + changePct / 100);
  }

  // With insufficient history, keep monitoring change-aware using the public
  // beta's conservative consumer-goods elasticity assumption. Weight each SKU's
  // response by its baseline demand rather than averaging price ratios.
  const products = (rollout.forecast?.products ?? []).filter(
    (product) => !product.excluded && product.current_price_cents > 0 && product.target_price_cents > 0,
  );
  if (products.length === 0) return 1;
  const baselineWeight = products.reduce(
    (sum, product) => sum + Math.max(0, product.baseline_units_per_day),
    0,
  );
  const weighted = baselineWeight > 0;
  const denominator = weighted ? baselineWeight : products.length;
  const multiplier = products.reduce((sum, product) => {
    const weight = weighted ? Math.max(0, product.baseline_units_per_day) : 1;
    const priceRatio = product.target_price_cents / product.current_price_cents;
    return sum + weight * Math.pow(priceRatio, FALLBACK_ELASTICITY);
  }, 0) / denominator;
  return Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
}

/** Units-weighted economics for the cohort live at a particular stage. */
export function weightedUnitEconomics(
  variants: readonly RolloutVariant[],
): { price: number; cost: number | null } {
  if (variants.length === 0) return { price: 0, cost: null };
  const baselineWeight = variants.reduce(
    (sum, variant) => sum + Math.max(0, variant.baseline_units_per_day ?? 0),
    0,
  );
  const weighted = baselineWeight > 0;
  const weightOf = (variant: RolloutVariant): number =>
    weighted ? Math.max(0, variant.baseline_units_per_day ?? 0) : 1;
  const totalWeight = weighted ? baselineWeight : variants.length;
  const price = variants.reduce(
    (sum, variant) => sum + variant.target_price_cents * weightOf(variant),
    0,
  ) / totalWeight;
  const costKnown = variants.every(
    (variant) => weightOf(variant) === 0 || variant.cogs_cents_at_creation !== null,
  );
  const cost = costKnown
    ? variants.reduce(
        (sum, variant) => sum + (variant.cogs_cents_at_creation ?? 0) * weightOf(variant),
        0,
      ) / totalWeight
    : null;
  return { price, cost };
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
    const allVariants = await adapter.getRolloutVariants(rollout.id);
    const variants = allVariants.filter(
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
    const liveEconomics = weightedUnitEconomics(variants);
    const liveUnitPrice = liveEconomics.price;
    const liveUnitCost = liveEconomics.cost;

    const expectedRevenue = Math.round(expected.band.expected_units * liveUnitPrice);
    const expectedProfit =
      liveUnitCost === null ? null : Math.round(expected.band.expected_units * (liveUnitPrice - liveUnitCost));

    // --- 3. guardrails ----------------------------------------------------
    const previous = await adapter.listRolloutReadings(rollout.id);
    const history: DailyObservation[] = previous
      .filter((reading) => reading.day < day)
      .map((reading) => {
        const historicalEconomics = weightedUnitEconomics(
          allVariants.filter(
            (variant) => !variant.excluded && variant.cohort_stage <= reading.stage_index,
          ),
        );
        return {
          day: reading.day,
          stage_index: reading.stage_index,
          actual_units: reading.actual_units,
          actual_revenue_cents: reading.actual_revenue_cents,
          actual_profit_cents: reading.actual_profit_cents,
          expected_units: reading.expected_units,
          expected_low: reading.expected_low,
          expected_high: reading.expected_high,
          expected_revenue_cents: Math.round(reading.expected_units * historicalEconomics.price),
          expected_profit_cents:
            historicalEconomics.cost === null
              ? null
              : Math.round(
                  reading.expected_units * (historicalEconomics.price - historicalEconomics.cost),
                ),
          breach_probability: reading.breach_probability,
        };
      });

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
    let effectiveDecision = decision.decision;

    switch (decision.decision) {
      case 'rollback': {
        // Durable intent before Shopify. Besides blocking normal evaluation, this
        // lets products/update recognize the baseline webhook as our own write.
        await adapter.updateRollout(rollout.id, {
          status: 'paused',
          paused_reason: rollbackInProgressReason('automatic'),
          ended_at: null,
          ended_reason: null,
        });
        const undo = await rollbackRollout(context, rollout, { reason: decision.reason });
        const check = await verifyRollback(context, rollout);
        rollbackVerified = undo.fully_applied && check.mismatched.length === 0;

        if (rollbackVerified) {
          await adapter.updateRollout(rollout.id, {
            status: 'rolled_back',
            ended_at: nowIso(now),
            ended_reason: 'guardrail_breach',
            paused_reason: null,
          });
          await adapter.appendRolloutEvent({
            rollout_id: rollout.id,
            shop_id: shop.id,
            type: 'auto_rollback',
            actor: 'priceflag',
            message: `${decision.reason} Every price was verified back at its frozen baseline.`,
            data: { restored: check.verified, verified: true, mismatched: [] },
          });
          await notifier({ kind: 'auto_rollback', shop, rollout, detail: check.verified, reason: decision.reason });
        } else {
          effectiveDecision = 'pause';
          const attention =
            'Automatic rollback paused for attention because one or more Shopify prices could not be verified at baseline.';
          await adapter.updateRollout(rollout.id, {
            status: 'paused',
            paused_reason: attention,
            ended_at: null,
            ended_reason: null,
          });
          await adapter.appendRolloutEvent({
            rollout_id: rollout.id,
            shop_id: shop.id,
            type: 'auto_rollback',
            actor: 'priceflag',
            message: attention,
            data: {
              restored: check.verified,
              verified: false,
              failures: undo.failures,
              external_changes: undo.external_changes,
              mismatched: check.mismatched,
            },
          });
          await notifier({ kind: 'breach', shop, rollout, reason: attention });
        }
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
      decision: effectiveDecision,
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

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Undefined means unrestricted. Any configured empty or malformed value returns
 * an empty set, deliberately failing closed.
 */
export function parseEvaluatorShopAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  const entries = raw.split(',').map((entry) => entry.trim().toLowerCase());
  if (
    entries.length === 0 ||
    entries.some(
      (entry) => entry.length === 0 || (!UUID_PATTERN.test(entry) && !SHOP_DOMAIN_PATTERN.test(entry)),
    )
  ) {
    return new Set();
  }
  return new Set(entries);
}

export function evaluatorAllowsShop(shop: Shop, allowlist: ReadonlySet<string> | null): boolean {
  if (allowlist === null) return true;
  return allowlist.has(shop.id.toLowerCase()) || allowlist.has(shop.shop_domain.toLowerCase());
}

/** One cron tick: every active rollout across every shop. */
export async function evaluateAll(
  adapter: StoreAdapter,
  options: EvaluateOptions = {},
): Promise<EvaluateAllResult> {
  const now = options.now ?? new Date();
  const allowlist = parseEvaluatorShopAllowlist(process.env.PRICEFLAG_SHOP_ALLOWLIST);
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
    // Defense in depth: an uninstall webhook pauses every active rollout, but
    // even a legacy or partially processed row can never regain write authority.
    if (shop.uninstalled_at !== null) continue;
    if (!evaluatorAllowsShop(shop, allowlist)) continue;

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

/** Put stage 0 live under the same lease used by daily evaluation. */
export async function startRollout(
  adapter: StoreAdapter,
  shop: Shop,
  rollout: Rollout,
  options: EvaluateOptions = {},
): Promise<ApplyResult> {
  if (options.skipLock !== true) {
    const outcome = await adapter.withRolloutLock(rollout.id, async () => {
      const latest = await adapter.getRollout(rollout.id);
      if (latest === null || latest.shop_id !== shop.id) throw new Error(`rollout ${rollout.id} no longer exists`);
      return startRollout(adapter, shop, latest, { ...options, skipLock: true });
    });
    if (!outcome.acquired) throw new Error(`rollout ${rollout.id} is busy`);
    return outcome.result as ApplyResult;
  }

  const now = options.now ?? new Date();
  const client = options.client ?? new Client(credentialsFromShop(shop));
  const context = { adapter, client, shop };

  if (rollout.status !== 'draft' && rollout.status !== 'scheduled') {
    throw new Error(`rollout ${rollout.id} cannot start from ${rollout.status}`);
  }

  // Read every frozen baseline while still non-live. Nothing is written if the
  // merchant changed even one selected price after approving the draft.
  const baseline = await verifyFrozenBaselines(context, rollout);
  if (baseline.mismatched.length > 0) {
    await adapter.updateRollout(rollout.id, {
      status: 'paused',
      paused_reason: START_ATTENTION_REASON,
      scheduled_start_at: null,
    });
    await adapter.appendRolloutEvent({
      rollout_id: rollout.id,
      shop_id: shop.id,
      type: 'held',
      actor: 'priceflag',
      message: 'Start paused before any price changed because a frozen baseline no longer matches Shopify.',
      data: { baseline_mismatches: baseline.mismatched },
    });
    return {
      intended: baseline.verified + baseline.mismatched.length,
      applied: 0,
      skipped_noop: 0,
      failed: baseline.mismatched.length,
      failures: baseline.mismatched.map((mismatch) => ({
        variant_gid: mismatch.variant_gid,
        message: 'The live Shopify price no longer matches the frozen baseline.',
      })),
      external_changes: baseline.mismatched
        .filter((mismatch) => mismatch.found !== null)
        .map((mismatch) => ({
          variant_gid: mismatch.variant_gid,
          expected_cents: mismatch.expected,
          found_cents: mismatch.found as Cents,
        })),
      fully_applied: false,
    };
  }

  const started = await adapter.updateRollout(rollout.id, {
    status: 'running',
    current_stage: 0,
    stage_entered_at: nowIso(now),
    started_at: rollout.started_at ?? nowIso(now),
    scheduled_start_at: null,
    paused_reason: null,
  });

  // A second compare-before-write closes the small interval between preflight
  // and marking the rollout running. abortOnExternalChange means no subset is
  // written if that second read finds drift.
  let applied: ApplyResult;
  let verified: Awaited<ReturnType<typeof verifyStage>>;
  try {
    applied = await applyStage(context, started, 0, { abortOnExternalChange: true });
    verified = await verifyStage(context, started, 0);
  } catch (cause) {
    // The rollout became live before the writer call so products/update can
    // recognize our target as an in-flight Priceflag change. If Shopify then
    // times out (including after accepting a write), fail closed into a state
    // the merchant can inspect and roll back; never leave it "running".
    await adapter.updateRollout(rollout.id, {
      status: 'paused',
      paused_reason: START_ATTENTION_REASON,
    });
    await adapter.appendRolloutEvent({
      rollout_id: rollout.id,
      shop_id: shop.id,
      type: 'price_write_failed',
      actor: 'priceflag',
      message: 'The first stage is paused after an unexpected Shopify write or verification error.',
      data: { error: cause instanceof Error ? cause.message : String(cause) },
    }).catch(() => undefined);
    throw cause;
  }
  const failedGids = new Set(applied.failures.map((failure) => failure.variant_gid));
  for (const mismatch of verified.mismatched) {
    if (failedGids.has(mismatch.variant_gid)) continue;
    applied.failed += 1;
    applied.failures.push({
      variant_gid: mismatch.variant_gid,
      message: 'Shopify did not verify the requested first-stage price.',
    });
    failedGids.add(mismatch.variant_gid);
  }
  applied.fully_applied =
    applied.fully_applied && applied.failed === 0 && verified.mismatched.length === 0;

  if (!applied.fully_applied) {
    await adapter.updateRollout(rollout.id, {
      status: 'paused',
      paused_reason: START_ATTENTION_REASON,
    });
    await adapter.appendRolloutEvent({
      rollout_id: rollout.id,
      shop_id: shop.id,
      type: 'price_write_failed',
      actor: 'priceflag',
      message: 'The first stage is paused because not every Shopify price could be verified. No later stage will start.',
      data: {
        applied: applied.applied,
        failed: applied.failed,
        external_changes: applied.external_changes,
        unverified: verified.mismatched,
      },
    });
    await (options.notifier ?? notify)({ kind: 'breach', shop, rollout: started, reason: START_ATTENTION_REASON });
    return applied;
  }

  await adapter.appendRolloutEvent({
    rollout_id: rollout.id,
    shop_id: shop.id,
    type: 'started',
    actor: 'priceflag',
    message: `Started. The new price is live on ${applied.applied + applied.skipped_noop} product${
      applied.applied + applied.skipped_noop === 1 ? '' : 's'
    }.`,
    data: { applied: applied.applied, failed: applied.failed, verified: verified.verified },
  });

  await (options.notifier ?? notify)({ kind: 'started', shop, rollout: started, detail: applied.applied });
  return applied;
}

/** How many whole days a rollout has been in its current stage. */
export function daysInStage(rollout: Rollout, timezone: string, now = new Date()): number {
  if (rollout.stage_entered_at === null) return 0;
  return diffDays(dayInTimeZone(new Date(rollout.stage_entered_at), timezone), dayInTimeZone(now, timezone));
}
