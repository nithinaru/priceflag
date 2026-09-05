"use client";

import { useState } from "react";

import { formatDateTime, formatMoney, formatMoneyDelta, formatPctDelta, formatUnits } from "@/components/format";
import { ForecastCard } from "@/components/propose/forecast-card";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
  Notice,
  Select,
  Stat,
  StatGroup,
} from "@/components/ui";
import { parseMoneyToCents } from "@/components/format";
import type {
  FounderLabApiResponse,
  FounderLabInput,
  FounderLabResult,
  FounderLabRounding,
} from "@/lib/demo/founder-lab";

type FormState = {
  productName: string;
  skuCount: string;
  currentPrice: string;
  unitCost: string;
  unitsPerDay: string;
  priceChange: string;
  elasticity: string;
  uncertainty: string;
  historyDays: string;
  horizonDays: string;
  rounding: FounderLabRounding;
};

const PRESETS: { label: string; description: string; input: FounderLabInput }[] = [
  {
    label: "Measured increase",
    description: "Healthy margin, steady demand, modest price lift.",
    input: {
      product_name: "Northline Everyday Tee",
      sku_count: 8,
      current_price_cents: 4800,
      cogs_cents: 1800,
      units_per_day: 12,
      price_change_pct: 8,
      elasticity: -1.2,
      elasticity_se: 0.25,
      history_days: 120,
      horizon_days: 90,
      rounding: "end_99",
    },
  },
  {
    label: "Below-cost trap",
    description: "A large discount that should trigger an obvious warning.",
    input: {
      product_name: "Founder Hoodie",
      sku_count: 6,
      current_price_cents: 6400,
      cogs_cents: 4600,
      units_per_day: 8,
      price_change_pct: -35,
      elasticity: -1.8,
      elasticity_se: 0.35,
      history_days: 120,
      horizon_days: 90,
      rounding: "end_99",
    },
  },
  {
    label: "Uncertain launch",
    description: "Thin history and a wide demand-response range.",
    input: {
      product_name: "New Ceramic Set",
      sku_count: 3,
      current_price_cents: 12000,
      cogs_cents: 4500,
      units_per_day: 0.7,
      price_change_pct: 15,
      elasticity: -1.5,
      elasticity_se: 0.9,
      history_days: 35,
      horizon_days: 60,
      rounding: "end_00",
    },
  },
];

