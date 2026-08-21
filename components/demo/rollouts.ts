import {
  bracketBand,
  combineBands,
  conditionBandOnDemandEffect,
  type DailyUnits,
} from "@/lib/engine/bands";
import { buildForecast } from "@/lib/engine/forecast";
import type { ForecastResult } from "@/lib/contracts";
import { evaluateGuardrails, type DailyObservation } from "@/lib/engine/guardrails";
import { healthSentence, rolloutHealth, type RolloutHealth } from "@/lib/engine/readings";
import { decideNext, normalizeStages, planRolloutVariants } from "@/lib/engine/rollout";
import { defaultGuardrails, type Guardrails, type StageSpec } from "@/lib/contracts";
import { exclusionReasonFor, type JournalEntry, type OrderDay, type Product, type Rollout, type RolloutEndReason, type RolloutEvent, type RolloutReading, type RolloutStatus, type RolloutVariant } from "@/lib/types";
import type { DayString } from "@/lib/dates";
import type { Cents } from "@/lib/money";
import {
  DEMO_END_DAY,
  DEMO_TODAY,
  dayOffset,
  getDemoStore,
  unitsInBaselineWindow,
} from "@/components/demo/store";

/**
 * Demo rollouts, readings, events and journal.
 *
 * Lane B's golden store (`lib/demo/generator.ts`) is 180 days of catalog and
 * order history — it contains no rollouts, and `GET /api/rollouts` lands in B4.
 * So this file assembles rollouts on top of the real store, and it does it by
 * calling Lane B's engine rather than reimplementing it:
 *
 * - stages from `normalizeStages`
 * - frozen baselines, target prices, compare-at decisions and cohorts from
 *   `planRolloutVariants` (the same function the price writer will use)
 * - expected bands from `bracketBand` + `combineBands` over **pre-change days
 *   only**, which is the incumbent the evaluator uses
 * - breach flags from `ruleConditionHolds`
 * - verdicts, health and their sentences from `lib/engine/readings.ts` at render
 *   time, so the UI can never show a verdict the machine did not compute
 *
 * The one thing invented here is **the demand response to the price change**:
 * `demand_factor` scales observed units from the day a rollout starts. A demo
 * store has to be able to show a breach and an auto-rollback, or that UI is
 * unreachable and untested. It is deterministic, it is the simulated behaviour
 * of shoppers rather than of the product, and it never reaches a forecast —
 * forecasts are built from history alone (CLAUDE.md).
 */

type RolloutSpec = {
  id: string;
  name: string;
  skus: string[];
  change: { type: "percent"; percent: number } | { type: "absolute"; absolute_cents: Cents };
  /**
   * The status before the simulation runs. For a started rollout the simulation
   * decides the outcome — a rollback happens because a guardrail fired, not
   * because a fixture said so.
   */
  status: RolloutStatus;
  startDay: DayString | null;
  /** Last day with a reading. Defaults to the demo store's last full day. */
  endDay?: DayString;
  scheduledStartAt?: string;
  endedReason?: RolloutEndReason;
  /** Exogenous: someone edited a price in Shopify on this day. */
  externalPauseOn?: DayString;
  pausedReason?: string;
  guardrails?: Guardrails;
  /** Simulated shopper response. 1 = no change in demand. */
  demandFactor?: number;
  /** Per-day overrides, for the days the demo needs to be interesting. */
  demandOverrides?: Record<string, number>;
  createdAt: string;
};

function guardrailsWith(thresholdPct: number, days: number, autoRollback = false): Guardrails {
  const base = defaultGuardrails();
  const rule = base.rules[0];
  if (!rule) return base;
  return {
    ...base,
    auto_rollback: autoRollback,
    rules: [
      {
        ...rule,
        threshold_pct: thresholdPct,
        consecutive_days: days,
        sentence: `If daily units fall more than ${thresholdPct}% below what we expect for ${days} ${
          days === 1 ? "day" : "days"
        } in a row, ${
          autoRollback ? "put every price back automatically" : "pause and tell me"
        }.`,
      },
    ],
  };
}

