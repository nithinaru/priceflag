import type { Metadata } from "next";
import {
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  DetailList,
  DetailRow,
  EmptyState,
  Notice,
  LiveMachine,
  liveMachineModeForRollout,
  liveMachineStage,
  PageHeader,
  PageSection,
  Stat,
  StatGroup,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TextLink,
} from "@/components/ui";
import { IconArrowRight, IconFlag, IconTag } from "@/components/ui/icons";
import { RollbackButton } from "@/components/domain/rollback-button";
import { KillSwitch } from "@/components/domain/kill-switch";
import { FirstRunGuide } from "@/components/onboarding/first-run";
import { exclusionReasonFor } from "@/lib/types";
import { PriceMove, SourceBadge } from "@/components/domain/journal";
import {
  HealthBadge,
  RolloutStatusBadge,
  GuardrailSummary,
  changeWords,
  countOf,
} from "@/components/domain/status";
import { formatDateTime, formatDay, formatMoney, formatUnits } from "@/components/format";
import { readingSentence, type RolloutHealth } from "@/lib/engine/readings";
import { getDemoStore, DEMO_END_DAY } from "@/components/demo/store";
import { getJournal, getLive, getRolloutBundles, getRollouts } from "@/components/demo/rollouts";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealOverview, type OverviewData } from "@/app/lib/store-data";
import { StoreSeries } from "@/components/charts/store-series";
import {
  TRADING_WINDOW_DAYS,
  aggregateDailyTrading,
  tradingTotals,
} from "@/components/charts/aggregate-trading";
import { addDays } from "@/lib/dates";

export const metadata: Metadata = {
  title: "Overview",
};

export const dynamic = "force-dynamic";