export function FounderLab({
  initialInput,
  initialResult,
}: {
  initialInput: FounderLabInput;
  initialResult: FounderLabResult;
}) {
  const [form, setForm] = useState<FormState>(() => formFromInput(initialInput));
  const [result, setResult] = useState(initialResult);
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setError(null);
  }

  function loadPreset(input: FounderLabInput) {
    setForm(formFromInput(input));
    setDirty(true);
    setError(null);
  }

  async function run() {
    let input: FounderLabInput;
    try {
      input = inputFromForm(form);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the scenario inputs.");
      return;
    }

    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/founder-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const reply = (await response.json()) as FounderLabApiResponse;
      if (!reply.ok) throw new Error(reply.issues?.join(" ") ?? reply.message);
      setResult(reply.result);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Priceflag could not run that scenario.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <Notice tone="info" title="Real engine, simulated store">
        The forecast, breakeven math, warnings, price rounding, and SKU rollout cohorts below use
        production modules. Your demand sensitivity is injected as a labelled simulated fit. This
        page stores nothing and never constructs a Shopify client.
      </Notice>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(19rem,0.72fr)_minmax(0,1.28fr)]">
        <div className="space-y-4 lg:sticky lg:top-6">
          <Card>
            <CardHeader
              title="Build a merchant scenario"
              description="Start with a preset or change every assumption yourself."
            />
            <CardBody className="space-y-5">
              <div>
                <p className="mb-2 text-sm font-medium text-ink">Quick scenarios</p>
                <div className="grid gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => loadPreset(preset.input)}
                      className="rounded-md border border-border-strong bg-surface px-3 py-2 text-left outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span className="block text-base font-medium text-ink">{preset.label}</span>
                      <span className="block text-sm text-ink-muted">{preset.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <Field label="Product family" htmlFor="lab-product-name" className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
                  <Input
                    id="lab-product-name"
                    value={form.productName}
                    onChange={(event) => update("productName", event.target.value)}
                  />
                </Field>
                <Field label="Matching SKUs" htmlFor="lab-sku-count" hint="Each SKU uses the economics below.">
                  <Input
                    id="lab-sku-count"
                    inputMode="numeric"
                    value={form.skuCount}
                    onChange={(event) => update("skuCount", event.target.value)}
                  />
                </Field>
                <Field label="Units / day / SKU" htmlFor="lab-units-day">
                  <Input
                    id="lab-units-day"
                    inputMode="decimal"
                    value={form.unitsPerDay}
                    onChange={(event) => update("unitsPerDay", event.target.value)}
                  />
                </Field>
                <Field label="Current price" htmlFor="lab-current-price">
                  <Input
                    id="lab-current-price"
                    inputMode="decimal"
                    prefix="$"
                    value={form.currentPrice}
                    onChange={(event) => update("currentPrice", event.target.value)}
                  />
                </Field>
                <Field label="Unit cost" htmlFor="lab-unit-cost" hint="Blank keeps profit honestly unknown." optional>
                  <Input
                    id="lab-unit-cost"
                    inputMode="decimal"
                    prefix="$"
                    value={form.unitCost}
                    onChange={(event) => update("unitCost", event.target.value)}
                  />
                </Field>
                <Field label="Price change" htmlFor="lab-price-change" hint="Negative means a price cut.">
                  <Input
                    id="lab-price-change"
                    inputMode="decimal"
                    suffix="%"
                    value={form.priceChange}
                    onChange={(event) => update("priceChange", event.target.value)}
                  />
                </Field>
                <Field label="Storefront rounding" htmlFor="lab-rounding">
                  <Select
                    id="lab-rounding"
                    value={form.rounding}
                    onChange={(event) => update("rounding", event.target.value as FounderLabRounding)}
                  >
                    <option value="none">Exact cents</option>
                    <option value="end_99">End in .99</option>
                    <option value="end_95">End in .95</option>
                    <option value="end_00">Whole dollars</option>
                  </Select>
                </Field>
                <Field label="Demand sensitivity" htmlFor="lab-elasticity" hint="−1.2 means a 1% price rise predicts roughly 1.2% fewer units.">
                  <Input
                    id="lab-elasticity"
                    inputMode="decimal"
                    value={form.elasticity}
                    onChange={(event) => update("elasticity", event.target.value)}
                  />
                </Field>
                <Field label="Model uncertainty" htmlFor="lab-uncertainty" hint="Higher makes the outcome range wider.">
                  <Input
                    id="lab-uncertainty"
                    inputMode="decimal"
                    value={form.uncertainty}
                    onChange={(event) => update("uncertainty", event.target.value)}
                  />
                </Field>
                <Field label="History available" htmlFor="lab-history-days">
                  <Select
                    id="lab-history-days"
                    value={form.historyDays}
                    onChange={(event) => update("historyDays", event.target.value)}
                  >
                    <option value="35">35 days — thin</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                    <option value="120">120 days</option>
                    <option value="180">180 days</option>
                  </Select>
                </Field>
                <Field label="Forecast horizon" htmlFor="lab-horizon-days">
                  <Select
                    id="lab-horizon-days"
                    value={form.horizonDays}
                    onChange={(event) => update("horizonDays", event.target.value)}
                  >
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                    <option value="180">180 days</option>
                  </Select>
                </Field>
              </div>
            </CardBody>
            <CardFooter>
              <span>Read-only founder sandbox.</span>
              <Button
                variant="primary"
                onClick={() => void run()}
                loading={running}
                loadingLabel="Running the Priceflag engine"
              >
                Run Priceflag
              </Button>
            </CardFooter>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {error ? (
            <Notice tone="breach" title="Priceflag could not run that scenario">
              {error}
            </Notice>
          ) : null}

          {dirty ? (
            <Notice tone="hold" title="Inputs changed">
              The output still shows the last completed run. Press <strong>Run Priceflag</strong> to
              calculate the new scenario.
            </Notice>
          ) : null}

          <FounderReadout result={result} running={running} />
          <ForecastCard forecast={result.forecast} />
        </div>
      </div>
    </div>
  );
}

