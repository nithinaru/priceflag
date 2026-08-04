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
  PageHeader,
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
  rolloutStatusMeta,
} from "@/components/domain/status";
import { formatDateTime, formatDay, formatUnits } from "@/components/format";
import { readingSentence } from "@/lib/engine/readings";
import { getDemoStore } from "@/components/demo/store";
import { getJournal, getLive, getRolloutBundles, getRollouts } from "@/components/demo/rollouts";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealOverview, type OverviewData } from "@/app/lib/store-data";

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
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`What Priceflag has live on ${data.shopDomain} right now, and how to undo it.`}
      />

      {/* First on the page while the store is still being set up: a young store
          has nothing live, so "what is live right now" is not yet the question
          the merchant is asking (R24). */}
      <FirstRunGuide readiness={readiness} />

      {paused.map((rollout) => {
        // The demo's one paused rollout is an external change; a real pause
        // carries its own recorded reason, and that is the honest thing to show.
        const reason = demoMode ? null : (bundles.get(rollout.id)?.rollout.paused_reason ?? null);
        return (
          <Notice
            key={rollout.id}
            tone="hold"
            title="One price change is paused and needs you"
            action={
              <ButtonLink href={`/rollouts/${rollout.id}`} variant="secondary" size="sm">
                Take a look
              </ButtonLink>
            }
          >
            {reason ?? (
              <>
                A price in <strong className="font-medium text-ink">{rollout.name}</strong> was
                changed in Shopify, outside Priceflag. We stopped rather than guess, so nothing else
                will move until you decide.
              </>
            )}
          </Notice>
        );
      })}

      {running.length === 0 && paused.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconFlag size={19} />}
            title="No prices are changing right now"
            description="Nothing Priceflag set is live on your storefront. When you are ready, pick the products you want to reprice and we will show you what the change should do before anything goes out."
            action={
              <ButtonLink href="/products" variant="primary" iconRight={<IconArrowRight size={15} />}>
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
          >
            <CardHeader
              eyebrow={index === 0 ? "Live on your storefront" : "Also on your storefront"}
              title={summary.name}
              description={rolloutStatusMeta(summary.status).sentence}
              action={
                <>
                  <RollbackButton
                    rolloutId={summary.id}
                    rolloutName={summary.name}
                    productCount={summary.variants_live}
                    variant="secondary"
                    demoMode={demoMode}
                  />
                  {/* One primary action per screen: only the first card gets it. */}
                  <ButtonLink
                    href={`/rollouts/${summary.id}`}
                    variant={index === 0 ? "primary" : "secondary"}
                    iconRight={<IconArrowRight size={15} />}
                  >
                    Open this change
                  </ButtonLink>
                </>
              }
            >
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <RolloutStatusBadge status={summary.status} />
                <HealthBadge health={summary.health} size="sm" />
              </div>
            </CardHeader>

            <CardBody className="space-y-4">
              <StatGroup columns={3}>
                <Stat
                  label="Products on a new price"
                  value={`${summary.variants_live} of ${summary.variants_total}`}
                  // Green means healthy-and-live. A paused rollout is neither.
                  tone={summary.status === "running" && summary.variants_live > 0 ? "live" : "default"}
                  note={`Everything selected is being set ${changeWords(bundle.rollout, data.currency)}.`}
                />
                <Stat
                  label="Step"
                  value={`${Math.max(summary.stage_index + 1, 1)} of ${summary.stage_count}`}
                  note={
                    summary.status !== "running"
                      ? "Nothing is scheduled while this is paused."
                      : summary.next_decision_day
                        ? `We look at the numbers again on ${formatDay(summary.next_decision_day)}.`
                        : "Waiting for a full day of orders."
                  }
                />
                {latest ? (
                  <Stat
                    label="Yesterday"
                    value={formatUnits(latest.actual_units)}
                    tone={summary.health === "breaching" ? "breach" : "default"}
                    note={readingSentence(latest)}
                  />
                ) : (
                  <Stat
                    label="Orders so far"
                    value="Not yet"
                    note="We compare orders once a full day has passed."
                  />
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Recent price changes"
            description="Every change to a price, whoever made it."
          />
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
            <span>Showing the {countOf(journal.length, "most recent change")}.</span>
            <TextLink standalone href="/journal">Open the price journal</TextLink>
          </CardFooter>
        </Card>

        <div className="min-w-0 space-y-6">
          {live.products_missing_cost > 0 ? (
            <Card tone="hold" edge>
              <CardHeader
                eyebrow="Worth fixing"
                title={`${countOf(live.products_missing_cost, "product")} without a cost`}
                description="We can show you revenue for these, but not profit — so a forecast for them would be a guess. Add what each one costs you and the profit numbers appear."
                action={
                  <ButtonLink href="/products" variant="secondary" size="sm">
                    Add costs
                  </ButtonLink>
                }
              />
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Not started yet"
              description="Changes you have set up that are not touching your storefront."
            />
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
              <EmptyState
                icon={<IconTag size={18} />}
                title="Nothing waiting"
                description="Changes you set up but have not started will show here."
              />
            )}
            <CardFooter>
              <span>Nothing here is live.</span>
              <TextLink standalone href="/rollouts">See all price changes</TextLink>
            </CardFooter>
          </Card>
        </div>
      </div>

      {/* Last on the page on purpose: findable, never competing with the
          screen's primary action (R21). */}
      <KillSwitch affectedSkus={live.skus_holding_priceflag_price} demoMode={demoMode} />
    </div>
  );
}

/** The same view model, from the simulated store. Values match the demo exactly. */
function demoOverview(): OverviewData {
  const store = getDemoStore();
  const rollouts = getRollouts();
  const repriceable = store.products.filter((product) => exclusionReasonFor(product) === null);

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
  };
}

function healthTitle(health: string): string {
  switch (health) {
    case "breaching":
      return "This change is about to be undone";
    case "watching":
      return "Worth keeping an eye on";
    case "too_early":
      return "Nothing to compare yet";
    default:
      return "Orders are holding up";
  }
}
