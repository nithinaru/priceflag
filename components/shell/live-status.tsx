import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { IconChevronRight } from "@/components/ui/icons";
import { DEMO_STORE, getLiveSummary } from "@/components/mock/engine";

/**
 * The answer to "what is live right now?", pinned into the nav so it is on
 * every screen. This is the app's core promise, so it is chrome, not content.
 */
export function LiveStatus() {
  const summary = getLiveSummary();

  if (!summary.rollout) {
    return (
      <div className="rounded-lg border border-border bg-surface-muted px-3 py-2.5">
        <div className="text-xs font-medium text-ink-muted">Right now</div>
        <p className="mt-1 text-base font-medium text-ink">No prices are changing</p>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Nothing Priceflag set is live on your storefront.
        </p>
      </div>
    );
  }

  const tone =
    summary.health === "breach" ? "breach" : summary.health === "watch" ? "hold" : "live";

  return (
    <Link
      href={`/rollouts/${summary.rollout.id}`}
      className="group block rounded-lg border border-live-border bg-surface px-3 py-2.5 outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone={tone} size="sm" dot pulse={tone === "live"}>
          Live now
        </Badge>
        <IconChevronRight size={15} className="text-ink-subtle" />
      </div>
      <p className="mt-1.5 truncate text-base font-medium text-ink">{summary.rollout.name}</p>
      <p className="mt-0.5 text-xs text-ink-subtle">
        New prices on {summary.skusChanged} of {summary.skusSelected} products
      </p>
    </Link>
  );
}

/** Which store, and whether the numbers on screen are real. */
export function StoreCard() {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="truncate text-base font-medium text-ink">{DEMO_STORE.name}</p>
      <p className="truncate text-xs text-ink-subtle">{DEMO_STORE.domain}</p>
      {DEMO_STORE.mode === "demo" ? (
        <Badge tone="hold" size="sm" className="mt-1.5">
          Demo data
        </Badge>
      ) : null}
    </div>
  );
}
