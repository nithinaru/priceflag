import type { Metadata } from "next";
import { Notice, PageHeader } from "@/components/ui";
import { JournalTable } from "@/components/journal/journal-table";
import { countOf } from "@/components/domain/status";
import { getJournal, getRollouts } from "@/components/demo/rollouts";

export const metadata: Metadata = {
  title: "Price journal",
};

/**
 * Shopify keeps no price audit trail; this is it. It includes changes made
 * outside Priceflag, because a change the merchant does not remember making is
 * exactly the one they will come here to find (R18).
 */
export default function JournalPage() {
  const entries = getJournal();
  const externalCount = entries.filter((entry) => entry.source === "external").length;
  const rolloutNames = Object.fromEntries(
    getRollouts().map((rollout) => [rollout.id, rollout.name]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Price journal"
        description="Every price change on your store, including ones made in Shopify without Priceflag. Nothing is ever removed from this list."
      />

      {externalCount > 0 ? (
        <Notice
          tone="info"
          title={`${countOf(externalCount, "change")} came from outside Priceflag`}
        >
          Someone edited these prices in the Shopify admin. We record them so the history stays
          complete, and we pause any price change that touches the same product rather than blame
          our own change for the difference.
        </Notice>
      ) : null}

      <JournalTable entries={entries} rolloutNames={rolloutNames} />
    </div>
  );
}
