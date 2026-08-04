import { sumReadings } from "@/lib/engine/readings";
import { reconstructExpectedEconomics } from "@/lib/evaluator";
import { CONTRACT_VERSION, type ForecastOutcome, type RolloutReport } from "@/lib/contracts";
import { getRolloutBundle, type RolloutBundle } from "@/components/demo/rollouts";

/**
 * The post-rollout report, as `contracts/rollout_report.schema.json`.
 *
 * Lane C writes these for real (C6) and Lane B serves them at
 * `GET /api/rollouts/[id]/report` (B6). Until that route exists, this assembles
 * the same shape from the rollout's own readings — the readings are real, and
 * the aggregation is Lane B's `sumReadings`, so nothing here invents a number.
 *
 * The honest part: `predicted` only exists when the forecast stored on the
 * rollout had a range. Store-specific fits and the broad category-default model
 * both qualify; a product with no usable sales volume does not. When no range was
 * promised, the report says so instead of inventing one after the fact.
 */
export function buildDemoReport(rolloutId: string): RolloutReport | null {
  const bundle = getRolloutBundle(rolloutId);
  if (!bundle) return null;
  return buildReportFromBundle(bundle);
}

/**
 * The assembly itself, pure over a bundle. Real mode reuses this with bundles
 * built from stored rows (`app/lib/store-data.ts`) — the readings are the
 * evaluator's own, so the aggregation is identical in both modes by
 * construction.
 */
export function buildReportFromBundle(bundle: RolloutBundle): RolloutReport | null {
  if (bundle.readings.length === 0) return null;

  const { rollout, readings, variants } = bundle;
  const totals = sumReadings(readings);

  let expectedUnits = 0;
  let expectedRevenue = 0;
  let expectedProfit = 0;
  let expectedProfitKnown = true;
  let counterfactualUnits = 0;
  let counterfactualRevenue = 0;
  let counterfactualProfit = 0;
  let counterfactualProfitKnown = true;

  for (const reading of readings) {
    const liveVariants = variants.filter(
      (variant) => !variant.excluded && variant.cohort_stage <= reading.stage_index,
    );
    const legacy = reconstructExpectedEconomics(rollout, liveVariants, reading.expected_units);
    expectedUnits += reading.expected_units;
    expectedRevenue += reading.expected_revenue_cents ?? legacy.expected_revenue_cents;
    const dayExpectedProfit = reading.expected_profit_cents ?? legacy.expected_profit_cents;
    if (dayExpectedProfit === null) expectedProfitKnown = false;
    else expectedProfit += dayExpectedProfit;
    counterfactualUnits += reading.counterfactual_units ?? legacy.counterfactual_units;
    counterfactualRevenue +=
      reading.counterfactual_revenue_cents ?? legacy.counterfactual_revenue_cents;
    const dayCounterfactualProfit =
      reading.counterfactual_profit_cents ?? legacy.counterfactual_profit_cents;
    if (dayCounterfactualProfit === null) counterfactualProfitKnown = false;
    else counterfactualProfit += dayCounterfactualProfit;
  }

  const realizedUnits = totals.units;

  const unitsChangePct =
    counterfactualUnits > 0
      ? ((realizedUnits - counterfactualUnits) / counterfactualUnits) * 100
      : 0;

  const realized: ForecastOutcome = {
    units_change_pct: round(unitsChangePct, 2),
    revenue_delta_cents: totals.revenue_cents - Math.round(counterfactualRevenue),
    profit_delta_cents:
      totals.profit_cents === null || !counterfactualProfitKnown
        ? null
        : totals.profit_cents - Math.round(counterfactualProfit),
  };

  const fitted = rollout.forecast?.fitted ?? null;
  const predictedCenter: ForecastOutcome = {
    units_change_pct:
      counterfactualUnits > 0
        ? round(((expectedUnits - counterfactualUnits) / counterfactualUnits) * 100, 2)
        : 0,
    revenue_delta_cents: Math.round(expectedRevenue - counterfactualRevenue),
    profit_delta_cents:
      expectedProfitKnown && counterfactualProfitKnown
        ? Math.round(expectedProfit - counterfactualProfit)
        : null,
  };
  const fullBaselineUnitsPerDay = (rollout.forecast?.products ?? [])
    .filter((product) => !product.excluded)
    .reduce((sum, product) => sum + Math.max(0, product.baseline_units_per_day), 0);
  const exposureScale =
    fullBaselineUnitsPerDay > 0 && rollout.horizon_days > 0
      ? counterfactualUnits / (fullBaselineUnitsPerDay * rollout.horizon_days)
      : readings.length / Math.max(1, rollout.horizon_days);
  const predicted = fitted
    ? {
        expected: predictedCenter,
        low: shiftOutcome(fitted.low, fitted.expected, predictedCenter, exposureScale),
        high: shiftOutcome(fitted.high, fitted.expected, predictedCenter, exposureScale),
      }
    : null;

  const inRange = predicted === null
    ? false
    : realized.profit_delta_cents !== null && predicted.low.profit_delta_cents !== null
      ? isInsideBand(
          realized.profit_delta_cents,
          predicted.low.profit_delta_cents,
          predicted.high.profit_delta_cents,
        )
      : isInsideBand(
          realized.revenue_delta_cents,
          predicted.low.revenue_delta_cents,
          predicted.high.revenue_delta_cents,
        );

  const firstDay = readings[0]!.day;
  const lastDay = readings[readings.length - 1]!.day;

  return {
    contract_version: CONTRACT_VERSION,
    rollout_id: rollout.id,
    generated_at: `${lastDay}T06:30:00.000Z`,
    model_version: rollout.forecast?.model_version ?? "none",
    model_run_id: null,
    window: { start_day: firstDay, end_day: lastDay, days: readings.length },
    // Contract requires `predicted`; when nothing was predicted the band is the
    // realized outcome repeated, and `predicted_range_existed` below is what the
    // UI actually branches on.
    predicted: predicted ?? { expected: realized, low: realized, high: realized },
    realized,
    in_range: inRange,
    elasticity_update: null,
    narrative: narrativeFor(bundle, realized, predicted !== null, inRange),
    // Aggregate readings cannot honestly recover per-SKU actuals. Lane C's
    // stored report fills these when that source is available.
    per_variant: [],
  };
}