/**
 * The glance test lives here: what is live right now, is it behaving, and how do
 * I undo it — answered above the fold, in that order (R16).
 *
 * Both modes render the same view model: demo from the simulated store, real
 * from the adapter, scoped to the authenticated shop.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  const demoMode = ctx.mode === "demo";
  const data = demoMode ? demoOverview() : await getRealOverview(ctx.shop!);
  const { live, bundles, journal, upcoming, readiness } = data;

  const running = live.rollouts.filter((rollout) => rollout.status === "running");
  const paused = live.rollouts.filter((rollout) => rollout.status === "paused");

  return (
    <div className="space-y-4">
      <PageHeader title="Overview" />

      {/* First on the page while the store is still being set up: a young store
          has nothing live, so "what is live right now" is not yet the question
          the merchant is asking (R24). */}
      <FirstRunGuide readiness={readiness} />

      {data.trading ? (
        <PageSection title="Last 30 days">
          <p className="max-w-prose text-base text-ink-muted">
            Store totals. Every visitor saw the same price on a given day.
          </p>
          <StatGroup columns={3}>
            <Stat
              label="Revenue"
              value={formatMoney(data.trading.totals.revenue_cents, {
                currency: data.currency,
                showCents: false,
              })}
            />
            <Stat
              label="Profit"
              value={
                data.trading.totals.profit_cents === null
                  ? "Unknown"
                  : formatMoney(data.trading.totals.profit_cents, {
                      currency: data.currency,
                      showCents: false,
                    })
              }
              note={
                data.trading.totals.profit_cents === null
                  ? "A selling product is missing a cost, so profit is not a number."
                  : undefined
              }
            />
            <Stat label="Units sold" value={formatUnits(data.trading.totals.units)} />
          </StatGroup>
          <StoreSeries days={data.trading.days} currency={data.currency} />
          <Table caption="Daily store totals for the last 30 days">
            <THead>
              <TR>
                <TH>Day</TH>
                <TH numeric>Units</TH>
                <TH numeric>Revenue</TH>
                <TH numeric>Profit</TH>
              </TR>
            </THead>
            <TBody>
              {data.trading.days
                .slice()
                .reverse()
                .map((day) => (
                  <TR key={day.day}>
                    <TD className="whitespace-nowrap">{formatDay(day.day)}</TD>
                    <TD numeric>{formatUnits(day.units)}</TD>
                    <TD numeric>
                      {formatMoney(day.revenue_cents, { currency: data.currency, showCents: false })}
                    </TD>
                    <TD numeric>
                      {day.profit_cents === null ? (
                        <span className="text-ink-muted">Unknown</span>
                      ) : (
                        formatMoney(day.profit_cents, { currency: data.currency, showCents: false })
                      )}
                    </TD>
                  </TR>
                ))}
            </TBody>
          </Table>
        </PageSection>
      ) : null}


      {paused.map((rollout) => {
        const reason = bundles.get(rollout.id)?.rollout.paused_reason ?? null;
        return (
          <Notice
            key={rollout.id}
            tone="hold"
            title={rollout.name || "Paused"}
            action={
              <ButtonLink href={`/rollouts/${rollout.id}`} variant="secondary" size="sm">
                Take a look
              </ButtonLink>
            }
          >
            {reason}
          </Notice>
        );
      })}

      {running.length === 0 && paused.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconFlag size={19} />}
            title="Nothing live"
            action={
              <ButtonLink href="/products" variant="neon" iconRight={<IconArrowRight size={15} />}>
                Go to your products
              </ButtonLink>
            }
          />
        </Card>
      ) : null}

      {live.rollouts.map((summary, index) => {
        const bundle = bundles.get(summary.id);
        if (!bundle) return null;
        const latest = bundle.readings.at(-1) ?? null;

        return (
          <Card
            key={summary.id}
            tone={summary.health === "breaching" ? "breach" : summary.status === "paused" ? "hold" : "live"}
            edge
            runningPulse={summary.status === "running"}
          >
            <CardHeader
              title={summary.name}
              action={
                <>
                  <RollbackButton
                    rolloutId={summary.id}
                    rolloutName={summary.name}
                    productCount={summary.variants_live}
                    variant="secondary"
                    demoMode={demoMode}
                  />
                  <ButtonLink
                    href={`/rollouts/${summary.id}`}
                    variant={index === 0 ? "neon" : "secondary"}
                    iconRight={<IconArrowRight size={15} />}
                  >
                    Open this change
                  </ButtonLink>
                </>
              }
            >
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <LiveMachine
                  mode={liveMachineModeForRollout(summary.status)}
                  stage={liveMachineStage(summary.stage_index)}
                />
                <RolloutStatusBadge status={summary.status} />
                <HealthBadge health={summary.health} size="sm" />
              </div>
            </CardHeader>

            <CardBody className="space-y-3">
              <StatGroup columns={3}>
                <Stat
                  label="Live"
                  value={`${summary.variants_live} of ${summary.variants_total}`}
                  // Green means healthy-and-live. A paused rollout is neither.
                  tone={summary.status === "running" && summary.variants_live > 0 ? "live" : "default"}
                />
                <Stat
                  label="Step"
                  value={`${Math.max(summary.stage_index + 1, 1)} of ${summary.stage_count}`}
                />
                {latest ? (
                  <Stat
                    label="Yesterday"
                    value={formatUnits(latest.actual_units)}
                    tone={summary.health === "breaching" ? "breach" : "default"}
                    note={readingSentence(latest)}
                  />
                ) : (
                  <Stat label="Yesterday" value="Not yet" />
                )}
              </StatGroup>

              <Notice
                tone={
                  summary.health === "breaching"
                    ? "breach"
                    : summary.health === "watching"
                      ? "hold"
                      : "info"
                }
                title={healthTitle(summary.health)}
              >
                {summary.health_sentence}
              </Notice>
            </CardBody>

            <CardFooter>
              <GuardrailSummary guardrails={bundle.rollout.guardrails} />
            </CardFooter>
          </Card>
        );
      })}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent price changes" />
          <CardBody flush>
            <Table caption="The four most recent price changes">
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Product</TH>
                  <TH numeric>Change</TH>
                  <TH>Who</TH>
                </TR>
              </THead>
              <TBody>
                {journal.map((entry) => (
                  <TR key={entry.id}>
                    <TD className="whitespace-nowrap text-ink-muted">
                      {formatDateTime(entry.applied_at)}
                    </TD>
                    <TD className="font-medium">{entry.title}</TD>
                    <TD numeric>
                      <PriceMove
                        fromCents={entry.before_price_cents}
                        toCents={entry.after_price_cents}
                        currency={entry.currency}
                      />
                    </TD>
                    <TD>
                      <SourceBadge source={entry.source} actor={entry.actor} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
          <CardFooter>
            <TextLink standalone href="/journal">Open the price journal</TextLink>
          </CardFooter>
        </Card>

        <div className="min-w-0 space-y-4">
          {live.products_missing_cost > 0 ? (
            <Card tone="hold" edge>
              <CardHeader
                title={`${countOf(live.products_missing_cost, "product")} without a cost`}
                action={
                  <ButtonLink href="/products" variant="secondary" size="sm">
                    Add costs
                  </ButtonLink>
                }
              />
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Not started yet" />
            {upcoming.length > 0 ? (
              <CardBody>
                <DetailList>
                  {upcoming.map((rollout) => (
                    <DetailRow key={rollout.id} label={rollout.name}>
                      <span className="flex flex-wrap items-center justify-end gap-2">
                        <span className="text-base font-normal text-ink-muted">
                          {countOf(rollout.stages.length, "step")},{" "}
                          {changeWords(rollout, data.currency)}
                        </span>
                        <RolloutStatusBadge status={rollout.status} size="sm" />
                      </span>
                    </DetailRow>
                  ))}
                </DetailList>
              </CardBody>
            ) : (
              <EmptyState icon={<IconTag size={18} />} title="Nothing waiting" />
            )}
            <CardFooter>
              <TextLink standalone href="/rollouts">See all price changes</TextLink>
            </CardFooter>
          </Card>
        </div>
      </div>

      {/* Last on the page on purpose: findable, never competing with the
          screen's primary action (R21). */}
      <KillSwitch
        affectedSkus={live.skus_holding_priceflag_price}
        killSwitchEngaged={live.kill_switch_engaged}
        demoMode={demoMode}
      />
    </div>
  );
}

/** The same view model, from the simulated store. Values match the demo exactly. */
function demoOverview(): OverviewData {
  const store = getDemoStore();
  const rollouts = getRollouts();
  const repriceable = store.products.filter((product) => exclusionReasonFor(product) === null);
  const fromDay = addDays(DEMO_END_DAY, -(TRADING_WINDOW_DAYS - 1));
  const windowed = store.orderDays.filter((row) => row.day >= fromDay && row.day <= DEMO_END_DAY);
  const tradingDays = aggregateDailyTrading(windowed, store.products);
  const totals = tradingTotals(tradingDays);

  return {
    shopDomain: store.shop.domain,
    currency: store.shop.currency,
    live: getLive(),
    bundles: new Map(getRolloutBundles().map((bundle) => [bundle.rollout.id, bundle])),
    journal: getJournal().slice(0, 4),
    upcoming: rollouts.filter(
      (rollout) => rollout.status === "scheduled" || rollout.status === "draft",
    ),
    readiness: {
      productCount: store.products.length,
      repriceableCount: repriceable.length,
      missingCostCount: repriceable.filter((product) => product.cogs_cents === null).length,
      // Days with an actual sale, not days of history: a store synced for 180 days
      // that sold nothing has no baseline, and that is the state that matters.
      daysWithSales: new Set(
        store.orderDays.filter((day) => day.units > 0).map((day) => day.day),
      ).size,
      hasAnyRollout: rollouts.length > 0,
    },
    trading: totals.units > 0 ? { days: tradingDays, totals } : null,
  };
}

function healthTitle(health: RolloutHealth): string {
  switch (health) {
    case "breaching":
      return "Breach";
    case "watching":
      return "Watching";
    case "too_early":
      return "Too early";
    case "monitoring_ended":
      return "Ended";
    case "healthy":
    case "not_live":
      return "Holding";
    default: {
      const _exhaustive: never = health;
      return _exhaustive;
    }
  }
}