const SPECS: RolloutSpec[] = [
  {
    id: "ro_2041",
    name: "Cost increase pass — everyday basics",
    skus: [
      "EVERYDAYTEE-1",
      "EVERYDAYTEELARGE-2",
      "WOOLSOCKS-6",
      "CERAMICMUG-7",
      "COFFEEBEANS-10",
      "FIELDNOTEBOOK-12",
    ],
    change: { type: "percent", percent: 6 },
    status: "running",
    startDay: "2026-07-21" as DayString,
    // Unmodified demand, deliberately: actuals are the store's own history, so
    // this rollout stays healthy even when Lane B changes the generator. Hand-fit
    // factors broke once already when B3 landed.
    demandFactor: 1,
    // No per-day overrides: the store's own trading already produces a day below
    // the range that recovers, which is the exact distinction the band exists to
    // draw. Manufacturing one on top of it is how this fixture broke last time.
    // 45%: the bracket band on a 6-SKU selection is genuinely noisy (weekday
    // seasonality against a flat 28-day mean), and a tighter limit would trip on
    // ordinary trading. This is the forgiving first-rollout setting the PRD asks
    // for, and it keeps the demo from whipsawing on a generator change.
    guardrails: guardrailsWith(45, 2),
    createdAt: "2026-07-20T15:41:00.000Z",
  },
  {
    id: "ro_2039",
    name: "Margin fix — leather and linen",
    // The belt has no cost saved, so profit is unknown for this selection — the
    // guardrail's profit metric would be skipped rather than silently passed.
    skus: ["LEATHERBELT-5", "LINENTHROW-8"],
    change: { type: "percent", percent: 8 },
    status: "paused",
    startDay: "2026-07-26" as DayString,
    externalPauseOn: "2026-07-27" as DayString,
    pausedReason:
      "The price of Bridle Leather Belt was changed in Shopify on 27 July, outside Priceflag.",
    guardrails: guardrailsWith(25, 2),
    demandFactor: 0.94,
    createdAt: "2026-07-25T09:12:00.000Z",
  },
  {
    id: "ro_2042",
    name: "Kettle price correction",
    skus: ["POUROVERKETTLE-9"],
    change: { type: "absolute", absolute_cents: 800 },
    status: "scheduled",
    startDay: null,
    scheduledStartAt: "2026-08-03T10:00:00.000Z",
    createdAt: "2026-07-28T16:30:00.000Z",
  },
  {
    id: "ro_2043",
    name: "Autumn cost pass",
    // Includes the travel mug at 18 units in 28 days — low enough that a single
    // day cannot mean anything, which the guardrail floor handles.
    skus: ["CANVASTOTE-4", "TRAVELMUG-11", "MERINOCREW-3"],
    change: { type: "percent", percent: 4 },
    status: "draft",
    startDay: null,
    createdAt: "2026-07-29T08:15:00.000Z",
  },
  {
    id: "ro_2036",
    name: "Bean price test",
    skus: ["COFFEEBEANS-10"],
    change: { type: "percent", percent: 14 },
    status: "rolled_back",
    startDay: "2026-07-06" as DayString,
    endDay: "2026-07-08" as DayString,
    endedReason: "guardrail_breach",
    // Historical proof that rollback is reversible. Current beta rollouts stay
    // alert-only; this completed fixture predates that posture intentionally.
    guardrails: guardrailsWith(10, 2, true),
    demandFactor: 0.1,
    createdAt: "2026-07-05T11:02:00.000Z",
  },
  {
    id: "ro_2030",
    name: "Winter clearance",
    skus: ["MERINOCREW-3", "LINENTHROW-8", "CANVASTOTE-4"],
    change: { type: "percent", percent: -12 },
    status: "completed",
    startDay: "2026-06-08" as DayString,
    endDay: "2026-06-24" as DayString,
    endedReason: "completed",
    // A clearance is a deliberate margin sacrifice to move stock, so the limit is
    // set loose on purpose — the merchant expects the units, not the margin.
    guardrails: guardrailsWith(90, 2),
    demandFactor: 1.16,
    createdAt: "2026-06-07T10:20:00.000Z",
  },
];

export type RolloutBundle = {
  rollout: Rollout;
  variants: RolloutVariant[];
  readings: RolloutReading[];
  events: RolloutEvent[];
  health: RolloutHealth;
  health_sentence: string;
  live: { stage_index: number; variants_live: number; variants_total: number; fraction: number };
  can: {
    confirm: boolean;
    rollback: boolean;
    pause: boolean;
    cancel: boolean;
    resume: boolean;
  };
};

let bundles: RolloutBundle[] | null = null;
let journal: JournalEntry[] | null = null;

