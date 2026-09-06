import type { Metadata } from "next";
import { PageHeader, TextLink } from "@/components/ui";
import { ProposeFlow } from "@/components/propose/propose-flow";
import { NotConnected } from "@/components/shell/not-connected";
import { maybeBeginShopifyInstall, resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";

export const metadata: Metadata = {
  title: "Propose a price change",
};

export const dynamic = "force-dynamic";

/**
 * Where a catalog selection lands: what the change would do, and when we should
 * stop. Nothing on this screen touches the storefront until the merchant presses
 * the one primary action at the end.
 *
 * Connected-store requests carry fresh App Bridge tokens from the client. The
 * page cookie is used only to render the right tenant's view.
 */
export default async function ProposePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  maybeBeginShopifyInstall(ctx);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink standalone href="/products">← Your products</TextLink>}
        title="Propose a price change"
      />
      <ProposeFlow demoMode={ctx.mode === "demo"} />
    </div>
  );
}
