import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FounderLab } from "@/components/demo/founder-lab";
import { Badge, PageHeader } from "@/components/ui";
import { isDemoMode } from "@/lib/config";
import { DEFAULT_FOUNDER_LAB_INPUT, runFounderLab } from "@/lib/demo/founder-lab";

export const metadata: Metadata = {
  title: "Founder Lab",
};

export const dynamic = "force-dynamic";

export default function ModelLabPage() {
  if (!isDemoMode()) notFound();

  const initialInput = { ...DEFAULT_FOUNDER_LAB_INPUT };
  const initialResult = runFounderLab(initialInput);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Founder Lab"
        meta={<Badge tone="live" dot>No Shopify writes</Badge>}
      />
      <FounderLab initialInput={initialInput} initialResult={initialResult} />
    </div>
  );
}