function build(): { bundles: RolloutBundle[]; journal: JournalEntry[] } {
  if (bundles && journal) return { bundles, journal };

  const store = getDemoStore();
  const bySku = new Map(store.products.map((product) => [product.sku ?? "", product]));
  const unitsByVariantDay = indexOrderDays(store.orderDays);
  const historyByVariant = historyIndex(store.orderDays);
  const baselineUnits = unitsInBaselineWindow();
  const baselinePerDay = new Map<string, number>();
  for (const [gid, units] of baselineUnits) baselinePerDay.set(gid, units / 28);

  const built: RolloutBundle[] = [];
  const entries: JournalEntry[] = [];

  for (const spec of SPECS) {
    const products = spec.skus
      .map((sku) => bySku.get(sku))
      .filter((product): product is Product => product !== undefined);
    const eligible = products.filter((product) => exclusionReasonFor(product) === null);
    if (eligible.length === 0) continue;

    const guardrails = spec.guardrails ?? defaultGuardrails();
    const stages = normalizeStages(undefined, eligible.length);
    const variantCreates = planRolloutVariants({
      rolloutId: spec.id,
      shopId: store.shop.id,
      products,
      change:
        spec.change.type === "percent"
          ? { type: "percent", percent: spec.change.percent }
          : { type: "absolute", absolute_cents: spec.change.absolute_cents },
      stages,
      baselineUnitsPerDay: baselinePerDay,
    });
    const frozenForecast = forecastAtProposal(products, spec, store);
    const multiplierByVariant = new Map(
      (frozenForecast?.products ?? []).map((product) => [
        product.variant_gid,
        product.demand_multiplier ?? 1,
      ]),
    );
    const realizationByVariant = new Map(
      (frozenForecast?.products ?? []).map((product) => [
        product.variant_gid,
        product.revenue_realization_rate,
      ]),
    );

    const events: RolloutEvent[] = [];
    const readings: RolloutReading[] = [];
    const observations: DailyObservation[] = [];
    /** The day each stage was actually entered, as the simulation decided it. */
    const stageEnteredOn: DayString[] = [];

    let stageIndex = spec.startDay === null ? -1 : 0;
    let status: RolloutStatus = spec.status;
    let endedReason: RolloutEndReason | null = spec.endedReason ?? null;
    let endedDay: DayString | null = null;
    let lastDecision: RolloutReading["decision"] = "none";

    events.push(
      event(
        spec,
        "created",
        `You set this up: ${changeWords(spec)} on ${countWord(eligible.length, "product")}, in ${
          stages.length === 1 ? "one step" : `${stages.length} steps`
        }.`,
        spec.createdAt,
      ),
    );
    if (spec.status === "scheduled" && spec.scheduledStartAt) {
      events.push(
        event(
          spec,
          "scheduled",
          "Set to start on Monday 3 August at 6:00 am in your store's time.",
          spec.scheduledStartAt,
        ),
      );
    }

    if (spec.startDay !== null) {
      stageEnteredOn[0] = spec.startDay;
      status = "running";
      events.push(
        event(
          spec,
          "started",
          `New prices went live on ${cohortCountAt(variantCreates, 0)} of ${eligible.length} products.`,
          `${spec.startDay}T10:00:00.000Z`,
        ),
      );

      const finalDay = minDay(spec.endDay ?? DEMO_END_DAY, DEMO_END_DAY);

      // Day by day, exactly as the evaluator will run it: build the day's
      // observation, ask `evaluateGuardrails` whether a rule fired, then ask
      // `decideNext` what to do. Stages advance only when the engine says so —
      // this file never decides to advance, hold, or roll back on its own.
      for (let day = spec.startDay; day <= finalDay; day = dayOffset(day, 1)) {
        if (spec.externalPauseOn && day > spec.externalPauseOn) break;

        const liveVariants = variantCreates.filter(
          (variant) => !variant.excluded && variant.cohort_stage <= stageIndex,
        );
        if (liveVariants.length === 0) continue;

        const factor = spec.demandOverrides?.[day] ?? spec.demandFactor ?? 1;

        let actualUnits = 0;
        let actualRevenue = 0;
        let actualProfit = 0;
        let profitKnown = true;
        const counterfactualBands = [];
        const conditionedBands = [];
        let counterfactualRevenue = 0;
        let counterfactualProfit = 0;
        let expectedRevenue = 0;
        let expectedProfit = 0;
        let expectedRevenueLow = 0;
        let expectedRevenueHigh = 0;
        let expectedProfitLow = 0;
        let expectedProfitHigh = 0;

        for (const variant of liveVariants) {
          const realization = realizationByVariant.get(variant.variant_gid) ?? 1;
          const baselineRevenuePerUnit = variant.baseline_price_cents * realization;
          const targetRevenuePerUnit = variant.target_price_cents * realization;
          const rawUnits = unitsByVariantDay.get(`${variant.variant_gid}|${day}`) ?? 0;
          const units = Math.round(rawUnits * factor);
          actualUnits += units;
          actualRevenue += units * targetRevenuePerUnit;
          if (variant.cogs_cents_at_creation === null) profitKnown = false;
          else actualProfit += units * (targetRevenuePerUnit - variant.cogs_cents_at_creation);

          const counterfactualBand = bracketBand(
            preChangeHistory(historyByVariant, variant.variant_gid, spec.startDay),
            day,
          );
          const conditionedBand = conditionBandOnDemandEffect(
            counterfactualBand,
            multiplierByVariant.get(variant.variant_gid) ?? 1,
          );
          counterfactualBands.push(counterfactualBand);
          conditionedBands.push(conditionedBand);
          counterfactualRevenue +=
            counterfactualBand.expected_units * baselineRevenuePerUnit;
          expectedRevenue += conditionedBand.expected_units * targetRevenuePerUnit;
          expectedRevenueLow += conditionedBand.low * targetRevenuePerUnit;
          expectedRevenueHigh += conditionedBand.high * targetRevenuePerUnit;
          if (variant.cogs_cents_at_creation !== null) {
            counterfactualProfit +=
              counterfactualBand.expected_units *
              (baselineRevenuePerUnit - variant.cogs_cents_at_creation);
            expectedProfit +=
              conditionedBand.expected_units *
              (targetRevenuePerUnit - variant.cogs_cents_at_creation);
            const margin = targetRevenuePerUnit - variant.cogs_cents_at_creation;
            expectedProfitLow += Math.min(conditionedBand.low * margin, conditionedBand.high * margin);
            expectedProfitHigh += Math.max(conditionedBand.low * margin, conditionedBand.high * margin);
          }
        }

        const counterfactualBand = combineBands(counterfactualBands);
        const band = combineBands(conditionedBands);
        observations.push({
          day,
          stage_index: stageIndex,
          actual_units: actualUnits,
          actual_revenue_cents: Math.round(actualRevenue),
          actual_profit_cents: profitKnown ? Math.round(actualProfit) : null,
          expected_units: band.expected_units,
          expected_low: band.low,
          expected_high: band.high,
          expected_revenue_cents: Math.round(expectedRevenue),
          expected_profit_cents: profitKnown ? Math.round(expectedProfit) : null,
          expected_revenue_low_cents: Math.round(expectedRevenueLow),
          expected_revenue_high_cents: Math.round(expectedRevenueHigh),
          expected_profit_low_cents: profitKnown ? Math.round(expectedProfitLow) : null,
          expected_profit_high_cents: profitKnown ? Math.round(expectedProfitHigh) : null,
        });

        const assessment = evaluateGuardrails(guardrails, observations, store.shop.currency);
        const stageEntered = stageEnteredOn[stageIndex] ?? spec.startDay;
        const decision = decideNext({
          rollout: {
            status: "running",
            stages,
            current_stage: stageIndex,
            stage_entered_at: `${stageEntered}T10:00:00.000Z`,
            guardrails,
          },
          assessment,
          asOf: day,
          timezone: store.shop.timezone,
        });
        lastDecision = decision.decision;

        readings.push({
          id: `${spec.id}-r${readings.length + 1}`,
          rollout_id: spec.id,
          shop_id: store.shop.id,
          day,
          stage_index: stageIndex,
          actual_units: actualUnits,
          actual_orders: Math.max(1, Math.round(actualUnits * 0.86)),
          actual_revenue_cents: Math.round(actualRevenue),
          actual_profit_cents: profitKnown ? Math.round(actualProfit) : null,
          expected_units: band.expected_units,
          expected_low: band.low,
          expected_high: band.high,
          counterfactual_units: counterfactualBand.expected_units,
          counterfactual_revenue_cents: Math.round(counterfactualRevenue),
          counterfactual_profit_cents: profitKnown ? Math.round(counterfactualProfit) : null,
          expected_revenue_cents: Math.round(expectedRevenue),
          expected_profit_cents: profitKnown ? Math.round(expectedProfit) : null,
          expected_revenue_low_cents: Math.round(expectedRevenueLow),
          expected_revenue_high_cents: Math.round(expectedRevenueHigh),
          expected_profit_low_cents: profitKnown ? Math.round(expectedProfitLow) : null,
          expected_profit_high_cents: profitKnown ? Math.round(expectedProfitHigh) : null,
          expected_source: "bracket",
          interval_nominal: band.interval,
          model_version: null,
          band_stale: false,
          band_floored: band.floored || assessment.floored,
          breach_probability: null,
          breach: assessment.breach,
          breach_rule_id: assessment.rule_id,
          breach_reason: assessment.reason,
          breach_streak: assessment.streak,
          decision: decision.decision,
          evaluated_at: `${dayOffset(day, 1)}T06:04:00.000Z`,
        });

        if (assessment.breach && decision.decision !== "rollback" && decision.decision !== "pause") {
          events.push(
            event(
              spec,
              "breach_detected",
              `${assessment.reason ?? `Orders on ${day} came in below the range we expected.`} Nothing has changed yet — your guardrail needs ${countWord(
                guardrails.rules[0]?.consecutive_days ?? 2,
                "day",
              )} in a row before it acts.`,
              `${dayOffset(day, 1)}T06:04:00.000Z`,
            ),
          );
        }

        if (decision.decision === "advance" && decision.next_stage !== null) {
          stageIndex = decision.next_stage;
          stageEnteredOn[stageIndex] = dayOffset(day, 1);
          events.push(
            event(
              spec,
              "stage_advanced",
              `Moved on to ${cohortCountAt(variantCreates, stageIndex)} of ${eligible.length} products. ${decision.reason}`,
              `${dayOffset(day, 1)}T06:05:00.000Z`,
            ),
          );
          continue;
        }

        if (decision.decision === "rollback") {
          status = "rolled_back";
          endedReason = "guardrail_breach";
          endedDay = day;
          events.push(
            event(
              spec,
              "auto_rollback",
              `${decision.reason} Every price went back to what it was before this change started.`,
              `${dayOffset(day, 1)}T06:07:00.000Z`,
            ),
          );
          break;
        }

        if (decision.decision === "pause") {
          status = "paused";
          endedReason = null;
          events.push(event(spec, "held", decision.reason, `${dayOffset(day, 1)}T06:05:00.000Z`));
          break;
        }

        if (decision.decision === "complete") {
          status = "completed";
          endedReason = "completed";
          endedDay = day;
          events.push(
            event(
              spec,
              "completed",
              `Finished. All ${eligible.length} products are on the new price and monitoring has stopped.`,
              `${dayOffset(day, 1)}T06:00:00.000Z`,
            ),
          );
          break;
        }
      }

      // An external edit is exogenous: it is not something a guardrail decides,
      // so it is applied after the simulation rather than inside it.
      if (spec.externalPauseOn && spec.pausedReason) {
        status = "paused";
        endedReason = null;
        events.push(
          event(
            spec,
            "paused_external_change",
            `Paused: ${spec.pausedReason} We stopped rather than blame this change for a difference we did not cause.`,
            `${spec.externalPauseOn}T14:22:00.000Z`,
          ),
        );
      }
    }

    const lastDay = endedDay ?? spec.endDay ?? DEMO_END_DAY;
    const currentStage = stageIndex;

    const variants: RolloutVariant[] = variantCreates.map((create, index) => {
      const appliedDay = create.excluded ? null : (stageEnteredOn[create.cohort_stage] ?? null);
      const wasApplied =
        appliedDay !== null && create.cohort_stage <= currentStage && status !== "draft" && status !== "scheduled";
      const reverted = wasApplied && status === "rolled_back";
      return {
        ...create,
        id: `${spec.id}-v${index + 1}`,
        applied_price_cents: wasApplied && !reverted ? create.target_price_cents : null,
        applied_at: wasApplied && appliedDay ? `${appliedDay}T10:00:00.000Z` : null,
        reverted_at: reverted ? `${dayOffset(lastDay, 1)}T06:07:00.000Z` : null,
        created_at: spec.createdAt,
        updated_at: spec.createdAt,
      };
    });

    const rollout: Rollout = {
      id: spec.id,
      shop_id: store.shop.id,
      name: spec.name,
      status,
      change_type: spec.change.type,
      change_pct: spec.change.type === "percent" ? spec.change.percent : null,
      change_absolute_cents: spec.change.type === "absolute" ? spec.change.absolute_cents : null,
      rounding: "none",
      horizon_days: 90,
      stages,
      current_stage: currentStage,
      stage_entered_at:
        currentStage >= 0 && stageEnteredOn[currentStage]
          ? `${stageEnteredOn[currentStage]}T10:00:00.000Z`
          : null,
      guardrails,
      // The forecast as of proposal time. Stored on the rollout on purpose: the
      // post-rollout report has to compare against what was actually promised,
      // not against what the engine would say today (R20/R30).
      forecast: frozenForecast,
      scheduled_start_at: spec.scheduledStartAt ?? null,
      started_at: spec.startDay ? `${spec.startDay}T10:00:00.000Z` : null,
      ended_at:
        status === "completed" || status === "rolled_back"
          ? `${dayOffset(lastDay, 1)}T06:07:00.000Z`
          : null,
      ended_reason: endedReason,
      paused_reason: spec.pausedReason ?? null,
      notify_emails: [],
      eval_lock_token: null,
      eval_locked_until: null,
      last_evaluated_at: readings.at(-1)?.evaluated_at ?? null,
      last_evaluated_day: readings.at(-1)?.day ?? null,
      created_by: "demo",
      created_at: spec.createdAt,
      updated_at: spec.createdAt,
    };

    const health = rolloutHealth(rollout.status, readings);
    // Applied and not since put back — `applied_at` stays set after a rollback
    // because the write really happened; `reverted_at` is what ends it.
    const variantsLive = variants.filter(
      (variant) => variant.applied_at !== null && variant.reverted_at === null,
    ).length;

    built.push({
      rollout,
      variants,
      readings,
      events,
      health,
      health_sentence: healthSentence(health, lastDecision, readings.at(-1)?.breach_streak ?? 0),
      live: {
        stage_index: currentStage,
        variants_live: variantsLive,
        variants_total: variants.filter((variant) => !variant.excluded).length,
        fraction: currentStage >= 0 ? (stages[currentStage]?.fraction ?? 0) : 0,
      },
      can: {
        confirm: rollout.status === "draft",
        rollback: ["running", "paused", "completed"].includes(rollout.status),
        pause: rollout.status === "running" || rollout.status === "scheduled",
        cancel: rollout.status === "draft" || rollout.status === "scheduled",
        resume: false,
      },
    });

    entries.push(...journalFor(rollout, variants, stageEnteredOn, lastDay, store.shop.currency));
  }

  // Real history from the generator, so the journal is complete rather than
  // starting the day the demo rollouts do.
  entries.push(...seedJournal(store.products, store.shop.currency));

  entries.sort((a, b) => b.applied_at.localeCompare(a.applied_at));

  bundles = built;
  journal = entries;
  return { bundles, journal };
}

