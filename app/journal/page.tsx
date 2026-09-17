import type { Metadata } from "next";
import { Badge, PageHeader } from "@/components/ui";
import { JournalTable } from "@/components/journal/journal-table";
import { countOf } from "@/components/domain/status";
import { getJournal, getRollouts } from "@/components/demo/rollouts";
import { NotConnected } from "@/components/shell/not-connected";
import { maybeBeginShopifyInstall, resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealJournal, getRealRolloutNames } from "@/app/lib/store-data";
import type { JournalEntry } from "@/lib/types";

export const metadata: Metadata = {
  title: "Journal",
};

export const dynamic = "force-dynamic";

/**
 * Shopify keeps no price audit trail; this is it. It includes changes made
 * outside Priceflag, because a change the merchant does not remember making is
 * exactly the one they will come here to find (R18).
 */
export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  maybeBeginShopifyInstall(ctx);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  let entries: JournalEntry[];
  let rolloutNames: Record<string, string>;
  if (ctx.mode === "demo") {
    entries = getJournal();
    rolloutNames = Object.fromEntries(getRollouts().map((rollout) => [rollout.id, rollout.name]));
  } else {
    [entries, rolloutNames] = await Promise.all([
      getRealJournal(ctx.shop!),
      getRealRolloutNames(ctx.shop!),
    ]);
  }

  const externalCount = entries.filter((entry) => entry.source === "external").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal"
        meta={
          externalCount > 0 ? (
            <Badge tone="hold" size="sm">
              {countOf(externalCount, "change")} from Shopify
            </Badge>
          ) : null
        }
      />

      <JournalTable entries={entries} rolloutNames={rolloutNames} />
    </div>
  );
}
