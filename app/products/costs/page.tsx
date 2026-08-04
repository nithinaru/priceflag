import type { Metadata } from "next";
import { PageHeader, TextLink } from "@/components/ui";
import { BulkCosts } from "@/components/catalog/bulk-costs";
import { getDemoStore } from "@/components/demo/store";
import { exclusionReasonFor, type Product } from "@/lib/types";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealCatalog } from "@/app/lib/store-data";

export const metadata: Metadata = {
  title: "Add costs",
};

export const dynamic = "force-dynamic";

/**
 * The focused cost-entry pass. Only repriceable products appear: adding a cost to
 * a gift card would be busywork, since Priceflag will never reprice it.
 *
 * Products missing a cost come first — that is the job — but the ones already
 * done stay listed underneath so a typo is fixable without leaving the screen.
 */
export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  let products: Product[];
  let currency: string;
  if (ctx.mode === "demo") {
    const store = getDemoStore();
    products = store.products;
    currency = store.shop.currency;
  } else {
    const data = await getRealCatalog(ctx.shop!);
    products = data.products;
    currency = data.currency;
  }

  const repriceable = products.filter((product) => exclusionReasonFor(product) === null);
  const missing = repriceable.filter((product) => product.cogs_cents === null);
  const known = repriceable.filter((product) => product.cogs_cents !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink standalone href="/products">← Your products</TextLink>}
        title="Add your costs"
        description="What you pay for each product is the one number Shopify cannot tell us unless you have filled it in. With it, every profit figure in Priceflag is real — and you do not need a single order for that to be true."
      />
      <BulkCosts products={[...missing, ...known]} currency={currency} />
    </div>
  );
}
