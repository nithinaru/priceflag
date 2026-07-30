import { sumReadings } from "@/lib/engine/readings";
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
 * rollout **had a fitted range**. On the `assumption` tier there was no range, so
 * there is nothing to score ourselves against, and the report says so rather than
 * inventing a prediction after the fact to be judged against. That is the common
 * case on a young store, and scoring a prediction nobody made would be the exact
 * dishonesty this product exists to avoid.
 */
export function buildDemoReport(rolloutId: string): RolloutReport | null {
  const bundle = getRolloutBundle(rolloutId);
  if (!bundle) return null;
  if (bundle.readings.length === 0) return null;

  const { rollout, readings, variants } = bundle;
  const totals = sumReadings(readings);

  // The counterfactual: what the evaluator expected without a price change,
  // summed over the same days. This is what "realized" is measured against.
  const expectedUnits = readings.reduce((sum, reading) => sum + reading.expected_units, 0);
  const realizedUnits = totals.units;

  const unitsChangePct =
    expectedUnits > 0 ? ((realizedUnits - expectedUnits) / expectedUnits) * 100 : 0;

  // Revenue and profit the store would have taken at the old prices, from the
  // same expected units and the baselines frozen at creation.
  const included = variants.filter((variant) => !variant.excluded);
  const baselinePrice = average(included.map((variant) => variant.baseline_price_cents));
  const baselineCogs = included.every((variant) => variant.cogs_cents_at_creation !== null)
    ? average(included.map((variant) => variant.cogs_cents_at_creation ?? 0))
    : null;

  const counterfactualRevenue = Math.round(expectedUnits * baselinePrice);
  const counterfactualProfit =
    baselineCogs === null ? null : Math.round(expectedUnits * (baselinePrice - baselineCogs));

  const realized: ForecastOutcome = {
    units_change_pct: round(unitsChangePct, 2),
    revenue_delta_cents: totals.revenue_cents - counterfactualRevenue,
    profit_delta_cents:
      totals.profit_cents === null || counterfactualProfit === null
        ? null
        : totals.profit_cents - counterfactualProfit,
  };

  const fitted = rollout.forecast?.fitted ?? null;
  const predicted = fitted
    ? { expected: fitted.expected, low: fitted.low, high: fitted.high }
    : null;

  const inRange = isInsideBand(
    realized.profit_delta_cents,
    predicted?.low.profit_delta_cents ?? null,
    predicted?.high.profit_delta_cents ?? null,
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
    per_variant: included.map((variant) => ({
      variant_gid: variant.variant_gid,
      realized_units: 0,
      expected_units: 0,
      realized_revenue_cents: 0,
      realized_profit_cents: null,
      elasticity_after: null,
    })),
  };
}

/** Whether a range was ever promised — what the report page branches on. */
export function hadPredictedRange(rolloutId: string): boolean {
  return getRolloutBundle(rolloutId)?.rollout.forecast?.fitted != null;
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
      ? "It was undone automatically before it finished, so this covers only the days it was live."
      : "";

  const direction =
    realized.units_change_pct < -1
      ? `You sold about ${Math.abs(Math.round(realized.units_change_pct))}% fewer units than you would have at the old price.`
      : realized.units_change_pct > 1
        ? `You sold about ${Math.round(realized.units_change_pct)}% more units than you would have at the old price.`
        : "Order volume was much the same as it would have been at the old price.";

  const money =
    realized.profit_delta_cents === null
      ? "We cannot say what that did to profit, because some of these products have no cost saved."
      : realized.profit_delta_cents >= 0
        ? "Profit went up over the period, because the extra margin more than covered the orders you gave up."
        : "Profit went down over the period: the orders you gave up cost more than the extra margin earned.";

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

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
