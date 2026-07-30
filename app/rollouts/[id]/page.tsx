import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Badge,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CellNote,
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
  TableEmptyRow,
  TextLink,
} from "@/components/ui";
import { IconClock, IconInbox } from "@/components/ui/icons";
import { RollbackButton } from "@/components/domain/rollback-button";
import { StageTimeline } from "@/components/domain/stage-timeline";
import {
  ExpectedRangeLegend,
  ExpectedRangeMark,
  readingsDomainMax,
} from "@/components/domain/expected-range";
import { ActorBadge, PriceMove } from "@/components/domain/journal";
import {
  ConfidenceNote,
  RolloutStatusBadge,
  VerdictBadge,
  breakevenSentence,
  changeSentence,
  guardrailSentence,
  rolloutCardTone,
  rolloutStatusMeta,
} from "@/components/domain/status";
import {
  countOf,
  daysBetween,
  formatDateTime,
  formatDay,
  formatMoney,
  formatMoneyDelta,
  formatPercentDelta,
  formatUnits,
} from "@/components/format";
import {
  DEMO_TODAY,
  getJournalForRollout,
  getRollout,
  getRolloutProducts,
  getRollouts,
  priceAfterChange,
  type Rollout,
} from "@/components/mock/engine";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const rollout = getRollout(id);
  return { title: rollout ? rollout.name : "Price change not found" };
}

export function generateStaticParams() {
  return getRollouts().map((rollout) => ({ id: rollout.id }));
}

/**
 * The monitoring screen at v0 depth. It has to answer three things without
 * scrolling: what is live, is it behaving, how do I undo it. The undo is the
 * page's single primary action whenever a Priceflag price is on the storefront.
 *
 * A4 deepens this: the actual-vs-expected chart with its band, richer breach
 * states, and the store-level kill switch.
 */
