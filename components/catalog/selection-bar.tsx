"use client";

import { cn } from "@/components/cn";
import { Button } from "@/components/ui/button";
import { IconArrowRight, IconClose } from "@/components/ui/icons";
import { countOf, formatPct } from "@/components/format";
import { PresenceEnter } from "@/components/motion/anime-presence";

/**
 * The selection bar. Appears only when something is selected, states exactly
 * what is selected, and carries the one action that follows from selecting
 * things. It also warns — before the merchant gets to the next screen — when
 * some of the selection has no cost, because that is what makes a profit number
 * impossible rather than merely uncertain.
 */
export function SelectionBar({
  count,
  withoutCostCount,
  blendedMargin,
  onClear,
  onContinue,
}: {
  count: number;
  withoutCostCount: number;
  /** Percentage points, per the contracts' percent convention. */
  blendedMargin: number | null;
  onClear: () => void;
  onContinue: () => void;
}) {
  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 px-4 pb-4 lg:pl-72",
        count === 0 && "pointer-events-none",
      )}
      // The live region is always mounted, otherwise the first selection has
      // nothing to announce into. Polite, not assertive: this is an offer, not an
      // alert, and it must not interrupt someone mid-way down a list of tickboxes.
      aria-live="polite"
    >
      {count === 0 ? null : (
      <PresenceEnter show className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-5 gap-y-3 rounded-xl border border-border-strong bg-surface px-4 py-3 shadow-lg">
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink">
            {countOf(count, "product")} selected
          </p>
          {blendedMargin !== null || withoutCostCount > 0 ? (
          <p className="text-sm text-ink-muted">
            {blendedMargin !== null ? (
              <>{formatPct(blendedMargin, 0)} margin together. </>
            ) : null}
            {withoutCostCount > 0 ? (
              <span className="text-hold">
                {withoutCostCount === 1
                  ? "1 has no cost, so its profit stays unknown."
                  : `${withoutCostCount} have no cost, so their profit stays unknown.`}
              </span>
            ) : null}
          </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={onClear} iconLeft={<IconClose size={15} />}>
            Clear
          </Button>
          <Button variant="neon" onClick={onContinue} iconRight={<IconArrowRight size={15} />}>
            Preview a price change
          </Button>
        </div>
      </PresenceEnter>
      )}
    </div>
  );
}
