import type { Metadata } from "next";
import { PageHeader, TextLink } from "@/components/ui";
import { ProposePreview } from "@/components/catalog/propose-preview";
import { getProducts } from "@/components/mock/engine";

export const metadata: Metadata = {
  title: "Price change preview",
};

/**
 * Where a catalog selection lands (Sprint A2). A calculator that changes
 * nothing: arithmetic that is true whatever customers do.
 *
 * Sprint A3 turns this into the full propose flow — the fitted forecast card
 * with its confidence tier and scenario table, the guardrail builder, and
 * actually creating a rollout. Until then this screen promises none of that.
 */
export default function ProposePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink href="/products">← Your products</TextLink>}
        title="Price change preview"
        description="What your margins would look like at a different price. Nothing on this page changes your storefront."
      />
      <ProposePreview products={getProducts()} />
    </div>
  );
}
