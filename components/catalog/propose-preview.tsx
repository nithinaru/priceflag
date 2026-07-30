"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CellNote,
  EmptyState,
  Input,
  Notice,
  SkeletonCard,
  Stat,
  StatGroup,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TextLink,
} from "@/components/ui";
import { cn } from "@/components/cn";
import { IconArrowRight, IconTag } from "@/components/ui/icons";
import { readSelection } from "@/components/catalog/selection";
import {
  countOf,
  formatMoney,
  formatPercent,
  formatPercentPoints,
  formatUnits,
  marginFraction,
  parseMoneyToCents,
  type Cents,
} from "@/components/format";
import type { Product } from "@/components/mock/engine";

type ChangeKind = "percent" | "absolute";
type Direction = "up" | "down";

/**
 * Price change preview.
 *
 * This is where a catalog selection lands. It is deliberately a **calculator,
 * not a wizard**: it answers "what would this do to my margins, and how many
 * units could I afford to lose" using arithmetic that is true regardless of any
 * model, and it changes nothing. The fitted forecast, the scenario table, the
 * guardrail builder and actually starting a rollout are Sprint A3 — so this
 * screen promises none of them, and has no button that goes nowhere.
 */
export function ProposePreview({ products }: { products: Product[] }) {
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [kind, setKind] = useState<ChangeKind>("percent");
  const [direction, setDirection] = useState<Direction>("up");
  const [amount, setAmount] = useState("5");

  // sessionStorage is only readable in the browser (see catalog/selection.ts).
  useEffect(() => {
    setSelectedIds(readSelection());
  }, []);

  const selected = useMemo(() => {
    if (selectedIds === null) return [];
    const wanted = new Set(selectedIds);
    return products.filter((product) => wanted.has(product.id));
  }, [products, selectedIds]);

  const parsed = parseAmount(kind, direction, amount);
  const priced = useMemo(
    () => (parsed.value === null ? [] : selected.map((p) => priceProduct(p, kind, parsed.value!))),
    [selected, kind, parsed.value],
  );

  const withCost = priced.filter((row) => row.product.cogsCents !== null);
  const withoutCost = priced.length - withCost.length;
  const totals = useMemo(() => totalsOf(withCost), [withCost]);
  const compareAtToClear = priced.filter(
    (row) =>
      row.product.compareAtCents !== null && row.newPriceCents >= row.product.compareAtCents,
  ).length;

  if (selectedIds === null) {
    return <SkeletonCard />;
  }

  if (selected.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconTag size={19} />}
          title="Nothing is selected"
          description="Pick the products you want to reprice in your catalog and they'll show up here with the arithmetic worked out. Selections aren't kept once you close the tab."
          action={
            <ButtonLink href="/products" variant="primary" iconRight={<IconArrowRight size={15} />}>
              Go to your products
            </ButtonLink>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="The change you're thinking about"
          description="Change the numbers and everything below updates. Nothing here touches your storefront."
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <Segmented
              label="How to change it"
              value={kind}
              onChange={(next) => setKind(next as ChangeKind)}
              options={[
                { value: "percent", label: "By a percentage" },
                { value: "absolute", label: "By an amount" },
              ]}
            />
            <Segmented
              label="Which way"
              value={direction}
              onChange={(next) => setDirection(next as Direction)}
              options={[
                { value: "up", label: "Put prices up" },
                { value: "down", label: "Bring prices down" },
              ]}
            />
            <div className="w-32">
              <label htmlFor="change-amount" className="mb-1.5 block text-sm font-medium text-ink">
                {kind === "percent" ? "How much" : "How much each"}
              </label>
              <Input
                id="change-amount"
                inputMode="decimal"
                value={amount}
                invalid={parsed.error !== null}
                aria-invalid={parsed.error !== null || undefined}
                aria-describedby={parsed.error ? "change-amount-error" : undefined}
                onChange={(event) => setAmount(event.target.value)}
                prefix={kind === "absolute" ? "$" : undefined}
                suffix={kind === "percent" ? "%" : undefined}
              />
            </div>
          </div>

          {parsed.error ? (
            <p id="change-amount-error" className="text-sm text-breach">
              {parsed.error}
            </p>
          ) : (
            <p className="text-md font-medium text-ink">
              {countOf(selected.length, "product")}, each{" "}
              {kind === "percent"
                ? formatPercentPoints(Math.abs(parsed.percent ?? 0))
                : formatMoney(Math.abs(parsed.value ?? 0))}{" "}
              {direction === "up" ? (kind === "percent" ? "higher" : "more") : kind === "percent" ? "lower" : "less"}
              .
            </p>
          )}
        </CardBody>
      </Card>

      {parsed.error === null ? (
        <>
          <Card tone="accent" edge>
            <CardHeader
              eyebrow="What's certainly true"
              title="How many units you could afford to lose"
              description="This is margin arithmetic, not a prediction. It holds whatever your customers do."
            />
            <CardBody className="space-y-5">
              {totals === null ? (
                <p className="max-w-prose text-md text-ink">
                  None of the selected products has a cost, so there is no profit to compare against
                  yet. Add a cost to any of them in{" "}
                  <TextLink href="/products">your catalog</TextLink> and this fills in.
                </p>
              ) : (
                <>
                  <p className="max-w-prose text-lg font-medium text-ink">
                    {breakevenLine(totals.breakevenUnitChange)}
                  </p>
                  <StatGroup columns={3}>
                    <Stat
                      label="Profit per sale now"
                      value={formatMoney(totals.oldProfitPerUnit)}
                      note={`${formatPercent(totals.oldMargin, { digits: 0 })} of the price, across these products.`}
                    />
                    <Stat
                      label="Profit per sale after"
                      value={formatMoney(totals.newProfitPerUnit)}
                      tone={totals.newProfitPerUnit >= totals.oldProfitPerUnit ? "live" : "breach"}
                      note={`${formatPercent(totals.newMargin, { digits: 0 })} of the new price.`}
                    />
                    <Stat
                      label="Based on"
                      value={`${withCost.length} of ${priced.length}`}
                      note={
                        withoutCost === 0
                          ? "Every selected product has a cost."
                          : `${withoutCost} left out because their cost is unknown.`
                      }
                    />
                  </StatGroup>
                </>
              )}
            </CardBody>
            <CardFooter>
              <span>
                A prediction of what your customers will actually do — fitted to your store's own
                sales — comes with the forecast. This page only does arithmetic.
              </span>
            </CardFooter>
          </Card>

          {withoutCost > 0 ? (
            <Notice
              tone="hold"
              title={
                withoutCost === 1
                  ? "1 selected product has no cost"
                  : `${withoutCost} selected products have no cost`
              }
              action={
                <ButtonLink href="/products" variant="secondary" size="sm">
                  Add costs
                </ButtonLink>
              }
            >
              They're listed below with their new price, but they're left out of every profit figure
              on this page. We won't invent a profit number for a product whose cost we don't know.
            </Notice>
          ) : null}

          {compareAtToClear > 0 ? (
            <Notice
              tone="info"
              title={`${countOf(compareAtToClear, "product")} would lose its crossed-out price`}
            >
              Their new price is at or above the price currently shown crossed out, and a &ldquo;was&rdquo;
              price that isn't higher than the real price is a fake discount. Priceflag removes it
              rather than show one.
            </Notice>
          ) : null}

          <Card>
            <CardHeader
              title="Product by product"
              description="What each price becomes, and what you'd make on it."
            />
            <CardBody flush>
              <Table layout="intrinsic" caption="Each selected product with its price and profit before and after">
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH numeric>Price now</TH>
                    <TH numeric>New price</TH>
                    <TH numeric>Profit now</TH>
                    <TH numeric>New profit</TH>
                    <TH numeric>Margin</TH>
                  </TR>
                </THead>
                <TBody>
                  {priced.map((row) => {
                    const oldMargin = marginFraction(row.product.priceCents, row.product.cogsCents);
                    const newMargin = marginFraction(row.newPriceCents, row.product.cogsCents);
                    return (
                      <TR key={row.product.id}>
                        <TD>
                          <div className="font-medium">
                            {row.product.title}
                            {row.product.variantTitle ? (
                              <span className="font-normal text-ink-muted">
                                {" "}
                                · {row.product.variantTitle}
                              </span>
                            ) : null}
                          </div>
                          <CellNote>{row.product.sku}</CellNote>
                        </TD>
                        <TD numeric className="text-ink-muted">
                          {formatMoney(row.product.priceCents)}
                        </TD>
                        <TD numeric className="font-medium">
                          {formatMoney(row.newPriceCents)}
                        </TD>
                        <TD numeric className="text-ink-muted">
                          {row.product.cogsCents === null
                            ? "Unknown"
                            : formatMoney(row.product.priceCents - row.product.cogsCents)}
                        </TD>
                        <TD numeric>
                          {row.product.cogsCents === null ? (
                            <span className="text-ink-muted">Unknown</span>
                          ) : (
                            <span className="font-medium">
                              {formatMoney(row.newPriceCents - row.product.cogsCents)}
                            </span>
                          )}
                        </TD>
                        <TD numeric>
                          {oldMargin === null || newMargin === null ? (
                            <Badge tone="hold" size="sm">
                              No cost
                            </Badge>
                          ) : (
                            <span className="whitespace-nowrap">
                              <span className="text-ink-subtle">
                                {formatPercent(oldMargin, { digits: 0 })}
                              </span>
                              <span className="px-1 text-ink-subtle" aria-hidden="true">
                                →
                              </span>
                              <span className="font-medium">
                                {formatPercent(newMargin, { digits: 0 })}
                              </span>
                            </span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </CardBody>
            <CardFooter>
              <span>
                {countOf(priced.length, "product")}, {formatUnits(totalUnits(priced))} sold between
                them in the last 30 days.
              </span>
              <TextLink href="/products">Change the selection</TextLink>
            </CardFooter>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Segmented({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      <div className="inline-flex rounded-md border border-border-strong p-0.5" role="group" aria-label={label}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "h-8 rounded-[0.3rem] px-3 text-base font-medium outline-none transition-colors " +
                  "focus-visible:ring-2 focus-visible:ring-focus",
                active ? "bg-accent text-accent-ink" : "text-ink-muted hover:bg-surface-muted",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type ParsedAmount = {
  /** Percent points for `percent`, cents for `absolute`. Signed. */
  value: number | null;
  percent: number | null;
  error: string | null;
};

function parseAmount(kind: ChangeKind, direction: Direction, raw: string): ParsedAmount {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { value: null, percent: null, error: "Enter how much to change prices by." };
  }

  const sign = direction === "up" ? 1 : -1;

  if (kind === "percent") {
    const percent = Number(trimmed.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(percent) || percent <= 0) {
      return { value: null, percent: null, error: "Enter a percentage above zero, like 5." };
    }
    if (percent > 90 && direction === "down") {
      return {
        value: null,
        percent: null,
        error: "That would take prices to almost nothing. Try 90% or less.",
      };
    }
    if (percent > 500) {
      return { value: null, percent: null, error: "That's more than five times the price." };
    }
    return { value: sign * percent, percent: sign * percent, error: null };
  }

  const cents = parseMoneyToCents(trimmed);
  if (cents === null || cents <= 0) {
    return { value: null, percent: null, error: "Enter an amount above zero, like 2.50." };
  }
  return { value: sign * cents, percent: null, error: null };
}

type PricedRow = { product: Product; newPriceCents: Cents };

function priceProduct(product: Product, kind: ChangeKind, value: number): PricedRow {
  const raw =
    kind === "percent"
      ? Math.round(product.priceCents * (1 + value / 100))
      : product.priceCents + value;
  // A price of zero is not a price. Floor at a cent and let the table show it.
  return { product, newPriceCents: Math.max(1, raw) };
}

type Totals = {
  oldProfitPerUnit: Cents;
  newProfitPerUnit: Cents;
  oldMargin: number;
  newMargin: number;
  /** Fractional change in units needed to hold profit flat. Negative = can lose. */
  breakevenUnitChange: number;
};

/**
 * Weighted by units sold, so a bestseller counts for more than a long-tail SKU.
 * Only products with a known cost take part — a fabricated cost would poison
 * every number on the page (R3).
 */
function totalsOf(rows: PricedRow[]): Totals | null {
  let oldRevenue = 0;
  let newRevenue = 0;
  let oldProfit = 0;
  let newProfit = 0;
  let weight = 0;

  for (const row of rows) {
    const cogs = row.product.cogsCents;
    if (cogs === null) continue;
    const units = Math.max(1, row.product.units30d);
    weight += units;
    oldRevenue += row.product.priceCents * units;
    newRevenue += row.newPriceCents * units;
    oldProfit += (row.product.priceCents - cogs) * units;
    newProfit += (row.newPriceCents - cogs) * units;
  }

  if (weight === 0 || oldRevenue <= 0) return null;

  return {
    oldProfitPerUnit: Math.round(oldProfit / weight),
    newProfitPerUnit: Math.round(newProfit / weight),
    oldMargin: oldProfit / oldRevenue,
    newMargin: newRevenue > 0 ? newProfit / newRevenue : 0,
    // Units must scale by oldProfit/newProfit to hold total profit flat.
    breakevenUnitChange: newProfit === 0 ? Number.NaN : oldProfit / newProfit - 1,
  };
}

function breakevenLine(unitChange: number): string {
  if (!Number.isFinite(unitChange)) {
    return "At this price you'd make nothing per sale, so there is no number of units that holds your profit steady.";
  }
  if (unitChange < -0.0005) {
    return `You could sell ${formatPercent(unitChange, { digits: 1 })} fewer units and still make the same profit.`;
  }
  if (unitChange > 0.0005) {
    return `You'd need to sell ${formatPercent(unitChange, { digits: 1 })} more units to make the same profit.`;
  }
  return "Your profit per sale barely moves, so you'd need to sell about the same number of units.";
}

function totalUnits(rows: PricedRow[]): number {
  return rows.reduce((sum, row) => sum + row.product.units30d, 0);
}
