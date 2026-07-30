import type { Metadata } from "next";
import { PageHeader, TextLink } from "@/components/ui";
import { ProposeFlow } from "@/components/propose/propose-flow";

export const metadata: Metadata = {
  title: "Propose a price change",
};

/**
 * Where a catalog selection lands: what the change would do, and when we should
 * stop. Nothing on this screen touches the storefront until the merchant presses
 * the one primary action at the end.
 */
export default function ProposePage() {
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
