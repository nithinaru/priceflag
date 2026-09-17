import {
  Badge,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CellNote,
  Notice,
  Stat,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/components/ui";
import { cn } from "@/components/cn";
import { RangeBar } from "@/components/propose/range-bar";
import { ScenarioFan } from "@/components/charts/scenario-fan";
import {
  ConfidenceBadge,
  ConfidenceNote,
  CostSourceNote,
  ExclusionBadge,
} from "@/components/domain/status";
import { PriceMove } from "@/components/domain/journal";
import { countOf, formatMoney, formatMoneyDelta, formatPct, formatPctDelta, formatUnits } from "@/components/format";
import type { ForecastResult, ForecastWarningCode } from "@/lib/contracts";

/**
 * The forecast card, rendering `contracts/forecast_result.schema.json`.
 *
 * Order is the argument (R6, R8):
 *
 * 1. the breakeven sentence — transparent unit-margin arithmetic with any
 *    multi-product proportional-demand assumption visible beside it
 * 2. the predicted range, store-fitted or visibly based on a broad default
 * 3. how much to trust it, in one line the engine wrote
 * 4. every assumption, and the scenario table, one click away
 *
 * Nothing here computes anything. Every number and every sentence comes off the
 * contract, so the UI cannot drift from what the engine and the evaluator did.
 */
export function ForecastCard({ forecast }: { forecast: ForecastResult }) {
  const currency = forecast.currency;
  const money = (cents: number) => formatMoneyDelta(cents, { currency, showCents: false });
  const included = forecast.products.filter((line) => !line.excluded);
  const excluded = forecast.products.filter((line) => line.excluded);
  const profitUnknown = !forecast.baseline.has_cogs;

  /**
   * A store with no trading yet. Every scenario row is zero units and zero
   * money, and breakeven is undefined because there is no order volume to break
   * even against — so the whole "pick a level of unit change and read across"
   * apparatus has nothing in it. Rendering it anyway is how a correct fallback
   * chain ends up looking like a broken app. This is the *default* first-run
   * state on a young store, not an edge case.
   */
  const noTrading = forecast.baseline.units_per_day <= 0;

  return (
    <div className="space-y-6">
      <Card tone="accent" edge>
        <CardHeader
          title="What this change would do"
          description={`${forecast.horizon_days} days`}
        />

        <CardBody className="space-y-6">
          {/* 1. Arithmetic independent of the demand model, with its multi-SKU assumption visible. */}
          {noTrading ? (
            <div className="space-y-1.5">
              <p className="max-w-prose text-lg font-medium text-ink">
                We cannot tell you what this change will do — your store has no sales for us to
                learn from yet.
              </p>
              <p className="max-w-prose text-sm text-ink-muted">
                That is not a problem with your store or with this change. We work out what a price
                change will do by looking at what you have already sold, and there is nothing there
                yet. We would rather say so than dress up a guess.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="max-w-prose text-lg font-medium text-ink">
                {forecast.breakeven.sentence}
              </p>
              <p className="text-sm text-ink-muted">
                {included.length === 1
                  ? "That is transparent unit-margin arithmetic. It does not depend on predicting demand."
                  : "That arithmetic assumes unit demand moves proportionally across the selected products. The range below models each product separately."}
              </p>
            </div>
          )}

          {noTrading ? (
            <div className="rounded-lg border border-border bg-surface-muted p-4">
              <h3 className="text-md font-semibold text-ink">What you can still rely on</h3>
              <ul className="mt-2 space-y-1.5">
                <li className="flex gap-2 text-base text-ink-muted">
                  <span aria-hidden="true" className="text-ink-subtle">
                    •
                  </span>
                  <span className="max-w-prose">
                    {profitUnknown ? (
                      <>
                        <strong className="font-medium text-ink">Add your costs</strong> and the
                        table below shows exactly what you make on each sale before and after this
                        change. That is arithmetic — it needs costs, not orders, so it works from
                        your very first day.
                      </>
                    ) : (
                      <>
                        The table below shows exactly what you make on each sale before and after
                        this change. That is arithmetic — it needs costs, not orders, so it is
                        already true today.
                      </>
                    )}
                  </span>
                </li>
                <li className="flex gap-2 text-base text-ink-muted">
                  <span aria-hidden="true" className="text-ink-subtle">
                    •
                  </span>
                  <span className="max-w-prose">
                    You can still plan this carefully: set a limit that pauses the rollout, move a
                    few products at a time, and keep manual rollback one click away.
                  </span>
                </li>
                <li className="flex gap-2 text-base text-ink-muted">
                  <span aria-hidden="true" className="text-ink-subtle">
                    •
                  </span>
                  <span className="max-w-prose">
                    As unit sales come in we start building the expected range, and we will tell you the
                    moment there is enough to be worth reading.
                  </span>
                </li>
              </ul>
            </div>
          ) : null}

          {/* 2. The prediction — only when there is one. */}
          {forecast.fitted ? (
            <div className="space-y-4 rounded-lg border border-border bg-surface-muted p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-md font-semibold text-ink">
                  What we think will actually happen
                </h3>
                <span className="text-xs text-ink-subtle">
                  {forecast.fitted.source === "category_default"
                    ? "Broad default range — not learned from your store"
                    : `Range, not a single number — ${formatPct(forecast.fitted.price_variation_pct, 0)} price movement in your history to learn from`}
                </span>
              </div>

              <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                <RangedStat
                  label={`Profit over ${forecast.horizon_days} days`}
                  low={forecast.fitted.low.profit_delta_cents}
                  high={forecast.fitted.high.profit_delta_cents}
                  expected={forecast.fitted.expected.profit_delta_cents}
                  format={money}
                  unknownNote="Add a cost for every product and we can predict profit too."
                />
                <RangedStat
                  label={`Revenue over ${forecast.horizon_days} days`}
                  low={forecast.fitted.low.revenue_delta_cents}
                  high={forecast.fitted.high.revenue_delta_cents}
                  expected={forecast.fitted.expected.revenue_delta_cents}
                  format={money}
                  note="Revenue can fall while profit rises."
                />
                <RangedStat
                  label="Unit sales"
                  low={forecast.fitted.low.units_change_pct}
                  high={forecast.fitted.high.units_change_pct}
                  expected={forecast.fitted.expected.units_change_pct}
                  format={(value) => formatPctDelta(value, 0)}
                  // Units falling when a price rises is the expected trade, not
                  // a warning — the tint is reserved for profit.
                  tone="neutral"
                  note="How many fewer or more units you would sell. This is not order count."
                />
              </div>
            </div>
          ) : noTrading ? null : (
            <Notice tone="info" title="We are not going to guess what your customers will do">
              {forecast.confidence_explanation} The table below shows the arithmetic at several
              levels of unit-sales change.
            </Notice>
          )}

          {/* 3. How much to trust it. When there is no prediction the notice above
              already carries the engine's explanation, so only the tier is shown
              here — saying the same sentence twice reads as padding. */}
          {forecast.fitted ? (
            <ConfidenceNote tier={forecast.confidence} explanation={forecast.confidence_explanation} />
          ) : (
            <ConfidenceBadge tier={forecast.confidence} size="md" />
          )}

          {/* The engine's explanation ends by pointing at the scenario table. With
              no trading that table is suppressed, so the sentence would point at
              nothing — the panel above replaces it. */}
          {!noTrading && remainder(forecast.explanation, forecast.breakeven.sentence) ? (
            <p className="max-w-prose text-base text-ink-muted">
              {remainder(forecast.explanation, forecast.breakeven.sentence)}
            </p>
          ) : null}
        </CardBody>

        <CardFooter>
          <span>
            {countOf(included.length, "product")} would change
            {excluded.length > 0 ? `, ${excluded.length} left out` : ""}.{" "}
            {noTrading
              ? "No sales recorded yet, so there is no baseline to compare against."
              : `Based on ${countOf(
                  forecast.baseline.history_days,
                  "day",
                )} of your sales, averaging ${formatUnits(
                  forecast.baseline.units_per_day,
                  1,
                )} units a day.`}
          </span>
          <span>
            {forecast.model_version
              ? `Predicted by ${forecast.model_version}.`
              : forecast.fitted?.source === "category_default"
                ? "Predicted with a broad consumer-goods assumption."
                : noTrading
                  ? "Nothing here is predicted."
                  : "No model was used — this is margin arithmetic."}
          </span>
        </CardFooter>
      </Card>

      {forecast.warnings.map((warning) => (
        <Notice
          key={warning.code}
          tone={warningTone(warning.code)}
          title={warningTitle(warning.code)}
        >
          {warning.message}
        </Notice>
      ))}

      {/* 4. Show your work. Collapsed, never hidden (R8) — but on a store with no
          trading every row is zero units and zero money, and a table of zeros
          teaches nothing. The per-product table below is the honest substitute. */}
      {noTrading ? null : (
      <Card>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus sm:px-5">
            <span className="min-w-0">
              <span className="block text-md font-semibold text-ink">Show your work</span>
              <span className="block text-base text-ink-muted">
                Every assumption, and what happens at each level of unit-sales change.
              </span>
            </span>
            <span
              className="shrink-0 text-sm font-medium text-accent group-open:hidden"
              aria-hidden="true"
            >
              Open
            </span>
            <span
              className="hidden shrink-0 text-sm font-medium text-accent group-open:inline"
              aria-hidden="true"
            >
              Close
            </span>
          </summary>

          <div className="border-t border-border">
            <ScenarioFan forecast={forecast} />
            <Table
              layout="intrinsic"
              caption="What happens to revenue and profit at each level of unit-sales change"
            >
              <THead>
                <TR>
                  <TH>If unit sales…</TH>
                  <TH numeric>Change in units</TH>
                  <TH numeric>Units over {forecast.horizon_days} days</TH>
                  <TH numeric>Revenue</TH>
                  <TH numeric>Profit</TH>
                </TR>
              </THead>
              <TBody>
                {forecast.scenarios.map((scenario) => (
                  <TR
                    key={scenario.label}
                    className={cn(scenario.is_breakeven && "bg-surface")}
                  >
                    <TD>
                      <span className="font-medium">{scenario.label}</span>
                      {scenario.is_breakeven ? (
                        <CellNote className="text-accent">
                          the point where profit is unchanged
                        </CellNote>
                      ) : null}
                    </TD>
                    <TD numeric>{formatPctDelta(scenario.units_change_pct, 1)}</TD>
                    <TD numeric className="text-ink-muted">
                      {formatUnits(scenario.units_total)}
                    </TD>
                    <TD numeric>{money(scenario.revenue_delta_cents)}</TD>
                    <TD
                      numeric
                      className={cn(
                        scenario.profit_delta_cents !== null &&
                          scenario.profit_delta_cents < 0 &&
                          "text-breach",
                      )}
                    >
                      {scenario.profit_delta_cents === null ? (
                        <span className="text-ink-muted">Unknown</span>
                      ) : (
                        money(scenario.profit_delta_cents)
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            {forecast.assumptions.length > 0 ? (
              <div className="border-t border-border px-4 py-4 sm:px-5">
                <h4 className="text-base font-semibold text-ink">What this rests on</h4>
                <ul className="mt-2 space-y-1.5">
                  {forecast.assumptions.map((assumption) => (
                    <li key={assumption} className="flex gap-2 text-base text-ink-muted">
                      <span aria-hidden="true" className="text-ink-subtle">
                        •
                      </span>
                      <span className="max-w-prose">{assumption}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      </Card>
      )}

      {/* Per-product breakdown. */}
      <Card>
        <CardHeader title="Product by product" />
        <CardBody flush>
          <Table
            layout="intrinsic"
            caption="Each selected product with its current and new price, cost and profit"
          >
            <THead>
              <TR>
                <TH>Product</TH>
                <TH numeric>Price</TH>
                <TH numeric>Cost</TH>
                <TH numeric>Profit per sale</TH>
                <TH numeric>Sells per day</TH>
                <TH>Notes</TH>
              </TR>
            </THead>
            <TBody>
              {forecast.products.map((line) => {
                const profitNow =
                  line.cogs_cents === null ? null : line.current_price_cents - line.cogs_cents;
                const profitAfter =
                  line.cogs_cents === null ? null : line.target_price_cents - line.cogs_cents;
                return (
                  <TR key={line.variant_gid} className={cn(line.excluded && "opacity-70")}>
                    <TD>
                      <div className={cn("font-medium", line.excluded && "text-ink-muted")}>
                        {line.title}
                      </div>
                      {line.excluded ? (
                        <CellNote>Priceflag will not change this one</CellNote>
                      ) : null}
                    </TD>
                    <TD numeric>
                      {line.excluded ? (
                        <span className="text-ink-muted">
                          {formatMoney(line.current_price_cents, { currency })}
                        </span>
                      ) : (
                        <PriceMove
                          fromCents={line.current_price_cents}
                          toCents={line.target_price_cents}
                          currency={currency}
                        />
                      )}
                    </TD>
                    <TD numeric>
                      {line.cogs_cents === null ? (
                        <span className="text-hold">Not set</span>
                      ) : (
                        <>
                          <div>{formatMoney(line.cogs_cents, { currency })}</div>
                          <CellNote>
                            <CostSourceNote source={line.cogs_source} />
                          </CellNote>
                        </>
                      )}
                    </TD>
                    <TD numeric>
                      {profitNow === null || profitAfter === null ? (
                        <span className="text-ink-muted">Profit unknown</span>
                      ) : line.excluded ? (
                        <span className="text-ink-muted">
                          {formatMoney(profitNow, { currency })}
                        </span>
                      ) : (
                        <PriceMove
                          fromCents={profitNow}
                          toCents={profitAfter}
                          currency={currency}
                        />
                      )}
                    </TD>
                    <TD numeric className="text-ink-muted">
                      {formatUnits(line.baseline_units_per_day, 1)}
                    </TD>
                    <TD>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <ExclusionBadge reason={line.exclusion_reason} />
                        {line.compare_at_action === "clear" ? (
                          <Badge tone="hold" size="sm">
                            Crossed-out price removed
                          </Badge>
                        ) : null}
                        {line.compare_at_action === "keep" ? (
                          <Badge tone="neutral" size="sm">
                            Crossed-out price kept
                          </Badge>
                        ) : null}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardBody>
        {profitUnknown ? (
          <CardFooter>
            <span>
              Profit is left blank wherever a cost is missing. We will not invent one (R3).
            </span>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}

function RangedStat({
  label,
  low,
  high,
  expected,
  format,
  note,
  unknownNote,
  tone = "auto",
}: {
  label: string;
  low: number | null;
  high: number | null;
  expected: number | null;
  format: (value: number) => string;
  note?: string;
  unknownNote?: string;
  tone?: "auto" | "neutral";
}) {
  if (low === null || high === null || expected === null) {
    return (
      <Stat
        label={label}
        value={<span className="text-md font-medium text-ink-muted">Unknown</span>}
        note={unknownNote ?? "Some of these products have no cost saved."}
      />
    );
  }

  const lowest = Math.min(low, high);
  const highest = Math.max(low, high);

  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-ink">
        {format(expected)}
        <span className="ml-1.5 text-sm font-normal text-ink-muted">most likely</span>
      </div>
      <RangeBar
        className="mt-2"
        label={label}
        low={lowest}
        high={highest}
        expected={expected}
        format={format}
        tone={tone}
      />
      {note ? <p className="mt-1 text-sm text-ink-muted">{note}</p> : null}
    </div>
  );
}

/**
 * The engine's `explanation` opens with the breakeven sentence, which is already
 * the headline of this card. Printing it twice reads as padding, so only the part
 * that adds something is shown.
 */
function remainder(explanation: string, lead: string): string {
  const trimmed = explanation.trim();
  if (!trimmed.startsWith(lead.trim())) return trimmed;
  return trimmed.slice(lead.trim().length).trim();
}

function warningTone(code: ForecastWarningCode): "info" | "hold" | "breach" {
  switch (code) {
    case "price_below_cost":
      return "breach";
    case "missing_cogs":
    case "thin_history":
    case "no_price_variation":
    case "stale_model":
    case "wide_range":
      return "hold";
    default:
      return "info";
  }
}

function warningTitle(code: ForecastWarningCode): string {
  switch (code) {
    case "missing_cogs":
      return "Profit is unknown for some of these";
    case "price_below_cost":
      return "This would sell below cost";
    case "thin_history":
      return "Not much sales history to go on";
    case "no_price_variation":
      return "These have never sold at another price";
    case "stale_model":
      return "Our prediction is a little out of date";
    case "excluded_variants":
      return "Some products are left out";
    case "wide_range":
      return "The range is wide";
    case "compare_at_cleared":
      return "A crossed-out price will be removed";
    default:
      return "Worth knowing";
  }
}