/* ------------------------------------------------------------------ reads */

export function getRolloutBundles(): RolloutBundle[] {
  return build().bundles;
}

export function getRollouts(): Rollout[] {
  return build().bundles.map((bundle) => bundle.rollout);
}

export function getRolloutBundle(id: string): RolloutBundle | undefined {
  return build().bundles.find((bundle) => bundle.rollout.id === id);
}

export function getJournal(): JournalEntry[] {
  return build().journal;
}

/** Variants currently holding a price Priceflag wrote and has not put back. */
export function getLiveVariantGids(): string[] {
  return build()
    .bundles.filter((bundle) => bundle.rollout.status !== "cancelled")
    .flatMap((bundle) =>
      bundle.variants
        .filter((variant) => variant.applied_at !== null && variant.reverted_at === null)
        .map((variant) => variant.variant_gid),
    );
}

export function getJournalForRollout(rolloutId: string): JournalEntry[] {
  return build().journal.filter((entry) => entry.rollout_id === rolloutId);
}

/**
 * The `GET /api/live` shape from contracts/api.md, assembled locally until B4
 * lands the route. Field names match the contract so the swap is a fetch.
 */
export type LiveResponse = {
  anything_live: boolean;
  kill_switch_engaged: boolean;
  skus_holding_priceflag_price: number;
  rollouts: {
    id: string;
    name: string;
    status: RolloutStatus;
    stage_index: number;
    stage_count: number;
    fraction_live: number;
    variants_live: number;
    variants_total: number;
    health: RolloutHealth;
    health_sentence: string;
    next_decision_day: DayString | null;
    can: { rollback: boolean; cancel: boolean; resume: boolean };
  }[];
  paused_for_external_change: string[];
  products_missing_cost: number;
};

