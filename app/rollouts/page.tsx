import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LiveMachine,
  liveMachineModeForRollout,
  liveMachineStage,
  PageHeader,
} from "@/components/ui";
import { IconArrowRight, IconChevronRight, IconLayers } from "@/components/ui/icons";
import {
  HealthBadge,
  RolloutStatusBadge,
  changeWords,
  countOf,
} from "@/components/domain/status";
import { formatDay } from "@/components/format";
import { getDemoStore } from "@/components/demo/store";
import { getRolloutBundles, type RolloutBundle } from "@/components/demo/rollouts";
import { NotConnected } from "@/components/shell/not-connected";
import { maybeBeginShopifyInstall, resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealRolloutBundles } from "@/app/lib/store-data";
import type { RolloutStatus } from "@/lib/types";

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
  maybeBeginShopifyInstall(ctx);
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
      <PageHeader title="Price changes" />

      <Section
        title="Live"
        bundles={liveNow}
        currency={currency}
        empty={
          <EmptyState
            icon={<IconLayers size={19} />}
            title="Nothing live"
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
        title="Waiting"
        bundles={notStarted}
        currency={currency}
        empty={
          <EmptyState icon={<IconLayers size={19} />} title="Nothing waiting" />
        }
      />

      <Section
        title="Finished"
        bundles={finished}
        currency={currency}
        empty={
          <EmptyState icon={<IconLayers size={19} />} title="Nothing finished" />
        }
      />
    </div>
  );
}

function Section({
  title,
  bundles,
  currency,
  empty,
}: {
  title: string;
  bundles: RolloutBundle[];
  currency: string;
  empty: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} />
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

function showLiveMachine(status: RolloutStatus): boolean {
  switch (status) {
    case "running":
    case "paused":
    case "rolled_back":
      return true;
    case "draft":
    case "scheduled":
    case "completed":
    case "cancelled":
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function RolloutRow({ bundle, currency }: { bundle: RolloutBundle; currency: string }) {
  const { rollout } = bundle;
  const showHealth = rollout.status === "running" || rollout.status === "paused";

  return (
    <Link
      href={`/rollouts/${rollout.id}`}
      className="flex items-center gap-4 px-4 py-4 outline-none transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus sm:px-5"
    >
      {showLiveMachine(rollout.status) ? (
        <LiveMachine
          className="shrink-0"
          mode={liveMachineModeForRollout(rollout.status)}
          stage={liveMachineStage(rollout.current_stage)}
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="text-md font-semibold text-ink">{rollout.name}</span>
          <RolloutStatusBadge status={rollout.status} size="sm" />
          {showHealth ? <HealthBadge health={bundle.health} size="sm" /> : null}
        </div>
        {rollout.status === "paused" && rollout.paused_reason ? (
          <p className="text-base text-ink-muted">{rollout.paused_reason}</p>
        ) : null}
        <p className="text-sm text-ink-subtle">
          {countOf(bundle.live.variants_total, "product")} · {changeWords(rollout, currency)} ·{" "}
          {timingFragment(bundle)}
        </p>
      </div>
      <IconChevronRight size={17} className="mt-1 shrink-0 text-ink-subtle" />
    </Link>
  );
}

function timingFragment(bundle: RolloutBundle): string {
  const { rollout } = bundle;
  switch (rollout.status) {
    case "scheduled":
      return rollout.scheduled_start_at ? formatDay(rollout.scheduled_start_at) : "—";
    case "draft":
      return "—";
    case "running":
    case "paused":
      if (rollout.stage_entered_at) {
        return `${rollout.current_stage + 1}/${rollout.stages.length} · ${formatDay(rollout.stage_entered_at)}`;
      }
      return rollout.started_at ? formatDay(rollout.started_at) : "—";
    case "completed":
    case "rolled_back":
    case "cancelled":
      return rollout.ended_at ? formatDay(rollout.ended_at) : "—";
    default: {
      const _exhaustive: never = rollout.status;
      return _exhaustive;
    }
  }
}
