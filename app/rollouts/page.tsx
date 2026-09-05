import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import { IconArrowRight, IconChevronRight, IconLayers } from "@/components/ui/icons";
import {
  HealthBadge,
  RolloutStatusBadge,
  changeWords,
  countOf,
  rolloutStatusMeta,
} from "@/components/domain/status";
import { formatDay, formatDayLong } from "@/components/format";
import { getDemoStore } from "@/components/demo/store";
import { getRolloutBundles, type RolloutBundle } from "@/components/demo/rollouts";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealRolloutBundles } from "@/app/lib/store-data";

export const metadata: Metadata = {
  title: "Price changes",
};

export const dynamic = "force-dynamic";

/**
 * Grouped by the only question that matters at a glance: is it touching my
 * storefront, is it about to, or is it over.
 */
export default async function RolloutsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  const bundles =
    ctx.mode === "demo" ? getRolloutBundles() : await getRealRolloutBundles(ctx.shop!);
  const currency = ctx.mode === "demo" ? getDemoStore().shop.currency : ctx.shop!.currency;

  const liveNow = bundles.filter(
    (bundle) => bundle.rollout.status !== "cancelled" && bundle.live.variants_live > 0,
  );
  const notStarted = bundles.filter(
    (bundle) => bundle.rollout.status === "scheduled" || bundle.rollout.status === "draft",
  );
  const finished = bundles.filter(
    (bundle) =>
      ["completed", "rolled_back", "cancelled"].includes(bundle.rollout.status) &&
      bundle.live.variants_live === 0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Price changes"
      />

      <Section
        title="On your storefront now"
        description="These are live. Each one can be undone in a single step."
        bundles={liveNow}
        currency={currency}
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing is live"
            description="No price change is touching your storefront right now."
            action={
              <ButtonLink
                href="/products"
                variant="secondary"
                iconRight={<IconArrowRight size={15} />}
              >
                Look at your products
              </ButtonLink>
            }
          />
        }
      />

      <Section
        title="Not started yet"
        description="Set up, but nothing has changed on your storefront."
        bundles={notStarted}
        currency={currency}
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing waiting"
            description="Drafts and scheduled changes appear here."
          />
        }
      />

      <Section
        title="Finished"
        description="Changes that ran their course, and ones that were undone."
        bundles={finished}
        currency={currency}
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing finished yet"
            description="Once a change completes or is undone, it stays here with its results."
          />
        }
      />
    </div>
  );
}

function Section({
  title,
  description,
  bundles,
  currency,
  empty,
}: {
  title: string;
  description: string;
  bundles: RolloutBundle[];
  currency: string;
  empty: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {bundles.length === 0 ? (
        empty
      ) : (
        <CardBody flush>
          <ul className="divide-y divide-border border-t border-border">
            {bundles.map((bundle) => (
              <li key={bundle.rollout.id}>
                <RolloutRow bundle={bundle} currency={currency} />
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}

function RolloutRow({ bundle, currency }: { bundle: RolloutBundle; currency: string }) {
  const { rollout } = bundle;
  const meta = rolloutStatusMeta(rollout.status);
  const showHealth = rollout.status === "running" || rollout.status === "paused";

  return (
    <Link
      href={`/rollouts/${rollout.id}`}
      className="flex items-start gap-4 px-4 py-4 outline-none transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus sm:px-5"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="text-md font-semibold text-ink">{rollout.name}</span>
          <RolloutStatusBadge status={rollout.status} size="sm" />
          {showHealth ? <HealthBadge health={bundle.health} size="sm" /> : null}
        </div>
        <p className="text-base text-ink-muted">
          {rollout.status === "paused" && rollout.paused_reason
            ? rollout.paused_reason
            : meta.sentence}
        </p>
        <p className="text-sm text-ink-subtle">
          {countOf(bundle.live.variants_total, "product")}, {changeWords(rollout, currency)} ·{" "}
          {timingSentence(bundle)}
        </p>
      </div>
      <IconChevronRight size={17} className="mt-1 shrink-0 text-ink-subtle" />
    </Link>
  );
}

function timingSentence(bundle: RolloutBundle): string {
  const { rollout } = bundle;
  if (rollout.status === "scheduled" && rollout.scheduled_start_at) {
    return `Starts ${formatDayLong(rollout.scheduled_start_at)}`;
  }
  if (rollout.status === "draft") return "Not scheduled";
  if (rollout.ended_at) return `Ended ${formatDay(rollout.ended_at)}`;
  if (rollout.stage_entered_at) {
    return `Step ${rollout.current_stage + 1} of ${rollout.stages.length} since ${formatDay(
      rollout.stage_entered_at,
    )}`;
  }
  if (rollout.started_at) return `Started ${formatDay(rollout.started_at)}`;
  return "Not started";
}