export function getLive(): LiveResponse {
  const store = getDemoStore();
  const live = build().bundles.filter(
    (bundle) => bundle.rollout.status !== "cancelled" && bundle.live.variants_live > 0,
  );
  const liveVariantGids = new Set(
    live.flatMap((bundle) =>
      bundle.variants
        .filter((variant) => variant.applied_at !== null && variant.reverted_at === null)
        .map((variant) => variant.variant_gid),
    ),
  );

  return {
    anything_live: live.some((bundle) => bundle.live.variants_live > 0),
    kill_switch_engaged: false,
    skus_holding_priceflag_price: liveVariantGids.size,
    rollouts: live.map((bundle) => ({
      id: bundle.rollout.id,
      name: bundle.rollout.name,
      status: bundle.rollout.status,
      stage_index: bundle.live.stage_index,
      stage_count: bundle.rollout.stages.length,
      fraction_live: bundle.live.fraction,
      variants_live: bundle.live.variants_live,
      variants_total: bundle.live.variants_total,
      health: bundle.health,
      health_sentence: bundle.health_sentence,
      next_decision_day: bundle.readings.at(-1) ? dayOffset(bundle.readings.at(-1)!.day, 1) : null,
      can: bundle.can,
    })),
    paused_for_external_change: build()
      .bundles.filter((bundle) => bundle.rollout.status === "paused")
      .map((bundle) => bundle.rollout.id),
    products_missing_cost: store.products.filter(
      (product) => exclusionReasonFor(product) === null && product.cogs_cents === null,
    ).length,
  };
}

