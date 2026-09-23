"use client";

import { useState } from "react";

import { formatMoney, formatMoneyDelta, formatPctDelta, formatUnits } from "@/components/format";
import { UnitsChart } from "@/components/rollout/orders-chart";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Field,
  Input,
  Notice,
  Select,
  Stat,
  StatGroup,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import type { RolloutSimApiResponse } from "@/app/api/demo/rollout-sim/route";
import type { StorePreset } from "@/lib/demo/portfolio";
import type { SimulationInput, SimulationResult } from "@/lib/demo/simulate";

type ShockChoice = "none" | "moderate" | "severe";
type FaultChoice = "none" | "throttle" | "server_error" | "timeout_after_write" | "user_errors";

type FormState = {
  preset: string;
  priceChange: string;
  selectionSize: string;
  horizonDays: string;
  thresholdPct: string;
  consecutiveDays: string;
  minExpectedUnits: string;
  shock: ShockChoice;
  shockFactor: string;
  shockFromDay: string;
  fits: "fixture" | "none";
  fault: FaultChoice;
  rollbackAtEnd: boolean;
  seed: string;
};

export type StoreBenchmark = {
  sku_count: number;
  units_per_day: number;
  elasticity: { n: number; n_estimated: number; within_0_3: number | null; mae: number | null };
};

