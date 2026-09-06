import type { Metadata } from "next";
import { Badge, PageHeader } from "@/components/ui";
import { CatalogTable } from "@/components/catalog/catalog-table";
import { countOf } from "@/components/format";
import {
  getDemoStore,
  getProductTypes,
  unitsInBaselineWindow,
} from "@/components/demo/store";
import { getLiveVariantGids } from "@/components/demo/rollouts";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealCatalog, type CatalogData } from "@/app/lib/store-data";

export const metadata: Metadata = {
  title: "Products",
};

export const dynamic = "force-dynamic";

/**
 * Server component: reads the catalog and hands it to the client table, which
 * owns search, filter, sort, selection and inline cost editing.
 *
 * Units sold is not a product-row field — Lane B derives it from `order_days`,
 * so it arrives as a separate map rather than being invented as a column.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  const demoMode = ctx.mode === "demo";
  const data = demoMode ? demoCatalog() : await getRealCatalog(ctx.shop!);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description={`${countOf(data.products.length, "product")}`}
        meta={
          data.liveGids.length > 0 ? (
            <Badge tone="live" size="md" dot>
              {countOf(data.liveGids.length, "product")} on a new price
            </Badge>
          ) : null
        }
      />

      <CatalogTable
        products={data.products}
        productTypes={data.productTypes}
        units={data.units}
        liveGids={data.liveGids}
        currency={data.currency}
        demoMode={demoMode}
      />
    </div>
  );
}

function demoCatalog(): CatalogData {
  const store = getDemoStore();
  return {
    products: store.products,
    productTypes: getProductTypes(),
    units: Object.fromEntries(unitsInBaselineWindow()),
    liveGids: getLiveVariantGids(),
    currency: store.shop.currency,
  };
}
