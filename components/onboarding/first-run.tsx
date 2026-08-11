import { ButtonLink, Card, CardBody, CardHeader, Notice } from "@/components/ui";
import { cn } from "@/components/cn";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import { countOf } from "@/components/format";

/**
 * First-run guidance (R24, A5).
 *
 * Written for the store Lane B actually synced, because that is what a young
 * store looks like: **17 repriceable variants, not one unit cost saved, and zero
 * orders in 180 days.** None of that is an error, and none of it should read like
 * one — but a screen full of "unknown" reads like a broken app unless it says
 * plainly what is missing, why it is missing, and which of it the merchant can
 * fix in the next two minutes.
 *
 * So the steps are ordered by *what unlocks what*, not by what is easiest:
 *
 * 1. Costs come first, because they are the one number Shopify cannot give us and
 *    they turn on every profit figure in the product **immediately** — no waiting
 *    for orders.
 * 2. Orders come second, because they are the thing the merchant cannot rush.
 *    Their absence is stated once, honestly, and framed as "not yet" rather than
 *    "cannot".
 *
 * A store with no orders can still change prices safely. That is the point worth
 * making loudest, because it is true and it is the reason to stay.
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
  const { productCount, repriceableCount, missingCostCount, daysWithSales, hasAnyRollout } =
    readiness;

  const catalogDone = productCount > 0;
  const costsDone = catalogDone && missingCostCount === 0;
  const everyCostMissing = repriceableCount > 0 && missingCostCount >= repriceableCount;
  const noSales = daysWithSales === 0;

  // Nothing to guide once the store is set up and has made a change.
  if (costsDone && hasAnyRollout && !noSales) return null;

  return (
    <Card tone="accent" edge>
      <CardHeader
        eyebrow="Getting started"
        title="Three things, and you are set up"
        description="Priceflag is useful before your store is busy — it just tells you less, and says so."
      />
      <CardBody className="space-y-5">
        <ol className="space-y-4">
          <Step
            index={1}
            done={catalogDone}
            title="Connect your store"
            body={
              catalogDone
                ? `${countOf(productCount, "product")} loaded, ${repriceableCount} of them repriceable. Gift cards and subscription products are never repriced.`
                : "We will read your products, their prices and your order history."
            }
            action={
              catalogDone ? null : (
                <ButtonLink href="/connect" variant="primary" size="sm">
                  Connect a store
                </ButtonLink>
              )
            }
          />
          <Step
            index={2}
            done={costsDone}
            title="Add what your products cost you"
            body={
              costsDone
                ? "Every product has a cost saved, so every profit figure in Priceflag is real."
                : everyCostMissing
                  ? `None of your ${repriceableCount} products has a cost saved. Shopify only knows a cost if you have filled it in, and without it we can show you revenue but never profit — so we leave profit blank rather than guess at it.`
                  : `${countOf(missingCostCount, "product")} still has no cost saved, so its profit is unknown.`
            }
            action={
              costsDone ? null : (
                <ButtonLink
                  href="/products/costs"
                  variant="primary"
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
            body={
              hasAnyRollout
                ? "You have set one up. Every change is staged a few products at a time and can be undone in one click."
                : "Pick a few products, see what the change could do, and set the limit that pauses it for review. Nothing goes live until you confirm the draft."
            }
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
          <Notice tone="info" title="No orders yet — here is what that changes, and what it does not">
            <p className="max-w-prose">
              We predict what a price change will do by learning from what your store has already
              sold. With no orders yet there is nothing to learn from, so{" "}
              <strong className="font-medium text-ink">
                we will not show you a prediction at all
              </strong>{" "}
              rather than dress up a guess as one.
            </p>
            <p className="mt-2 max-w-prose">
              You can still plan a price change today. Set a limit that pauses the rollout, move a
              few products at a time, and keep manual rollback one click away. As orders come in
              we start building the range, and we will tell you the moment it is worth reading.
            </p>
          </Notice>
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
  body: string;
  action: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
          done
            ? "border-live-border bg-live-tint text-live"
            : highlight
              ? "border-accent bg-accent text-accent-ink"
              : "border-border bg-surface-muted text-ink-muted",
        )}
        aria-hidden="true"
      >
        {done ? <IconCheck size={13} /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          <span className={cn("text-md font-medium", done ? "text-ink-muted" : "text-ink")}>
            {title}
          </span>
          {action}
        </div>
        <p className="mt-0.5 max-w-prose text-base text-ink-muted">{body}</p>
      </div>
    </li>
  );
}
