import type { Metadata } from "next";
import { Badge, PageHeader, TextLink } from "@/components/ui";
import { CatalogTable } from "@/components/catalog/catalog-table";
import { countOf } from "@/components/format";
import {
  getDemoStore,
  getProductTypes,
  unitsInBaselineWindow,
} from "@/components/demo/store";
import { getLiveVariantGids } from "@/components/demo/rollouts";

export const metadata: Metadata = {
  title: "Products",
};

/**
 * Server component: reads the catalog and hands it to the client table, which
 * owns search, filter, sort, selection and inline cost editing.
 *
 * Units sold is not a product-row field — Lane B derives it from `order_days`,
 * so it arrives as a separate map rather than being invented as a column.
 */
export default function ProductsPage() {
  const store = getDemoStore();
  const liveGids = getLiveVariantGids();
  const units = Object.fromEntries(unitsInBaselineWindow());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="What each product sells for, what it costs you, and what you make on it. Tick the ones you want to reprice."
        meta={
          liveGids.length > 0 ? (
            <Badge tone="live" size="md" dot>
              {countOf(liveGids.length, "product")} on a new price
            </Badge>
          ) : null
        }
      />

      <CatalogTable
        products={store.products}
        productTypes={getProductTypes()}
        units={units}
        liveGids={liveGids}
        currency={store.shop.currency}
      />

      <p className="text-base text-ink-muted">
        Want to see what is already changing?{" "}
        <TextLink href="/rollouts">Your price changes</TextLink> shows everything going out,
        waiting, and finished.
      </p>
    </div>
  );
}