export function RolloutSimulator({
  presets,
  initialResult,
  benchmarks,
}: {
  presets: readonly StorePreset[];
  initialResult: SimulationResult;
  benchmarks: Record<string, StoreBenchmark>;
}) {
  const [form, setForm] = useState<FormState>(() => formFromResult(initialResult));
  const [result, setResult] = useState(initialResult);
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setError(null);
  }

  async function run() {
    let input: SimulationInput;
    try {
      input = inputFromForm(form);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the simulator inputs.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/rollout-sim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const reply = (await response.json()) as RolloutSimApiResponse;
      if (!reply.ok) throw new Error(reply.issues?.join(" ") ?? reply.message);
      setResult(reply.result);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Priceflag could not run that simulation.");
    } finally {
      setRunning(false);
    }
  }

  const selectedPreset = presets.find((preset) => preset.id === form.preset) ?? presets[0];
  const benchmark = selectedPreset ? benchmarks[selectedPreset.id] : undefined;

  return (
    <div className="space-y-6">
      <Notice tone="info" title="A whole rollout, end to end, through the production engine">
        Pick a simulated store, set the price change and the guardrail, and the lab freezes a real
        draft, writes the first cohort into a fake Shopify, then ticks the real evaluator once per
        day on demand generated from a hidden true elasticity the model never sees. Change a knob,
        run again, and watch what the machine does differently. Nothing is stored.
      </Notice>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(19rem,0.72fr)_minmax(0,1.28fr)]">
        <div className="space-y-4 lg:sticky lg:top-6">
          <Card>
            <CardHeader title="Scenario" description="Store, price move, safety limits, and what goes wrong." />
            <CardBody className="space-y-5">
              <Field label="Simulated store" htmlFor="sim-preset" hint={selectedPreset?.blurb}>
                <Select id="sim-preset" value={form.preset} onChange={(event) => update("preset", event.target.value)}>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} · {preset.size} · {preset.skuCount} SKUs
                    </option>
                  ))}
                </Select>
              </Field>
              {benchmark ? (
                <p className="text-sm text-ink-muted">
                  {benchmark.sku_count} SKUs, about {formatUnits(benchmark.units_per_day)} units a day. Lane C
                  estimated {benchmark.elasticity.n_estimated} of {benchmark.elasticity.n} repriceable SKUs
                  {benchmark.elasticity.within_0_3 !== null
                    ? `; ${Math.round(benchmark.elasticity.within_0_3 * 100)}% of those land within ±0.3 of the truth.`
                    : "."}
                </p>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <Field label="Price change" htmlFor="sim-price-change" hint="Negative is a cut.">
                  <Input id="sim-price-change" inputMode="decimal" suffix="%" value={form.priceChange} onChange={(e) => update("priceChange", e.target.value)} />
                </Field>
                <Field label="SKUs repriced" htmlFor="sim-selection" hint="Chosen at random from the repriceable catalog.">
                  <Input id="sim-selection" inputMode="numeric" value={form.selectionSize} onChange={(e) => update("selectionSize", e.target.value)} />
                </Field>
                <Field label="Horizon" htmlFor="sim-horizon" hint="Days simulated after the final stage.">
                  <Select id="sim-horizon" value={form.horizonDays} onChange={(e) => update("horizonDays", e.target.value)}>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                  </Select>
                </Field>
                <Field label="Elasticity fit" htmlFor="sim-fits" hint="Lane C's real fit over this store, or none.">
                  <Select id="sim-fits" value={form.fits} onChange={(e) => update("fits", e.target.value as FormState["fits"])}>
                    <option value="fixture">Fitted from the store's history</option>
                    <option value="none">No fit (assumption tier)</option>
                  </Select>
                </Field>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-ink">Guardrail</p>
                <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                  <Field label="Below expected" htmlFor="sim-threshold">
                    <Input id="sim-threshold" inputMode="decimal" suffix="%" value={form.thresholdPct} onChange={(e) => update("thresholdPct", e.target.value)} />
                  </Field>
                  <Field label="Days in a row" htmlFor="sim-days">
                    <Input id="sim-days" inputMode="numeric" value={form.consecutiveDays} onChange={(e) => update("consecutiveDays", e.target.value)} />
                  </Field>
                  <Field label="Low-volume floor" htmlFor="sim-floor" hint="Expected units below which a day cannot count.">
                    <Input id="sim-floor" inputMode="decimal" value={form.minExpectedUnits} onChange={(e) => update("minExpectedUnits", e.target.value)} />
                  </Field>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-ink">What goes wrong</p>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <Field label="Shopper reaction" htmlFor="sim-shock" hint="Worse than the elasticity curve, on repriced SKUs only.">
                    <Select id="sim-shock" value={form.shock} onChange={(e) => update("shock", e.target.value as ShockChoice)}>
                      <option value="none">As the curve predicts</option>
                      <option value="moderate">40% worse from day 4</option>
                      <option value="severe">Demand halves from day 2</option>
                    </Select>
                  </Field>
                  <Field label="Shopify" htmlFor="sim-fault" hint="Injected on the first write, like the adversarial suite.">
                    <Select id="sim-fault" value={form.fault} onChange={(e) => update("fault", e.target.value as FaultChoice)}>
                      <option value="none">Behaves</option>
                      <option value="throttle">Throttles every write (429)</option>
                      <option value="server_error">Returns 500 once</option>
                      <option value="timeout_after_write">Times out after writing</option>
                      <option value="user_errors">200 with userErrors</option>
                    </Select>
                  </Field>
                  <Field label="Noise seed" htmlFor="sim-seed" hint="Same seed, same future.">
                    <Input id="sim-seed" inputMode="numeric" value={form.seed} onChange={(e) => update("seed", e.target.value)} />
                  </Field>
                  <div className="flex items-end pb-1">
                    <Checkbox
                      label="Roll back at the end and verify"
                      checked={form.rollbackAtEnd}
                      onChange={(e) => update("rollbackAtEnd", e.target.checked)}
                    />
                  </div>
                </div>
              </div>
            </CardBody>
            <CardFooter>
              <span>In-memory store. No Shopify client exists.</span>
              <Button variant="primary" onClick={() => void run()} loading={running} loadingLabel="Running the rollout">
                Run the rollout
              </Button>
            </CardFooter>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {error ? (
            <Notice tone="breach" title="Priceflag could not run that simulation">
              {error}
            </Notice>
          ) : null}
          {dirty ? (
            <Notice tone="hold" title="Inputs changed">
              The output still shows the last completed run. Press <strong>Run the rollout</strong> to simulate again.
            </Notice>
          ) : null}
          <SimulationReadout result={result} running={running} />
        </div>
      </div>
    </div>
  );
}