/* -------------------------------------------------------------- internals */

/**
 * What the forecast said when this rollout was created — built from history
 * **before** it started, because that is all the merchant could have seen.
 */
function forecastAtProposal(
  products: readonly Product[],
  spec: RolloutSpec,
  store: ReturnType<typeof getDemoStore>,
): ForecastResult | null {
  if (spec.startDay === null) return null;
  try {
    return buildForecast({
      shop: { currency: store.shop.currency, timezone: store.shop.timezone },
      products: [...products],
      orderDays: store.orderDays.filter((row) => row.day < spec.startDay!),
      change:
        spec.change.type === "percent"
          ? { type: "percent", percent: spec.change.percent }
          : { type: "absolute", absolute_cents: spec.change.absolute_cents },
      now: new Date(`${spec.startDay}T10:00:00.000Z`),
    });
  } catch {
    return null;
  }
}

function indexOrderDays(rows: readonly OrderDay[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of rows) index.set(`${row.variant_gid}|${row.day}`, row.units);
  return index;
}

function historyIndex(rows: readonly OrderDay[]): Map<string, DailyUnits[]> {
  const index = new Map<string, DailyUnits[]>();
  for (const row of rows) {
    const bucket = index.get(row.variant_gid);
    const entry = { day: row.day, units: row.units };
    if (bucket) bucket.push(entry);
    else index.set(row.variant_gid, [entry]);
  }
  return index;
}

