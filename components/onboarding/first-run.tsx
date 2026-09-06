import type { ReactNode } from "react";
import { ButtonLink, Card, CardBody, CardHeader } from "@/components/ui";
import { cn } from "@/components/cn";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import { countOf } from "@/components/format";
import { LiquidMorph } from "@/components/motion/liquid-morph";

/**
 * First-run guidance (R24, A5).
 *
 * Written for the store Lane B actually synced, because that is what a young
 * store looks like: **17 repriceable variants, not one unit cost saved, and zero
 * orders in 180 days.** None of that is an error, and none of it should read like
 * one.
 *
 * Steps are ordered by *what unlocks what*:
 * 1. Costs — Shopify cannot give us these; they turn on profit immediately.
 * 2. Orders — the merchant cannot rush these; stated once as "not yet".
 */

export type StoreReadiness = {
  productCount: number;
  repriceableCount: number;
  missingCostCount: number;
  /** Days of order history with at least one unit sold. */
  daysWithSales: number;
  hasAnyRollout: boolean;
};

export function FirstRunGuide({ readiness }: { readiness: StoreReadiness }) {
  const { productCount, missingCostCount, daysWithSales, hasAnyRollout } =
    readiness;

  const catalogDone = productCount > 0;
  const costsDone = catalogDone && missingCostCount === 0;
  const noSales = daysWithSales === 0;

  // Nothing to guide once the store is set up and has made a change.
  if (costsDone && hasAnyRollout && !noSales) return null;

  const remaining = [!catalogDone, !costsDone, !hasAnyRollout].filter(Boolean).length;

  return (
    <Card tone="accent" edge>
      <CardHeader title={remaining > 0 ? `Get set up · ${remaining}` : "Get set up"} />
      <CardBody className="space-y-3">
        <ol className="space-y-2.5">
          <Step
            index={1}
            done={catalogDone}
            title={catalogDone ? "Your store is connected" : "Connect your store"}
            body={catalogDone ? countOf(productCount, "product") : undefined}
            action={
              catalogDone ? null : (
                <ButtonLink href="/connect" variant="neon" size="sm">
                  Connect a store
                </ButtonLink>
              )
            }
          />
          <Step
            index={2}
            done={costsDone}
            title="Add what your products cost you"
            body={costsDone ? undefined : countOf(missingCostCount, "product")}
            action={
              costsDone ? null : (
                <ButtonLink
                  href="/products/costs"
                  variant={!costsDone && catalogDone ? "neon" : "secondary"}
                  size="sm"
                  iconRight={<IconArrowRight size={15} />}
                >
                  Add costs
                </ButtonLink>
              )
            }
            highlight={!costsDone && catalogDone}
          />
          <Step
            index={3}
            done={hasAnyRollout}
            title="Make your first price change"
            action={
              hasAnyRollout ? null : (
                <ButtonLink href="/products" variant="secondary" size="sm">
                  Choose products
                </ButtonLink>
              )
            }
          />
        </ol>

        {noSales && catalogDone ? (
          <p className="text-sm text-ink-muted">No orders yet — no forecast until there are.</p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Step({
  index,
  done,
  title,
  body,
  action,
  highlight = false,
}: {
  index: number;
  done: boolean;
  title: string;
  body?: string;
  action: ReactNode;
  highlight?: boolean;
}) {
  return (
    <li className="flex gap-3">
      <LiquidMorph
        transition={done ? "snappy" : highlight ? "bouncy" : "smooth"}
        fill={
          done
            ? "var(--pf-live-tint)"
            : highlight
              ? "var(--pf-accent)"
              : "var(--pf-surface-muted)"
        }
        className="mt-0.5 size-6 shrink-0"
      >
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-full border bg-transparent text-xs font-semibold",
            done
              ? "border-live-border text-live"
              : highlight
                ? "border-accent text-accent-ink"
                : "border-border text-ink-muted",
          )}
          aria-hidden="true"
        >
          {done ? <IconCheck size={13} /> : index}
        </span>
      </LiquidMorph>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          <span className={cn("text-md font-medium", done ? "text-ink-muted" : "text-ink")}>
            {title}
          </span>
          {action}
        </div>
        {body ? <p className="mt-0.5 text-base text-ink-muted">{body}</p> : null}
      </div>
    </li>
  );
}