export default async function RolloutPage({ params }: PageProps) {
  const { id } = await params;
  const rollout = getRollout(id);
  if (!rollout) notFound();

  const meta = rolloutStatusMeta(rollout.status);
  const products = getRolloutProducts(rollout);
  const stage = rollout.stages[rollout.currentStageIndex];
  const changedCount = products.filter((product) => product.inLiveRollout).length;
  const journal = getJournalForRollout(rollout.id);
  const domainMax = readingsDomainMax(rollout.readings);
  const belowDays = rollout.readings.filter((reading) => reading.verdict === "below").length;
  const dayOfStage = stage?.startedOn ? daysBetween(stage.startedOn, DEMO_TODAY) + 1 : null;
  const cardTone = rolloutCardTone(rollout.status);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink href="/rollouts">← All price changes</TextLink>}
        title={rollout.name}
        meta={<RolloutStatusBadge status={rollout.status} />}
        description={meta.sentence}
        action={
          meta.isLive ? (
            <RollbackButton
              rolloutName={rollout.name}
              productCount={rollout.productIds.length}
              variant="primary"
            />
          ) : null
        }
      />

      {rollout.status === "paused_external" ? (
        <Notice tone="hold" title="Paused, because a price was changed outside Priceflag">
          Someone edited a price in the Shopify admin while this change was running. We stopped
          rather than blame the change for a difference we didn't cause. Nothing else will move until
          you either put prices back or start again from today's prices.
        </Notice>
      ) : null}

      {rollout.status === "rolled_back" ? (
        <Notice tone="breach" title="This change was undone automatically">
          Orders came in below the range we expected for{" "}
          {countOf(rollout.guardrail.forDays, "day")} in a row, which is the line you set when you
          created it. Every price was put back.{" "}
          <TextLink href="/journal">The journal</TextLink> has the exact prices and times.
        </Notice>
      ) : null}

      {/* What is live right now. */}
      <Card tone={cardTone} edge={cardTone !== "default"}>
        <CardHeader
          eyebrow="Right now"
          title={
            changedCount > 0
              ? `New prices are live on ${countOf(changedCount, "product")}`
              : "No Priceflag price is on your storefront right now"
          }
          description={
            changedCount > 0
              ? `Everything selected is being set ${changeSentence(rollout.change)}. Products not in the current step are still on their old price.`
              : `If this runs, everything selected goes ${changeSentence(rollout.change)}.`
          }
        />
        <CardBody>
          <StatGroup columns={3}>
            <Stat
              label="Products on a new price"
              value={`${changedCount} of ${products.length}`}
              tone={changedCount > 0 ? "live" : "default"}
              note={
                meta.isLive
                  ? "The rest change only if this step goes well."
                  : "No prices have moved."
              }
            />
            <Stat
              label="Step"
              value={`${rollout.currentStageIndex + 1} of ${rollout.stages.length}`}
              note={
                stage && dayOfStage && meta.isLive
                  ? `Day ${formatUnits(dayOfStage)} of ${formatUnits(stage.holdDays)} of watching orders.`
                  : "Not running."
              }
            />
            <Stat
              label="Days below the expected range"
              value={`${belowDays}`}
              tone={belowDays >= rollout.guardrail.forDays ? "breach" : "default"}
              note={`Everything goes back automatically at ${countOf(
                rollout.guardrail.forDays,
                "day",
              )} in a row.`}
            />
          </StatGroup>
        </CardBody>
        <CardFooter>
          <p className="max-w-prose">
            <span className="font-medium text-ink">Your safety net: </span>
            {guardrailSentence(rollout.guardrail)}
          </p>
        </CardFooter>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {/* Orders against expectation. */}
          <Card>
            <CardHeader
              title="Orders, day by day"
              description="Each day we compare the orders you actually got against the range we expected without a price change."
            />
            <CardBody flush>
              <Table caption="Daily orders against the expected range">
                <THead>
                  <TR>
                    <TH>Day</TH>
                    <TH numeric>Orders</TH>
                    <TH numeric>We expected</TH>
                    <TH className="w-[38%] min-w-[10rem]">How it landed</TH>
                    <TH>Verdict</TH>
                  </TR>
                </THead>
                <TBody>
                  {rollout.readings.length === 0 ? (
                    <TableEmptyRow colSpan={5}>
                      Nothing to compare yet. We check once a full day has passed in your store's
                      time.
                    </TableEmptyRow>
                  ) : (
                    rollout.readings
                      .slice()
                      .reverse()
                      .map((reading) => (
                        <TR
                          key={reading.date}
                          tone={reading.verdict === "below" ? "breach" : undefined}
                        >
                          <TD className="whitespace-nowrap">{formatDay(reading.date)}</TD>
                          <TD numeric className="font-medium">
                            {formatUnits(reading.actualUnits)}
                          </TD>
                          <TD numeric className="whitespace-nowrap text-ink-muted">
                            {formatUnits(reading.expectedLow)}–{formatUnits(reading.expectedHigh)}
                          </TD>
                          <TD>
                            <ExpectedRangeMark reading={reading} domainMax={domainMax} />
                          </TD>
                          <TD>
                            <VerdictBadge verdict={reading.verdict} />
                          </TD>
                        </TR>
                      ))
                  )}
                </TBody>
              </Table>
            </CardBody>
            {rollout.readings.length > 0 ? (
              <CardFooter>
                <ExpectedRangeLegend />
              </CardFooter>
            ) : null}
          </Card>

          {/* What we thought would happen. */}
          <Card>
            <CardHeader
              title="What we expected when you set this up"
              description="The first line is plain arithmetic and is true whatever happens. The range under it is a prediction, and it says how much to trust it."
            />
            <CardBody className="space-y-5">
              <p className="max-w-prose text-md font-medium text-ink">
                {breakevenSentence(rollout.forecast)}
              </p>

              <StatGroup columns={3}>
                <Stat
                  label={`Profit over ${rollout.forecast.horizonDays} days`}
                  value={
                    <RangeValue
                      low={formatMoneyDelta(rollout.forecast.profitDeltaLowCents, {
                        showCents: false,
                      })}
                      high={formatMoneyDelta(rollout.forecast.profitDeltaHighCents, {
                        showCents: false,
                      })}
                    />
                  }
                  note="Compared with leaving prices alone."
                />
                <Stat
                  label={`Revenue over ${rollout.forecast.horizonDays} days`}
                  value={
                    <RangeValue
                      low={formatMoneyDelta(rollout.forecast.revenueDeltaLowCents, {
                        showCents: false,
                      })}
                      high={formatMoneyDelta(rollout.forecast.revenueDeltaHighCents, {
                        showCents: false,
                      })}
                    />
                  }
                  note="Revenue can fall while profit rises."
                />
                <Stat
                  label="Orders"
                  value={
                    <RangeValue
                      low={formatPercentDelta(rollout.forecast.ordersDeltaLowFraction, {
                        digits: 0,
                      })}
                      high={formatPercentDelta(rollout.forecast.ordersDeltaHighFraction, {
                        digits: 0,
                      })}
                    />
                  }
                  note="How many fewer or more units you'd sell."
                />
              </StatGroup>

              <ConfidenceNote
                tier={rollout.forecast.confidence}
                explanation={rollout.forecast.explanation}
              />
            </CardBody>
            <CardFooter>
              <span>
                {rollout.forecast.modelVersion
                  ? `Worked out by ${rollout.forecast.modelVersion} from your store's own sales.`
                  : "Worked out from your margins and a general assumption about how demand responds — not from your store's own price history."}
              </span>
            </CardFooter>
          </Card>

          {/* Products. */}
          <Card>
            <CardHeader
              title="Products in this change"
              description="Which ones have already moved, and what each one would become."
            />
            <CardBody flush>
              <Table caption="Products in this price change">
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH numeric>Price now</TH>
                    <TH numeric>Price after the change</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {products.map((product) => (
                    <TR key={product.id}>
                      <TD>
                        <div className="font-medium">{product.title}</div>
                        <CellNote>{product.sku}</CellNote>
                      </TD>
                      <TD numeric className="font-medium">
                        {formatMoney(product.priceCents)}
                      </TD>
                      <TD numeric className="text-ink-muted">
                        {product.inLiveRollout
                          ? "Already there"
                          : formatMoney(priceAfterChange(product, rollout.change))}
                      </TD>
                      <TD>
                        {product.inLiveRollout ? (
                          <Badge tone="live" size="sm" dot>
                            New price live
                          </Badge>
                        ) : (
                          <span className="text-sm text-ink-subtle">Old price</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>

          <SetupCard rollout={rollout} />
        </div>

        <div className="min-w-0 space-y-6">
          {/* Steps. */}
          <Card>
            <CardHeader title="The steps" description="Each step adds more products, never more visitors." />
            <CardBody>
              <StageTimeline rollout={rollout} />
            </CardBody>
          </Card>

          {/* Plain-language event log. */}
          <Card>
            <CardHeader title="What has happened" description="Everything Priceflag did, and why." />
            {rollout.events.length === 0 ? (
              <EmptyState
                icon={<IconClock size={18} />}
                title="Nothing yet"
                description="Events appear here the moment anything happens."
              />
            ) : (
              <CardBody>
                <ol className="space-y-4">
                  {rollout.events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <li key={event.id} className="space-y-1">
                        <div className="text-xs text-ink-subtle">{formatDateTime(event.at)}</div>
                        <p className="text-base text-ink">{event.message}</p>
                        {event.detail ? (
                          <p className="text-sm text-ink-muted">{event.detail}</p>
                        ) : null}
                      </li>
                    ))}
                </ol>
              </CardBody>
            )}
          </Card>

          {/* Journal slice. */}
          <Card>
            <CardHeader
              title="Prices we changed"
              description="The record for this change, in your price journal."
            />
            {journal.length === 0 ? (
              <EmptyState
                icon={<IconInbox size={18} />}
                title="No price writes yet"
                description="Once a price moves, it is recorded here and in your journal."
              />
            ) : (
              <CardBody>
                <DetailList>
                  {journal.map((entry) => (
                    <DetailRow key={entry.id} label={entry.productTitle}>
                      <span className="flex flex-wrap items-center justify-end gap-2">
                        <PriceMove fromCents={entry.fromCents} toCents={entry.toCents} />
                        <ActorBadge actor={entry.actor} kind={entry.kind} />
                      </span>
                    </DetailRow>
                  ))}
                </DetailList>
              </CardBody>
            )}
            <CardFooter>
              <TextLink href="/journal">Open the full journal</TextLink>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

function RangeValue({ low, high }: { low: string; high: string }) {
  return (
    <span className="whitespace-nowrap">
      {low}
      <span className="px-1 text-ink-subtle" aria-hidden="true">
        to
      </span>
      <span className="sr-only"> to </span>
      {high}
    </span>
  );
}

function SetupCard({ rollout }: { rollout: Rollout }) {
  return (
    <Card>
      <CardHeader title="How this was set up" description="Fixed when you created it." />
      <CardBody>
        <DetailList>
          <DetailRow label="Change">{changeSentence(rollout.change)}</DetailRow>
          <DetailRow label="Products">{countOf(rollout.productIds.length, "product")}</DetailRow>
          <DetailRow label="Steps">
            {rollout.stages.map((s) => `${s.sharePct}%`).join(" → ")}
          </DetailRow>
          <DetailRow label="Created">{formatDateTime(rollout.createdAt)}</DetailRow>
          {rollout.startedAt ? (
            <DetailRow label="Started">{formatDateTime(rollout.startedAt)}</DetailRow>
          ) : null}
          {rollout.scheduledFor ? (
            <DetailRow label="Starts">{formatDateTime(rollout.scheduledFor)}</DetailRow>
          ) : null}
          {rollout.endedAt ? (
            <DetailRow label="Ended">{formatDateTime(rollout.endedAt)}</DetailRow>
          ) : null}
          {rollout.realizedProfitDeltaCents !== null ? (
            <DetailRow label="Profit in the end">
              {formatMoneyDelta(rollout.realizedProfitDeltaCents)}
            </DetailRow>
          ) : null}
        </DetailList>
      </CardBody>
    </Card>
  );
}