function FounderReadout({ result, running }: { result: FounderLabResult; running: boolean }) {
  const { forecast } = result;
  const fitted = forecast.fitted;
  const line = forecast.products[0];
  const expectedProfit = fitted?.expected.profit_delta_cents ?? null;
  const lowProfit = fitted?.low.profit_delta_cents ?? null;
  const warningBelowCost = forecast.warnings.some((warning) => warning.code === "price_below_cost");
  const readout = founderReadout(expectedProfit, lowProfit, warningBelowCost, forecast.baseline.has_cogs);
  const targetPrice = line?.target_price_cents ?? forecast.baseline.avg_price_cents;

  return (
    <Card tone={readout.tone} edge data-testid="founder-lab-result" aria-busy={running}>
      <CardHeader
        title={readout.title}
        description={readout.description}
        action={
          <Badge tone={running ? "hold" : "live"} dot pulse={running}>
            {running ? "Calculating" : "Complete"}
          </Badge>
        }
      />
      <CardBody className="space-y-6">
        <StatGroup columns={4}>
          <Stat
            label="Target price"
            value={<span data-testid="lab-target-price">{formatMoney(targetPrice)}</span>}
            note={`${formatMoney(forecast.baseline.avg_price_cents)} today, after the selected rounding rule.`}
          />
          <Stat
            label="Expected unit response"
            value={formatPctDelta(fitted?.expected.units_change_pct)}
            tone={(fitted?.expected.units_change_pct ?? 0) < 0 ? "hold" : "default"}
            note="The demand curve is applied SKU by SKU before totals are added."
          />
          <Stat
            label={`${forecast.horizon_days}-day profit`}
            value={formatMoneyDelta(expectedProfit, { showCents: false })}
            tone={expectedProfit === null ? "hold" : expectedProfit >= 0 ? "live" : "breach"}
            note={
              lowProfit === null
                ? "Profit stays unknown until cost is entered."
                : `Conservative edge: ${formatMoneyDelta(lowProfit, { showCents: false })}.`
            }
          />
          <Stat
            label="Break-even demand"
            value={formatPctDelta(forecast.breakeven.units_change_pct, 0)}
            note={forecast.breakeven.sentence}
          />
        </StatGroup>

        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Calculation trace</h3>
            <span className="text-sm text-ink-muted">
              Completed {formatDateTime(forecast.generated_at)}
            </span>
          </div>
          <ol className="grid gap-2">
            <TraceRow
              number={1}
              title="Build the baseline"
              detail={`${formatUnits(forecast.baseline.units_per_day, 1)} units/day across ${forecast.proposal.variant_count} SKUs from ${forecast.baseline.history_days} days of synthetic order rows.`}
            />
            <TraceRow
              number={2}
              title="Apply the proposed price"
              detail={`${formatMoney(forecast.baseline.avg_price_cents)} becomes ${formatMoney(targetPrice)} after ${roundingWords(forecast.proposal.rounding)}.`}
            />
            <TraceRow
              number={3}
              title="Run the demand model"
              detail={`Elasticity ${result.simulated_fit.elasticity.toFixed(2)} ± ${result.simulated_fit.elasticity_se.toFixed(2)} produces an expected ${formatPctDelta(fitted?.expected.units_change_pct)} unit response.`}
            />
            <TraceRow
              number={4}
              title="Check the economics"
              detail={`${forecast.breakeven.sentence} The full scenario grid and assumptions remain visible below.`}
            />
            <TraceRow
              number={5}
              title="Plan a reversible rollout"
              detail={result.rollout_plan
                .map((stage) => `${stage.skus_live}/${stage.skus_total} SKUs for ${stage.hold_days}d`)
                .join(" → ")}
            />
          </ol>
        </div>

        <div>
          <h3 className="mb-3 text-base font-semibold text-ink">Production-shaped rollout</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {result.rollout_plan.map((stage) => (
              <div key={stage.index} className="rounded-lg border border-border bg-surface-muted p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">Stage {stage.index + 1}</span>
                  <Badge tone={stage.index === 0 ? "accent" : "neutral"} size="sm">
                    {Math.round(stage.fraction * 100)}%
                  </Badge>
                </div>
                <p className="mt-2 text-lg font-semibold tabular-nums text-ink">
                  {stage.skus_live} of {stage.skus_total} SKUs
                </p>
                <p className="mt-1 text-sm text-ink-muted">
                  Hold {stage.hold_days} days, evaluate, then advance or pause.
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-ink-muted">
            These are SKU cohorts, not visitor cohorts. Every shopper sees the same price for a SKU.
          </p>
        </div>
      </CardBody>
      <CardFooter>
        <span>{result.simulated_fit.explanation}</span>
        <Badge tone="neutral">No persistence</Badge>
      </CardFooter>
    </Card>
  );
}

function TraceRow({ number, title, detail }: { number: number; title: string; detail: string }) {
  return (
    <li className="flex gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-tint text-xs font-semibold text-accent">
        {number}
      </span>
      <div className="min-w-0">
        <p className="text-base font-medium text-ink">{title}</p>
        <p className="text-sm text-ink-muted">{detail}</p>
      </div>
    </li>
  );
}

function founderReadout(
  expectedProfit: number | null,
  lowProfit: number | null,
  belowCost: boolean,
  hasCogs: boolean,
): { tone: "live" | "hold" | "breach"; title: string; description: string } {
  if (!hasCogs) {
    return {
      tone: "hold",
      title: "Revenue is modeled; profit needs a cost",
      description: "Priceflag refuses to invent COGS. Add unit cost to unlock the profit and break-even readout.",
    };
  }
  if (belowCost || (expectedProfit !== null && expectedProfit < 0)) {
    return {
      tone: "breach",
      title: "This scenario does not clear the economics check",
      description: "The proposed move crosses a visible safety boundary before any draft or Shopify write exists.",
    };
  }
  if (lowProfit !== null && lowProfit < 0) {
    return {
      tone: "hold",
      title: "Potential upside, meaningful downside",
      description: "The expected case is positive, but the conservative model edge is not. This is exactly where staged monitoring earns its keep.",
    };
  }
  return {
    tone: "live",
    title: "The modeled range supports a staged test",
    description: "The expected economics are positive under the entered assumptions. A real merchant would still review a frozen draft before the first write.",
  };
}

function roundingWords(rounding: string): string {
  switch (rounding) {
    case "end_99":
      return ".99 rounding";
    case "end_95":
      return ".95 rounding";
    case "end_00":
      return "whole-dollar rounding";
    default:
      return "exact-cent pricing";
  }
}

function formFromInput(input: FounderLabInput): FormState {
  return {
    productName: input.product_name,
    skuCount: String(input.sku_count),
    currentPrice: (input.current_price_cents / 100).toFixed(2),
    unitCost: input.cogs_cents === null ? "" : (input.cogs_cents / 100).toFixed(2),
    unitsPerDay: String(input.units_per_day),
    priceChange: String(input.price_change_pct),
    elasticity: String(input.elasticity),
    uncertainty: String(input.elasticity_se),
    historyDays: String(input.history_days),
    horizonDays: String(input.horizon_days),
    rounding: input.rounding,
  };
}

function inputFromForm(form: FormState): FounderLabInput {
  const currentPrice = parseMoneyToCents(form.currentPrice);
  const unitCost = form.unitCost.trim() === "" ? null : parseMoneyToCents(form.unitCost);
  if (currentPrice === null || currentPrice < 1) throw new Error("Enter a current price above $0.");
  if (form.unitCost.trim() !== "" && (unitCost === null || unitCost < 0)) {
    throw new Error("Enter a non-negative unit cost or leave it blank.");
  }

  return {
    product_name: form.productName.trim(),
    sku_count: Number(form.skuCount),
    current_price_cents: currentPrice,
    cogs_cents: unitCost,
    units_per_day: Number(form.unitsPerDay),
    price_change_pct: Number(form.priceChange),
    elasticity: Number(form.elasticity),
    elasticity_se: Number(form.uncertainty),
    history_days: Number(form.historyDays),
    horizon_days: Number(form.horizonDays),
    rounding: form.rounding,
  };
}
