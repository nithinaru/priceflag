import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { IconChevronRight } from "@/components/ui/icons";
import { getDemoStore } from "@/components/demo/store";
import { getLive } from "@/components/demo/rollouts";
import { healthMeta } from "@/components/domain/status";

/**
 * The answer to "what is live right now?", pinned into the nav so it is on every
 * screen. This is the product's core promise, so it is chrome, not content.
 *
 * Reads the `GET /api/live` shape (contracts/api.md) — one call that answers the
 * glance test, requested as REQ-A-003 and landing in B4.
 */
export function LiveStatus() {
  const live = getLive();
  const first = live.rollouts[0];

  if (!first || !live.anything_live) {
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

  const tone = healthMeta(first.health).tone;

  return (
    <Link
      href={`/rollouts/${first.id}`}
      className="group block rounded-lg border border-live-border bg-surface px-3 py-2.5 outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone={tone} size="sm" dot pulse={first.status === "running"}>
          Live now
        </Badge>
        <IconChevronRight size={15} className="text-ink-subtle" />
      </div>
      <p className="mt-1.5 truncate text-base font-medium text-ink">{first.name}</p>
      <p className="mt-0.5 text-xs text-ink-subtle">
        New prices on {first.variants_live} of {first.variants_total} products
        {live.rollouts.length > 1 ? ` · ${live.rollouts.length - 1} more` : ""}
      </p>
    </Link>
  );
}

/** Which store, and whether the numbers on screen are real. */
export function StoreCard() {
  const { shop } = getDemoStore();
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="truncate text-base font-medium text-ink">{shop.domain.split(".")[0]}</p>
      <p className="truncate text-xs text-ink-subtle">{shop.domain}</p>
      {shop.mode === "demo" ? (
        <Badge tone="hold" size="sm" className="mt-1.5">
          Demo data
        </Badge>
      ) : null}
    </div>
  );
}
