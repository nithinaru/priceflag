"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/cn";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CellNote,
  Notice,
  SearchInput,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableEmptyRow,
} from "@/components/ui";
import { IconArrowDown, IconArrowUp } from "@/components/ui/icons";
import { CostCell } from "@/components/catalog/cost-cell";
import { SelectionBar } from "@/components/catalog/selection-bar";
import { writeSelection } from "@/components/catalog/selection";
import { ExclusionBadge, exclusionWords } from "@/components/domain/status";
import { countOf, formatMoney, formatPct, formatUnits, marginPct } from "@/components/format";
import { exclusionReasonFor, type Product } from "@/lib/types";
import type { CogsSource } from "@/lib/contracts";
import type { Cents } from "@/lib/money";

type CostFilter = "all" | "set" | "missing";
type PriceFilter = "all" | "live" | "unchanged";
type SortKey = "title" | "type" | "price" | "cost" | "profit" | "units";
type SortDirection = "asc" | "desc";

type CostOverride = { cogs_cents: Cents | null; cogs_source: CogsSource };

/**
 * The catalog. Search, filter, sort, multi-select, and edit a cost in place.
 *
 * Two things it deliberately does not do. It does not paginate: a merchant
 * picking SKUs for a price change wants to sort by margin and sweep down the
 * list, and pagination breaks both that and select-all-matching. And it does not
 * hide products it cannot change — gift cards and subscription products stay
 * listed, greyed, with the reason on the row (R22), because a product that
 * silently vanishes from a catalog reads as a bug.
 */