/** Whether a range was ever promised — what the report page branches on. */
export function hadPredictedRange(rolloutId: string): boolean {
  return getRolloutBundle(rolloutId)?.rollout.forecast?.fitted != null;
}

/** The same question, for a bundle already in hand (real mode). */
export function bundleHadPredictedRange(bundle: RolloutBundle): boolean {
  return bundle.rollout.forecast?.fitted != null;
}

/**
 * Two or three merchant-facing sentences, no statistics vocabulary (R25). Lane C
 * writes this field for real; this is the stand-in, and it is written to be
 * replaced verbatim.
 */
function narrativeFor(
  bundle: RolloutBundle,
  realized: ForecastOutcome,
  hadRange: boolean,
  inRange: boolean,
): string {
  const { rollout } = bundle;
  const ended =
    rollout.status === "rolled_back"
      ? "It was undone before it finished, so this covers only the days it was live."
      : "";

  const direction =
    realized.units_change_pct < -1
      ? `You sold about ${Math.abs(Math.round(realized.units_change_pct))}% fewer units than you would have at the old price.`
      : realized.units_change_pct > 1
        ? `You sold about ${Math.round(realized.units_change_pct)}% more units than you would have at the old price.`
        : "Unit sales were much the same as they would have been at the old price.";

  const money =
    realized.profit_delta_cents === null
      ? "We cannot say what that did to profit, because some of these products have no cost saved."
      : realized.profit_delta_cents >= 0
        ? "Profit went up over the period, because the extra margin more than covered the units you gave up."
        : "Profit went down over the period: the units you gave up cost more than the extra margin earned.";

  const scored = hadRange
    ? inRange
      ? "That landed inside the range we predicted."
      : "That landed outside the range we predicted, which is worth knowing — we would rather tell you when we were wrong."
    : "We did not predict a range for this one, so there is nothing to score ourselves against.";

  return [direction, money, scored, ended].filter(Boolean).join(" ");
}

/** An unknown is never "inside the range" — it is unknown. */
function isInsideBand(value: number | null, low: number | null, high: number | null): boolean {
  if (value === null || low === null || high === null) return false;
  return value >= Math.min(low, high) && value <= Math.max(low, high);
}

function shiftOutcome(
  edge: ForecastOutcome,
  originalCenter: ForecastOutcome,
  windowCenter: ForecastOutcome,
  moneyScale: number,
): ForecastOutcome {
  const shiftMoney = (
    edgeValue: number | null,
    originalValue: number | null,
    windowValue: number | null,
  ): number | null =>
    edgeValue === null || originalValue === null || windowValue === null
      ? null
      : Math.round(windowValue + (edgeValue - originalValue) * moneyScale);
  return {
    units_change_pct: round(
      windowCenter.units_change_pct +
        (edge.units_change_pct - originalCenter.units_change_pct),
      2,
    ),
    revenue_delta_cents: shiftMoney(
      edge.revenue_delta_cents,
      originalCenter.revenue_delta_cents,
      windowCenter.revenue_delta_cents,
    ) as number,
    profit_delta_cents: shiftMoney(
      edge.profit_delta_cents,
      originalCenter.profit_delta_cents,
      windowCenter.profit_delta_cents,
    ),
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