function SimulationReadout({ result, running }: { result: SimulationResult; running: boolean }) {
  const fitted = result.forecast.fitted;
  const realized = result.realized;
  const headline = describeOutcome(result);
  const currency = result.forecast.currency;

  return (
    <div className="space-y-6">
      <Card tone={headline.tone} edge data-testid="sim-result" aria-busy={running}>
        <CardHeader
          title={headline.title}
          description={headline.description}
          action={
            <Badge tone={running ? "hold" : "live"} dot pulse={running}>
              {running ? "Simulating" : `${result.days_simulated} days`}
            </Badge>
          }
        />
        <CardBody className="space-y-6">
          <StatGroup columns={4}>
            <Stat
              label="Forecast said"
              value={<span data-testid="sim-forecast-units">{formatPctDelta(fitted?.expected.units_change_pct)}</span>}
              note={
                result.accuracy.forecast_low_pct !== null
                  ? `Range ${formatPctDelta(result.accuracy.forecast_low_pct)} to ${formatPctDelta(result.accuracy.forecast_high_pct)} units · ${result.forecast.confidence}`
                  : "No usable baseline."
              }
            />
            <Stat
              label="Shoppers did"
              value={<span data-testid="sim-realized-units">{formatPctDelta(realized?.units_change_pct)}</span>}
              tone={result.accuracy.in_range === null ? "default" : result.accuracy.in_range ? "live" : "hold"}
              note={
                realized
                  ? `${formatUnits(realized.actual_units)} sold vs ${formatUnits(realized.control_units)} expected at the old price, over ${realized.treated_sku_days} SKU-days. ${
                      result.accuracy.in_range === null ? "" : result.accuracy.in_range ? "Inside the forecast range." : "Outside the forecast range."
                    }`
                  : "No SKU went live."
              }
            />
            <Stat
              label={`${result.input.horizon_days}-day profit`}
              value={formatMoneyDelta(realized?.profit_delta_cents ?? null, { showCents: false, currency })}
              tone={realized?.profit_delta_cents == null ? "hold" : realized.profit_delta_cents >= 0 ? "live" : "breach"}
              note={
                fitted?.expected.profit_delta_cents != null
                  ? `Forecast ${formatMoneyDelta(fitted.expected.profit_delta_cents, { showCents: false, currency })}. Realized is scaled to the same window.`
                  : "Profit unknown: a repriced SKU has no cost."
              }
            />
            <Stat
              label="Guardrail"
              value={
                result.detection.paused_day
                  ? `Paused day ${result.timeline.findIndex((row) => row.day === result.detection.paused_day) + 1}`
                  : result.rollout.status === "rolled_back" || result.timeline.some((row) => row.decision === "complete")
                    ? "Never fired"
                    : "Still holding"
              }
              tone={result.detection.false_pause ? "breach" : result.detection.paused_day ? "hold" : "live"}
              note={
                result.detection.shock_day
                  ? result.detection.days_to_pause !== null
                    ? `Shock began ${result.detection.shock_day}; caught ${result.detection.days_to_pause} day${result.detection.days_to_pause === 1 ? "" : "s"} later. Paused and emailed a recommendation; nothing was reverted automatically.`
                    : `Shock began ${result.detection.shock_day} and was not caught before the run ended.`
                  : result.detection.false_pause
                    ? "A pause with no shock injected: a false alarm on this seed."
                    : "No shock was injected."
              }
            />
          </StatGroup>

          {result.readings.length > 0 ? (
            <UnitsChart readings={result.readings} stageCount={result.input.stages.length} />
          ) : (
            <Notice tone="hold" title="Nothing was judged">
              The rollout never reached a running state, so the evaluator had no day to evaluate.
            </Notice>
          )}

          {result.rollback ? (
            <Notice
              tone={result.rollback.all_baselines_restored ? "info" : "breach"}
              title={
                result.rollback.all_baselines_restored
                  ? `Rolled back: ${result.rollback.verified} price${result.rollback.verified === 1 ? "" : "s"} re-read from Shopify at the frozen baseline`
                  : `Rollback left ${result.rollback.mismatched} price${result.rollback.mismatched === 1 ? "" : "s"} unverified`
              }
            >
              Every price write is journaled and reversible. The lab restores from the baselines frozen when the
              draft was created, never from anything computed later.
            </Notice>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Day by day" description="What the evaluator saw and decided each morning. Same code path as the daily GitHub Actions tick." />
        <CardBody flush>
          <Table caption="Daily evaluator decisions" layout="fit">
            <THead>
              <TR>
                <TH>Day</TH>
                <TH>Stage</TH>
                <TH numeric>Sold</TH>
                <TH numeric>Expected</TH>
                <TH>Range</TH>
                <TH>Decision</TH>
              </TR>
            </THead>
            <TBody>
              {result.timeline.map((row) => (
                <TR key={row.day} tone={row.breach ? "breach" : row.decision === "advance" || row.decision === "complete" ? "live" : undefined}>
                  <TD>{row.day}</TD>
                  <TD>{row.stage_index + 1}</TD>
                  <TD numeric>{row.actual_units === null ? "—" : formatUnits(row.actual_units)}</TD>
                  <TD numeric>{row.expected_units === null ? "—" : formatUnits(row.expected_units, 1)}</TD>
                  <TD>
                    {row.expected_low === null || row.expected_high === null
                      ? "—"
                      : `${formatUnits(row.expected_low, 1)} – ${formatUnits(row.expected_high, 1)}${row.band_floored ? " · too quiet to judge" : ""}`}
                  </TD>
                  <TD>
                    <span className="font-medium text-ink">{row.decision}</span>
                    {row.breach ? <span className="ml-2 text-xs text-breach">breach</span> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="The SKUs, with the answer key"
          description="Simulator ground truth alongside what Lane C estimated from observable history. Merchants never see a truth column, because real stores do not have one."
        />
        <CardBody flush>
          <Table caption="Selected SKUs with hidden truth and estimated elasticity" layout="fit">
            <THead>
              <TR>
                <TH>Product</TH>
                <TH>Cohort</TH>
                <TH numeric>Was</TH>
                <TH numeric>Now</TH>
                <TH numeric>Units/day</TH>
                <TH numeric>True elasticity</TH>
                <TH numeric>Estimated</TH>
                <TH>Tier</TH>
              </TR>
            </THead>
            <TBody>
              {result.selection.map((row) => (
                <TR key={row.variant_gid}>
                  <TD>{row.title}</TD>
                  <TD>Stage {row.cohort_stage + 1}</TD>
                  <TD numeric>{formatMoney(row.baseline_price_cents, { currency })}</TD>
                  <TD numeric>{formatMoney(row.target_price_cents, { currency })}</TD>
                  <TD numeric>{formatUnits(row.baseline_units_per_day, 1)}</TD>
                  <TD numeric>{row.true_elasticity.toFixed(2)}</TD>
                  <TD numeric>{row.fitted_elasticity === null ? "—" : row.fitted_elasticity.toFixed(2)}</TD>
                  <TD>{row.fit_confidence}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
        <CardFooter>
          <span>
            Store-wide: {result.elasticity.store.n_estimated} of {result.elasticity.store.n} repriceable SKUs estimated
            {result.elasticity.store.within_0_3 !== null
              ? `, ${Math.round(result.elasticity.store.within_0_3 * 100)}% within ±0.3, mean error ${result.elasticity.store.mae?.toFixed(2)}`
              : ""}
            .
          </span>
          <Badge tone="neutral">Lab only</Badge>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader title="What the merchant would have received" description="Every email the evaluator composed, in order. Beta posture: recommend, never revert." />
        <CardBody>
          <ol className="space-y-2">
            {result.notifications.length === 0 ? <li className="text-sm text-ink-muted">No emails.</li> : null}
            {result.notifications.map((notification, index) => (
              <li key={`${notification.kind}-${index}`} className="flex gap-3 rounded-md border border-border bg-surface px-3 py-2">
                <Badge tone={notification.kind === "breach" ? "breach" : notification.kind === "completed" ? "live" : "neutral"} size="sm">
                  {notification.kind.replace(/_/g, " ")}
                </Badge>
                <span className="min-w-0 text-sm text-ink-muted">
                  {notification.reason ?? (notification.detail !== null ? `Stage ${notification.detail}` : "")}
                </span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}

function describeOutcome(result: SimulationResult): { tone: "live" | "hold" | "breach"; title: string; description: string } {
  if (result.timeline.length === 0) {
    return {
      tone: "breach",
      title: "The first stage never went live",
      description: result.rollout.paused_reason ?? "Shopify refused the first write, so the rollout paused before any price changed.",
    };
  }
  if (result.detection.false_pause) {
    return {
      tone: "breach",
      title: "Paused on a healthy rollout",
      description: "The guardrail fired with no shock injected. Loosen the threshold, require more days, or raise the low-volume floor and run again.",
    };
  }
  if (result.detection.paused_day) {
    return {
      tone: "hold",
      title: "Caught it: paused, explained, left the decision with the merchant",
      description: `Demand on the repriced SKUs fell below the range from ${result.detection.shock_day}. The evaluator paused on ${result.detection.paused_day} and emailed a recommendation to roll back.`,
    };
  }
  if (result.accuracy.in_range === false) {
    return {
      tone: "hold",
      title: "Completed, but shoppers landed outside the forecast range",
      description: "The staged rollout finished. The realized unit change fell outside the range the forecast promised, which is the case the post-rollout report exists to say out loud.",
    };
  }
  return {
    tone: "live",
    title: "Completed inside the forecast range",
    description: "Every stage held, the new price went live on the whole selection, and what shoppers did stayed inside the range the forecast showed the merchant.",
  };
}

function formFromResult(result: SimulationResult): FormState {
  const shock = result.input.shock;
  return {
    preset: result.preset.id,
    priceChange: String(result.input.price_change_pct),
    selectionSize: String(result.input.selection_size),
    horizonDays: String(result.input.horizon_days),
    thresholdPct: String(result.input.guardrail.threshold_pct),
    consecutiveDays: String(result.input.guardrail.consecutive_days),
    minExpectedUnits: String(result.input.guardrail.min_expected_units),
    shock: shock ? (shock.factor <= 0.5 ? "severe" : "moderate") : "none",
    shockFactor: shock ? String(shock.factor) : "0.6",
    shockFromDay: shock ? String(shock.from_day) : "4",
    fits: result.input.fits,
    fault: (result.input.shopify_fault?.kind as FaultChoice | undefined) ?? "none",
    rollbackAtEnd: result.input.rollback_at_end,
    seed: result.input.seed === undefined ? "" : String(result.input.seed),
  };
}

function inputFromForm(form: FormState): SimulationInput {
  const number = (value: string, label: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number.`);
    return parsed;
  };
  const shock =
    form.shock === "none"
      ? null
      : form.shock === "severe"
        ? { factor: 0.5, from_day: 2 }
        : { factor: 0.6, from_day: 4 };
  const fault = form.fault === "none" ? null : { kind: form.fault, onCall: 1, persistent: form.fault === "throttle" };
  return {
    preset: form.preset,
    price_change_pct: number(form.priceChange, "Price change"),
    selection_size: Math.round(number(form.selectionSize, "SKUs repriced")),
    horizon_days: Math.round(number(form.horizonDays, "Horizon")),
    guardrail: {
      threshold_pct: number(form.thresholdPct, "Threshold"),
      consecutive_days: Math.round(number(form.consecutiveDays, "Days in a row")),
      min_expected_units: number(form.minExpectedUnits, "Low-volume floor"),
    },
    shock,
    fits: form.fits,
    shopify_fault: fault,
    rollback_at_end: form.rollbackAtEnd,
    ...(form.seed.trim() === "" ? {} : { seed: Math.round(number(form.seed, "Seed")) }),
  };
}
