import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import { IconArrowRight, IconChevronRight, IconLayers } from "@/components/ui/icons";
import { RolloutStatusBadge, changeSentence, rolloutStatusMeta } from "@/components/domain/status";
import { countOf, formatDay, formatDayLong, formatMoneyDelta } from "@/components/format";
import { getRollouts, type Rollout } from "@/components/mock/engine";

export const metadata: Metadata = {
  title: "Price changes",
};

/**
 * Grouped by the only question that matters at a glance: is it touching my
 * storefront, is it about to, or is it over.
 */
export default function RolloutsPage() {
  const rollouts = getRollouts();
  const liveNow = rollouts.filter((rollout) => rolloutStatusMeta(rollout.status).isLive);
  const notStarted = rollouts.filter(
    (rollout) => rollout.status === "scheduled" || rollout.status === "draft",
  );
  const finished = rollouts.filter(
    (rollout) => rollout.status === "completed" || rollout.status === "rolled_back",
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Price changes"
        description="Every price change you've set up, and what happened to it."
      />

      <Section
        title="On your storefront now"
        description="These are live. Each one can be undone in a single step."
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing is live"
            description="No price change is touching your storefront right now."
            action={
              <ButtonLink href="/products" variant="secondary" iconRight={<IconArrowRight size={15} />}>
                Look at your products
              </ButtonLink>
            }
          />
        }
        rollouts={liveNow}
      />

      <Section
        title="Not started yet"
        description="Set up, but nothing has changed on your storefront."
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing waiting"
            description="Drafts and scheduled changes appear here."
          />
        }
        rollouts={notStarted}
      />

      <Section
        title="Finished"
        description="Changes that ran their course, and ones that were undone."
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing finished yet"
            description="Once a change completes or is undone, it stays here with its results."
          />
        }
        rollouts={finished}
      />
    </div>
  );
}

function Section({
  title,
  description,
  rollouts,
  empty,
}: {
  title: string;
  description: string;
  rollouts: Rollout[];
  empty: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {rollouts.length === 0 ? (
        empty
      ) : (
        <CardBody flush>
          <ul className="divide-y divide-border border-t border-border">
            {rollouts.map((rollout) => (
              <li key={rollout.id}>
                <RolloutRow rollout={rollout} />
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}

function RolloutRow({ rollout }: { rollout: Rollout }) {
  const meta = rolloutStatusMeta(rollout.status);
  const stage = rollout.stages[rollout.currentStageIndex];

  return (
    <Link
      href={`/rollouts/${rollout.id}`}
      className="flex items-start gap-4 px-4 py-4 outline-none transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus sm:px-5"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="text-md font-semibold text-ink">{rollout.name}</span>
          <RolloutStatusBadge status={rollout.status} size="sm" />
          {rollout.realizedProfitDeltaCents !== null ? (
            <Badge
              tone={rollout.realizedProfitDeltaCents >= 0 ? "live" : "breach"}
              size="sm"
            >
              {formatMoneyDelta(rollout.realizedProfitDeltaCents, { showCents: false })} profit
            </Badge>
          ) : null}
        </div>
        <p className="text-base text-ink-muted">{meta.sentence}</p>
        <p className="text-sm text-ink-subtle">
          {countOf(rollout.productIds.length, "product")}, {changeSentence(rollout.change)} ·{" "}
          {timingSentence(rollout, stage)}
        </p>
      </div>
      <IconChevronRight size={17} className="mt-1 shrink-0 text-ink-subtle" />
    </Link>
  );
}

function timingSentence(
  rollout: Rollout,
  stage: Rollout["stages"][number] | undefined,
): string {
  if (rollout.status === "scheduled" && rollout.scheduledFor) {
    return `Starts ${formatDayLong(rollout.scheduledFor)}`;
  }
  if (rollout.status === "draft") return "Not scheduled";
  if (rollout.endedAt) return `Ended ${formatDay(rollout.endedAt)}`;
  if (stage?.startedOn) {
    return `Step ${rollout.currentStageIndex + 1} of ${rollout.stages.length} since ${formatDay(
      stage.startedOn,
    )}`;
  }
  if (rollout.startedAt) return `Started ${formatDay(rollout.startedAt)}`;
  return "Not started";
}
