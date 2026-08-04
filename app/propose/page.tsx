import type { Metadata } from "next";
import { PageHeader, TextLink } from "@/components/ui";
import { ProposeFlow } from "@/components/propose/propose-flow";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";

export const metadata: Metadata = {
  title: "Propose a price change",
};

export const dynamic = "force-dynamic";

/**
 * Where a catalog selection lands: what the change would do, and when we should
 * stop. Nothing on this screen touches the storefront until the merchant presses
 * the one primary action at the end.
 *
 * The flow itself is a client component; its server actions resolve the shop
 * from the session cookie, so the page only has to decide whether there is a
 * store to propose against at all.
 */
export default async function ProposePage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink standalone href="/products">← Your products</TextLink>}
        title="Propose a price change"
        description="See what it would do to your profit before anything goes live, and set the limit that undoes it if you are wrong."
      />
      <ProposeFlow />
    </div>
  );
}