export function CatalogTable({
  products,
  productTypes,
  units,
  liveGids,
  currency,
}: {
  products: Product[];
  productTypes: string[];
  /** Units sold in the baseline window, keyed by variant gid. Not a product field. */
  units: Record<string, number>;
  /** Variants currently holding a price Priceflag set. */
  liveGids: string[];
  currency: string;
}) {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [costFilter, setCostFilter] = useState<CostFilter>("all");
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedGids, setSelectedGids] = useState<ReadonlySet<string>>(() => new Set());
  const [costOverrides, setCostOverrides] = useState<Record<string, CostOverride>>({});

  // Keeps typing responsive on a large catalog: the field updates immediately,
  // the table catches up a frame later.
  const deferredQuery = useDeferredValue(query);
  const live = useMemo(() => new Set(liveGids), [liveGids]);

  const rows = useMemo(
    () =>
      products.map((product) => {
        const override = costOverrides[product.variant_gid];
        return override ? { ...product, ...override } : product;
      }),
    [products, costOverrides],
  );

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return rows.filter((product) => {
      if (needle) {
        const haystack = `${product.title} ${product.variant_title ?? ""} ${product.sku ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (type !== "all" && product.product_type !== type) return false;
      if (costFilter === "set" && product.cogs_cents === null) return false;
      if (costFilter === "missing" && product.cogs_cents !== null) return false;
      const isLive = live.has(product.variant_gid);
      if (priceFilter === "live" && !isLive) return false;
      if (priceFilter === "unchanged" && isLive) return false;
      return true;
    });
  }, [rows, deferredQuery, type, costFilter, priceFilter, live]);

  const sorted = useMemo(() => {
    const factor = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // Unknowns rank outside the direction flip, so "no cost yet" rows stay at
      // the bottom either way — they are the ones to act on, not to bury.
      const unknowns = unknownRank(sortKey, a, b);
      if (unknowns !== 0) return unknowns;
      return factor * compareBy(sortKey, a, b, units);
    });
  }, [filtered, sortKey, sortDirection, units]);

  const selectableFiltered = useMemo(
    () => sorted.filter((product) => exclusionReasonFor(product) === null),
    [sorted],
  );

  const selected = useMemo(
    () => rows.filter((product) => selectedGids.has(product.variant_gid)),
    [rows, selectedGids],
  );

  const withoutCostCount = selected.filter((product) => product.cogs_cents === null).length;
  const blendedMargin = blendedMarginOf(selected, units);
  const missingCostInCatalog = rows.filter(
    (product) => exclusionReasonFor(product) === null && product.cogs_cents === null,
  ).length;

  const filtersActive =
    query.trim() !== "" || type !== "all" || costFilter !== "all" || priceFilter !== "all";

  const allFilteredSelected =
    selectableFiltered.length > 0 &&
    selectableFiltered.every((product) => selectedGids.has(product.variant_gid));
  const someFilteredSelected =
    !allFilteredSelected &&
    selectableFiltered.some((product) => selectedGids.has(product.variant_gid));

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someFilteredSelected;
  }, [someFilteredSelected]);

  const toggleOne = useCallback((variantGid: string) => {
    setSelectedGids((current) => {
      const next = new Set(current);
      if (next.has(variantGid)) next.delete(variantGid);
      else next.add(variantGid);
      return next;
    });
  }, []);

  function toggleAllFiltered() {
    setSelectedGids((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        for (const product of selectableFiltered) next.delete(product.variant_gid);
      } else {
        for (const product of selectableFiltered) next.add(product.variant_gid);
      }
      return next;
    });
  }

  function sortBy(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    // Names read best A→Z; numbers read best biggest-first.
    setSortDirection(key === "title" || key === "type" ? "asc" : "desc");
  }

  function clearFilters() {
    setQuery("");
    setType("all");
    setCostFilter("all");
    setPriceFilter("all");
  }

  const onCostSaved = useCallback((variantGid: string, cogsCents: Cents | null) => {
    setCostOverrides((current) => ({
      ...current,
      [variantGid]: {
        cogs_cents: cogsCents,
        cogs_source: cogsCents === null ? "none" : "manual",
      },
    }));
  }, []);

  return (
    <>
      {missingCostInCatalog > 0 ? (
        <Notice
          tone="hold"
          title={
            missingCostInCatalog === 1
              ? "1 product has no cost yet"
              : `${missingCostInCatalog} products have no cost yet`
          }
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCostFilter("missing");
                setPriceFilter("all");
                setType("all");
                setQuery("");
              }}
            >
              Show me those
            </Button>
          }
        >
          Without a cost we can show you revenue but not profit, and a profit forecast for them
          would be a guess. You can type a cost straight into the table — click the amber{" "}
          <span className="font-medium text-ink">Add cost</span> button on any row.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Your catalog"
          description="Prices here are the prices on your storefront right now. Click any cost to change it."
        />

        <div className="flex flex-wrap items-end gap-3 px-4 pb-4 sm:px-5">
          <div className="min-w-[13rem] flex-1">
            <label htmlFor="catalog-search" className="mb-1.5 block text-sm font-medium text-ink">
              Search
            </label>
            <SearchInput
              id="catalog-search"
              placeholder="Product name or SKU"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <FilterField label="Type" id="catalog-type">
            <Select
              id="catalog-type"
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="all">All types</option>
              {productTypes.map((productType) => (
                <option key={productType} value={productType}>
                  {productType}
                </option>
              ))}
            </Select>
          </FilterField>

          <FilterField label="Cost" id="catalog-cost">
            <Select
              id="catalog-cost"
              value={costFilter}
              onChange={(event) => setCostFilter(event.target.value as CostFilter)}
            >
              <option value="all">With or without</option>
              <option value="set">Has a cost</option>
              <option value="missing">No cost yet</option>
            </Select>
          </FilterField>

          <FilterField label="Price" id="catalog-price">
            <Select
              id="catalog-price"
              value={priceFilter}
              onChange={(event) => setPriceFilter(event.target.value as PriceFilter)}
            >
              <option value="all">Any price</option>
              <option value="live">On a new price</option>
              <option value="unchanged">Unchanged</option>
            </Select>
          </FilterField>

          {filtersActive ? (
            <Button variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>

        <CardBody flush>
          <Table
            layout="intrinsic"
            caption="Your products, with price, cost, profit per sale and units sold recently"
          >
            <THead>
              <TR>
                <TH className="w-10">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    disabled={selectableFiltered.length === 0}
                    aria-label={
                      allFilteredSelected
                        ? `Unselect all ${selectableFiltered.length} matching products`
                        : `Select all ${selectableFiltered.length} matching products`
                    }
                    className="size-4 cursor-pointer rounded-sm border border-border-strong accent-accent outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </TH>
                <SortableTH label="Product" sortKey="title" activeKey={sortKey} direction={sortDirection} onSort={sortBy} />
                <SortableTH label="Type" sortKey="type" activeKey={sortKey} direction={sortDirection} onSort={sortBy} />
                <SortableTH label="Price" sortKey="price" activeKey={sortKey} direction={sortDirection} onSort={sortBy} numeric />
                <SortableTH
                  label="Cost"
                  sortKey="cost"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onSort={sortBy}
                  numeric
                  // Reserved so the column does not jump when a cost goes into
                  // edit mode and the input appears.
                  className="min-w-[8.5rem]"
                />
                <SortableTH label="Profit per sale" sortKey="profit" activeKey={sortKey} direction={sortDirection} onSort={sortBy} numeric />
                <SortableTH label="Sold recently" sortKey="units" activeKey={sortKey} direction={sortDirection} onSort={sortBy} numeric />
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {sorted.length === 0 ? (
                <TableEmptyRow colSpan={8}>
                  {filtersActive ? (
                    <>
                      <span className="block font-medium text-ink">Nothing matches that</span>
                      <span className="mt-1 block">
                        No product matches what you have searched and filtered for.
                      </span>
                      <span className="mt-3 inline-block">
                        <Button variant="secondary" size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="block font-medium text-ink">No products yet</span>
                      <span className="mt-1 block">
                        Your catalog appears here as soon as your store finishes syncing.
                      </span>
                    </>
                  )}
                </TableEmptyRow>
              ) : (
                sorted.map((product) => (
                  <CatalogRow
                    key={product.variant_gid}
                    product={product}
                    units={units[product.variant_gid] ?? 0}
                    isLive={live.has(product.variant_gid)}
                    currency={currency}
                    selected={selectedGids.has(product.variant_gid)}
                    onToggle={toggleOne}
                    onCostSaved={onCostSaved}
                  />
                ))
              )}
            </TBody>
          </Table>
        </CardBody>

        <CardFooter>
          <span>
            {filtersActive
              ? `Showing ${formatUnits(sorted.length)} of ${countOf(rows.length, "product")}.`
              : `${countOf(rows.length, "product")}.`}
            {missingCostInCatalog > 0 ? ` ${missingCostInCatalog} without a cost.` : ""}
          </span>
          <span>Gift cards and subscription products cannot be repriced.</span>
        </CardFooter>
      </Card>

      {/* Keeps the last row clear of the floating bar. */}
      {selected.length > 0 ? <div className="h-20" aria-hidden="true" /> : null}

      <SelectionBar
        count={selected.length}
        withoutCostCount={withoutCostCount}
        blendedMargin={blendedMargin}
        onClear={() => setSelectedGids(new Set())}
        onContinue={() => {
          writeSelection(selected.map((product) => product.variant_gid));
          router.push("/propose");
        }}
      />
    </>
  );
}

function FilterField({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-[9.5rem]">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
    </div>
  );
}

function SortableTH({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  numeric = false,
  className,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  className?: string;
}) {
  const active = activeKey === sortKey;
  return (
    <TH
      numeric={numeric}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("p-0", className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "flex w-full items-center gap-1 px-3 py-2 text-xs font-semibold outline-none " +
            "hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 " +
            "focus-visible:outline-focus",
          numeric && "justify-end",
          active ? "text-ink" : "text-ink-muted",
        )}
      >
        <span>{label}</span>
        <span className={cn("shrink-0", active ? "opacity-100" : "opacity-0")} aria-hidden="true">
          {direction === "asc" ? <IconArrowUp size={13} /> : <IconArrowDown size={13} />}
        </span>
      </button>
    </TH>
  );
}

function CatalogRow({
  product,
  units,
  isLive,
  currency,
  selected,
  onToggle,
  onCostSaved,
}: {
  product: Product;
  units: number;
  isLive: boolean;
  currency: string;
  selected: boolean;
  onToggle: (variantGid: string) => void;
  onCostSaved: (variantGid: string, cogsCents: Cents | null) => void;
}) {
  const exclusion = exclusionReasonFor(product);
  const selectable = exclusion === null;
  const profit = product.cogs_cents === null ? null : product.price_cents - product.cogs_cents;
  const margin = marginPct(product.price_cents, product.cogs_cents);

  return (
    <TR interactive={selectable} className={cn(selected && "bg-accent-tint/50")}>
      <TD>
        <input
          type="checkbox"
          checked={selected}
          disabled={!selectable}
          onChange={() => onToggle(product.variant_gid)}
          aria-label={
            selectable
              ? `Select ${product.title}`
              : `${product.title} cannot be repriced — ${exclusionWords(exclusion)}`
          }
          className="size-4 cursor-pointer rounded-sm border border-border-strong accent-accent outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
        />
      </TD>

      <TD>
        <div className={cn("font-medium", !selectable && "text-ink-muted")}>
          {product.title}
          {product.variant_title ? (
            <span className="font-normal text-ink-muted"> · {product.variant_title}</span>
          ) : null}
        </div>
        <CellNote>{product.sku ?? "No SKU"}</CellNote>
      </TD>

      <TD className="text-ink-muted">{product.product_type ?? "—"}</TD>

      <TD numeric>
        <div className="font-medium">{formatMoney(product.price_cents, { currency })}</div>
        {product.compare_at_cents !== null ? (
          <CellNote>
            <span className="line-through">
              {formatMoney(product.compare_at_cents, { currency })}
            </span>{" "}
            crossed out
          </CellNote>
        ) : null}
      </TD>

      <TD numeric>
        {selectable ? (
          <CostCell
            variantGid={product.variant_gid}
            productTitle={product.title}
            priceCents={product.price_cents}
            cogsCents={product.cogs_cents}
            cogsSource={product.cogs_source}
            currency={currency}
            onSaved={(cogsCents) => onCostSaved(product.variant_gid, cogsCents)}
          />
        ) : product.cogs_cents === null ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <span className="text-ink-muted">{formatMoney(product.cogs_cents, { currency })}</span>
        )}
      </TD>

      <TD numeric>
        {profit === null ? (
          <span className="text-ink-muted">Profit unknown</span>
        ) : (
          <>
            <div className="font-medium">{formatMoney(profit, { currency })}</div>
            <CellNote>{formatPct(margin, 0)} of the price</CellNote>
          </>
        )}
      </TD>

      <TD numeric className="text-ink-muted">
        {formatUnits(units)}
      </TD>

      <TD>
        {!selectable ? (
          <ExclusionBadge reason={exclusion} />
        ) : isLive ? (
          <Badge tone="live" size="sm" dot>
            New price
          </Badge>
        ) : (
          <span className="text-sm text-ink-subtle">Unchanged</span>
        )}
      </TD>
    </TR>
  );
}

function compareBy(
  key: SortKey,
  a: Product,
  b: Product,
  units: Record<string, number>,
): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title) || (a.sku ?? "").localeCompare(b.sku ?? "");
    case "type":
      return (a.product_type ?? "").localeCompare(b.product_type ?? "") || a.title.localeCompare(b.title);
    case "price":
      return a.price_cents - b.price_cents;
    case "cost":
      return (a.cogs_cents ?? 0) - (b.cogs_cents ?? 0);
    case "profit":
      return (
        (a.cogs_cents === null ? 0 : a.price_cents - a.cogs_cents) -
        (b.cogs_cents === null ? 0 : b.price_cents - b.cogs_cents)
      );
    case "units":
      return (units[a.variant_gid] ?? 0) - (units[b.variant_gid] ?? 0);
    default:
      return 0;
  }
}

/** +1 / −1 when exactly one of the pair has no value for this column. */
function unknownRank(key: SortKey, a: Product, b: Product): number {
  if (key !== "cost" && key !== "profit") return 0;
  const aUnknown = a.cogs_cents === null;
  const bUnknown = b.cogs_cents === null;
  if (aUnknown === bUnknown) return 0;
  return aUnknown ? 1 : -1;
}

/** Margin across a set: total profit over total revenue, weighted by units. */
function blendedMarginOf(
  products: readonly Product[],
  units: Record<string, number>,
): number | null {
  let revenue = 0;
  let profit = 0;
  for (const product of products) {
    if (product.cogs_cents === null) continue;
    const weight = Math.max(1, units[product.variant_gid] ?? 0);
    revenue += product.price_cents * weight;
    profit += (product.price_cents - product.cogs_cents) * weight;
  }
  if (revenue <= 0) return null;
  return (profit / revenue) * 100;
}
