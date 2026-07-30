import type { Metadata } from "next";
import { Badge, PageHeader, TextLink } from "@/components/ui";
import { CatalogTable } from "@/components/catalog/catalog-table";
import { countOf } from "@/components/format";
import { getProductTypes, getProducts } from "@/components/mock/engine";

export const metadata: Metadata = {
  title: "Products",
};

/**
 * Server component: reads the catalog and hands it to the client table, which
 * owns search, filter, sort, selection and inline cost editing.
 */
export default function ProductsPage() {
  const products = getProducts();
  const productTypes = getProductTypes();
  const liveCount = products.filter((product) => product.inLiveRollout).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="What each product sells for, what it costs you, and what you make on it. Tick the ones you want to reprice."
        meta={
          liveCount > 0 ? (
            <Badge tone="live" size="md" dot>
              {countOf(liveCount, "product")} on a new price
            </Badge>
          ) : null
        }
      />

      <CatalogTable products={products} productTypes={productTypes} />

      <p className="text-base text-ink-muted">
        Want to see what's already changing? <TextLink href="/rollouts">Your price changes</TextLink>{" "}
        shows everything going out, waiting, and finished.
      </p>
    </div>
  );
}