/** Only days before the change went live — otherwise the band chases the effect. */
function preChangeHistory(
  index: Map<string, DailyUnits[]>,
  variantGid: string,
  startDay: DayString,
): DailyUnits[] {
  return (index.get(variantGid) ?? []).filter((row) => row.day < startDay);
}

function cohortCountAt(
  variants: readonly { cohort_stage: number; excluded: boolean }[],
  stageIndex: number,
): number {
  return variants.filter((variant) => !variant.excluded && variant.cohort_stage <= stageIndex).length;
}

function minDay(a: DayString, b: DayString): DayString {
  return a <= b ? a : b;
}

function changeWords(spec: RolloutSpec): string {
  if (spec.change.type === "percent") {
    const magnitude = Math.abs(spec.change.percent);
    return `${magnitude}% ${spec.change.percent >= 0 ? "higher" : "lower"}`;
  }
  const dollars = (Math.abs(spec.change.absolute_cents) / 100).toFixed(2);
  return `$${dollars} ${spec.change.absolute_cents >= 0 ? "more" : "less"}`;
}

function countWord(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function event(
  spec: RolloutSpec,
  type: RolloutEvent["type"],
  message: string,
  at: string,
): RolloutEvent {
  return {
    id: `${spec.id}-e-${type}-${at}`,
    rollout_id: spec.id,
    shop_id: "demo-shop",
    type,
    message,
    actor: type === "created" || type === "scheduled" ? "merchant" : "priceflag",
    data: {},
    at,
  };
}

function journalFor(
  rollout: Rollout,
  variants: readonly RolloutVariant[],
  stageEnteredOn: readonly DayString[],
  lastDay: DayString,
  currency: string,
): JournalEntry[] {
  const entries: JournalEntry[] = [];

  for (const variant of variants) {
    // A reverted variant has `applied_at` cleared but still had a price written,
    // so the journal must carry both writes.
    if (variant.applied_at === null && variant.reverted_at === null) continue;
    const day = stageEnteredOn[variant.cohort_stage];
    if (!day) continue;

    entries.push({
      id: `${variant.id}-apply`,
      shop_id: rollout.shop_id,
      variant_gid: variant.variant_gid,
      product_gid: variant.product_gid,
      title: variant.title,
      sku: variant.sku,
      rollout_id: rollout.id,
      stage_index: variant.cohort_stage,
      source: "rollout",
      actor: "priceflag",
      reason: `Step ${variant.cohort_stage + 1} of “${rollout.name}”`,
      status: "applied",
      before_price_cents: variant.baseline_price_cents,
      after_price_cents: variant.target_price_cents,
      before_compare_at_cents: variant.baseline_compare_at_cents,
      after_compare_at_cents: variant.target_compare_at_cents,
      currency,
      idempotency_key: `${rollout.id}:${variant.variant_gid}:${variant.cohort_stage}`,
      error: null,
      shopify_user_errors: null,
      applied_at: `${day}T10:00:00.000Z`,
      created_at: `${day}T10:00:00.000Z`,
    });

    if (variant.reverted_at !== null) {
      entries.push({
        id: `${variant.id}-revert`,
        shop_id: rollout.shop_id,
        variant_gid: variant.variant_gid,
        product_gid: variant.product_gid,
        title: variant.title,
        sku: variant.sku,
        rollout_id: rollout.id,
        stage_index: variant.cohort_stage,
        source: "rollback",
        actor: "priceflag",
        reason: "Undone automatically — unit sales below the range you set, two days running",
        status: "applied",
        before_price_cents: variant.target_price_cents,
        after_price_cents: variant.baseline_price_cents,
        before_compare_at_cents: variant.target_compare_at_cents,
        after_compare_at_cents: variant.baseline_compare_at_cents,
        currency,
        idempotency_key: `${rollout.id}:${variant.variant_gid}:rollback`,
        error: null,
        shopify_user_errors: null,
        applied_at: variant.reverted_at,
        created_at: variant.reverted_at,
      });
    }
  }

  // The external edit that paused ro_2039 — journalled because Shopify keeps no
  // price audit trail and this is the entry a merchant comes looking for (R18).
  if (rollout.id === "ro_2039") {
    const belt = variants.find((variant) => variant.sku === "LEATHERBELT-5");
    if (belt) {
      entries.push({
        id: `${belt.id}-external`,
        shop_id: rollout.shop_id,
        variant_gid: belt.variant_gid,
        product_gid: belt.product_gid,
        title: belt.title,
        sku: belt.sku,
        rollout_id: rollout.id,
        stage_index: null,
        source: "external",
        actor: "shopify_admin",
        reason: "Changed in the Shopify admin, outside Priceflag",
        status: "applied",
        before_price_cents: belt.target_price_cents,
        after_price_cents: 8400,
        before_compare_at_cents: null,
        after_compare_at_cents: null,
        currency,
        idempotency_key: null,
        error: null,
        shopify_user_errors: null,
        applied_at: "2026-07-27T14:22:00.000Z",
        created_at: "2026-07-27T14:22:00.000Z",
      });
    }
  }

  return entries;
}

/** The generator's own applied price changes, as journal history. */
function seedJournal(products: readonly Product[], currency: string): JournalEntry[] {
  const byGid = new Map(products.map((product) => [product.variant_gid, product]));
  const store = getDemoStore();
  const seen = new Set<string>();
  const entries: JournalEntry[] = [];

  // Reconstruct from list-price moves in the order-day history: the day a
  // variant's list price changes is a price change that really happened.
  const sorted = [...store.orderDays].sort(
    (a, b) => a.variant_gid.localeCompare(b.variant_gid) || a.day.localeCompare(b.day),
  );

  let previousGid = "";
  let previousPrice: Cents | null = null;

  for (const row of sorted) {
    if (row.variant_gid !== previousGid) {
      previousGid = row.variant_gid;
      previousPrice = row.list_price_cents;
      continue;
    }
    const price = row.list_price_cents;
    if (price === null || previousPrice === null || price === previousPrice) {
      if (price !== null) previousPrice = price;
      continue;
    }

    const product = byGid.get(row.variant_gid);
    const key = `${row.variant_gid}|${row.day}`;
    if (product && !seen.has(key)) {
      seen.add(key);
      entries.push({
        id: `seed-${key}`,
        shop_id: store.shop.id,
        variant_gid: row.variant_gid,
        product_gid: product.product_gid,
        title: `${product.title}${product.variant_title ? ` — ${product.variant_title}` : ""}`,
        sku: product.sku,
        rollout_id: null,
        stage_index: null,
        source: "seed",
        actor: "merchant",
        reason: "Price history from before Priceflag",
        status: "applied",
        before_price_cents: previousPrice,
        after_price_cents: price,
        before_compare_at_cents: null,
        after_compare_at_cents: null,
        currency,
        idempotency_key: null,
        error: null,
        shopify_user_errors: null,
        applied_at: `${row.day}T09:00:00.000Z`,
        created_at: `${row.day}T09:00:00.000Z`,
      });
    }
    previousPrice = price;
  }

  return entries;
}
