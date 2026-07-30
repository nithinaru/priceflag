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
import { ActorBadge, PriceMove } from "@/components/domain/journal";
import {
  RolloutStatusBadge,
  VerdictBadge,
  changeSentence,
  guardrailSentence,
  rolloutStatusMeta,
} from "@/components/domain/status";
import {
  countOf,
  daysBetween,
  formatDateTime,
  formatDay,
  formatUnits,
} from "@/components/format";
import {
  DEMO_STORE,
  DEMO_TODAY,
  getJournal,
  getLiveSummary,
  getRollouts,
} from "@/components/mock/engine";

export const metadata: Metadata = {
  title: "Overview",
};

/**
 * The glance test lives on this page: what is live right now, is it behaving,
 * and how do I undo it — answered above the fold, in that order.
 */
export default function OverviewPage() {
  const summary = getLiveSummary();
  const live = summary.rollout;
  const activeStage = live?.stages[live.currentStageIndex] ?? null;
  const journal = getJournal().slice(0, 4);
  const upcoming = getRollouts().filter(
    (rollout) => rollout.status === "scheduled" || rollout.status === "draft",
  );

  const dayOfStage =
    activeStage?.startedOn ? daysBetween(activeStage.startedOn, DEMO_TODAY) + 1 : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`What Priceflag has live on ${DEMO_STORE.name} right now, and how to undo it.`}
      />

      {summary.pausedRollouts.map((rollout) => (
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
          A price in <strong className="font-medium text-ink">{rollout.name}</strong> was changed in
          Shopify, outside Priceflag. We stopped rather than guess, so nothing else will move until
          you decide.
        </Notice>
      ))}

      {live && activeStage ? (
        <Card tone={summary.health === "breach" ? "breach" : "live"} edge>
          <CardHeader
            eyebrow="Live on your storefront"
            title={live.name}
            description={rolloutStatusMeta(live.status).sentence}
            action={
              <>
                <RollbackButton
                  rolloutName={live.name}
                  productCount={summary.skusChanged}
                  variant="secondary"
                />
                <ButtonLink
                  href={`/rollouts/${live.id}`}
                  variant="primary"
                  iconRight={<IconArrowRight size={15} />}
                >
                  Open this change
                </ButtonLink>
              </>
            }
          >
            <div className="pt-1">
              <RolloutStatusBadge status={live.status} />
            </div>
          </CardHeader>

          <CardBody>
            <StatGroup columns={3}>
              <Stat
                label="Products on a new price"
                value={`${summary.skusChanged} of ${summary.skusSelected}`}
                note={`Everything selected is ${changeSentence(live.change)}.`}
                tone="live"
              />
              <Stat
                label="Step"
                value={`${live.currentStageIndex + 1} of ${live.stages.length}`}
                note={
                  dayOfStage
                    ? `Day ${formatUnits(dayOfStage)} of ${formatUnits(activeStage.holdDays)} of watching orders.`
                    : "Waiting to start."
                }
              />
              {summary.latestReading ? (
                <Stat
                  label={`Orders on ${formatDay(summary.latestReading.date)}`}
                  value={formatUnits(summary.latestReading.actualUnits)}
                  tone={summary.health === "breach" ? "breach" : "default"}
                  note={
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>
                        We expected {formatUnits(summary.latestReading.expectedLow)}–
                        {formatUnits(summary.latestReading.expectedHigh)}
                      </span>
                      <VerdictBadge verdict={summary.latestReading.verdict} />
                    </span>
                  }
                />
              ) : (
                <Stat
                  label="Orders so far"
                  value="Not yet"
                  note="We compare orders once a full day has passed."
                />
              )}
            </StatGroup>
          </CardBody>

          <CardFooter>
            <p className="max-w-prose">
              <span className="font-medium text-ink">Your safety net: </span>
              {guardrailSentence(live.guardrail)}
            </p>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={<IconFlag size={19} />}
            title="No prices are changing right now"
            description="Nothing Priceflag set is live on your storefront. When you're ready, pick the products you want to reprice and we'll show you what the change should do before anything goes out."
            action={
              <ButtonLink href="/products" variant="primary" iconRight={<IconArrowRight size={15} />}>
                Go to your products
              </ButtonLink>
            }
          />
        </Card>
      )}

      {live ? (
        <Notice
          tone={summary.health === "breach" ? "breach" : summary.health === "watch" ? "hold" : "info"}
          title={
            summary.health === "breach"
              ? "This change is about to be undone"
              : summary.health === "watch"
                ? "Worth keeping an eye on"
                : "Orders are holding up"
          }
        >
          {summary.healthSentence}{" "}
          {summary.health === "breach" ? (
            <>The automatic undo runs at the next check.</>
          ) : (
            <>
              We check every day and{" "}
              <TextLink href={`/rollouts/${live.id}`}>show you the numbers</TextLink> behind it.
            </>
          )}
        </Notice>
      ) : null}

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
                    <TD className="whitespace-nowrap text-ink-muted">{formatDateTime(entry.at)}</TD>
                    <TD className="font-medium">{entry.productTitle}</TD>
                    <TD numeric>
                      <PriceMove fromCents={entry.fromCents} toCents={entry.toCents} />
                    </TD>
                    <TD>
                      <ActorBadge actor={entry.actor} kind={entry.kind} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
          <CardFooter>
            <span>Showing the {countOf(journal.length, "most recent change")}.</span>
            <TextLink href="/journal">Open the price journal</TextLink>
          </CardFooter>
        </Card>

        <div className="min-w-0 space-y-6">
          {summary.productsMissingCost > 0 ? (
            <Card tone="hold" edge>
              <CardHeader
                eyebrow="Worth fixing"
                title={`${countOf(summary.productsMissingCost, "product")} without a cost`}
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
              description="Changes you've set up but that aren't touching your storefront."
            />
            {upcoming.length > 0 ? (
              <CardBody>
                <DetailList>
                  {upcoming.map((rollout) => (
                    <DetailRow
                      key={rollout.id}
                      label={rollout.name}
                    >
                      <span className="flex flex-wrap items-center justify-end gap-2">
                        <span className="text-base font-normal text-ink-muted">
                          {countOf(rollout.productIds.length, "product")},{" "}
                          {changeSentence(rollout.change)}
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
                description="Changes you set up but haven't started will show here."
              />
            )}
            <CardFooter>
              <span>Nothing here is live.</span>
              <TextLink href="/rollouts">See all price changes</TextLink>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
