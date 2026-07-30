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
import { OrdersChart } from "@/components/rollout/orders-chart";
import { StageTimeline } from "@/components/domain/stage-timeline";
import { ExpectedRangeMark, readingsDomainMax } from "@/components/domain/expected-range";
import { PriceMove, SourceBadge } from "@/components/domain/journal";
import {
  ExclusionBadge,
  GuardrailSummary,
  HealthBadge,
  RolloutStatusBadge,
  VerdictBadge,
  changeWords,
  countOf,
  rolloutCardTone,
  rolloutStatusMeta,
} from "@/components/domain/status";
import { formatDateTime, formatDay, formatMoney, formatUnits } from "@/components/format";
import { readingSentence, verdictForReading } from "@/lib/engine/readings";
import { getDemoStore } from "@/components/demo/store";
import { getJournalForRollout, getRolloutBundle, getRollouts } from "@/components/demo/rollouts";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const bundle = getRolloutBundle(id);
  return { title: bundle ? bundle.rollout.name : "Price change not found" };
}

export function generateStaticParams() {
  return getRollouts().map((rollout) => ({ id: rollout.id }));
}

/**
 * The monitoring screen. It has to answer three things without scrolling: what
 * is live, is it behaving, and how do I undo it (R16) — so the undo is the page's
 * single primary action whenever a Priceflag price is on the storefront.
 *
 * Every verdict, sentence and health call on this page comes from
 * `lib/engine/readings.ts`, which is what the evaluator uses, so the UI cannot
 * claim a rollout is fine when the machine has decided otherwise.
 *
 * A4 deepens this: the actual-vs-expected chart with its band drawn over time,
 * and the store-level kill switch.
 */
export default async function RolloutPage({ params }: PageProps) {
  const { id } = await params;
  const bundle = getRolloutBundle(id);
  if (!bundle) notFound();

  const { rollout, variants, readings, events, live, can, health, health_sentence } = bundle;
  const { shop } = getDemoStore();
  const meta = rolloutStatusMeta(rollout.status);
  const journal = getJournalForRollout(rollout.id);
  const domainMax = readingsDomainMax(readings);
  const belowDays = readings.filter(
    (reading) => !reading.band_floored && verdictForReading(reading) === "below",
  ).length;
  const currentStreak = readings.at(-1)?.breach_streak ?? 0;
  const guardrailDays = rollout.guardrails.rules[0]?.consecutive_days ?? 2;
  const included = variants.filter((variant) => !variant.excluded);
  const cardTone = rolloutCardTone(rollout.status);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink href="/rollouts">← All price changes</TextLink>}
        title={rollout.name}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <RolloutStatusBadge status={rollout.status} />
            {rollout.status === "running" || rollout.status === "paused" ? (
              <HealthBadge health={health} size="sm" />
            ) : null}
          </span>
        }
        description={meta.sentence}
        action={
          can.rollback ? (
            <RollbackButton
              rolloutId={rollout.id}
              rolloutName={rollout.name}
              productCount={live.variants_live}
              variant="primary"
            />
          ) : null
        }
      />

      {rollout.status === "paused" ? (
        <Notice tone="hold" title="Paused, because a price was changed outside Priceflag">
          {rollout.paused_reason} We stopped rather than blame this change for a difference we did
          not cause. Nothing else will move until you either put the prices back or start again from
          today&rsquo;s prices.
        </Notice>
      ) : null}

      {rollout.status === "rolled_back" ? (
        <Notice tone="breach" title="This change was undone automatically">
          Orders came in below the range you set as acceptable for {countOf(guardrailDays, "day")} in
          a row, which is the limit you wrote when you created it. Every price was put back.{" "}
          <TextLink href="/journal">The journal</TextLink> has the exact prices and times.
        </Notice>
      ) : null}

      {/* What is live right now. */}
      <Card tone={cardTone} edge={cardTone !== "default"}>
        <CardHeader
          eyebrow="Right now"
          title={
            live.variants_live > 0
              ? `New prices are live on ${countOf(live.variants_live, "product")}`
              : "No Priceflag price is on your storefront right now"
          }
          description={
            live.variants_live > 0
              ? `Everything selected is being set ${changeWords(rollout, shop.currency)}. Products not in the current step are still on their old price.`
              : `If this runs, everything selected goes ${changeWords(rollout, shop.currency)}.`
          }
        />
        <CardBody>
          <StatGroup columns={3}>
            <Stat
              label="Products on a new price"
              value={`${live.variants_live} of ${included.length}`}
              tone={live.variants_live > 0 ? "live" : "default"}
              note={
                rollout.status === "running"
                  ? "The rest change only if this step holds up."
                  : "No prices are moving."
              }
            />
            <Stat
              label="Step"
              value={`${Math.max(rollout.current_stage + 1, 1)} of ${rollout.stages.length}`}
              note={
                rollout.stage_entered_at
                  ? `This step started on ${formatDay(rollout.stage_entered_at)}.`
                  : "Not running."
              }
            />
            {/* The guardrail counts days *in a row*, so this has to as well —
                a total would read as alarm on a rollout that recovered. */}
            <Stat
              label="Days in a row below your limit"
              value={`${currentStreak}`}
              tone={currentStreak >= guardrailDays ? "breach" : currentStreak > 0 ? "hold" : "default"}
              note={
                belowDays > currentStreak
                  ? `Your limit acts at ${countOf(guardrailDays, "day")} in a row. ${countOf(
                      belowDays,
                      "day",
                    )} came in below the range in total, and recovered.`
                  : `Your limit acts at ${countOf(guardrailDays, "day")} in a row.`
              }
            />
          </StatGroup>
        </CardBody>
        <CardFooter>
          <GuardrailSummary guardrails={rollout.guardrails} />
        </CardFooter>
      </Card>

      {readings.length > 0 ? (
        <Notice
          tone={health === "breaching" ? "breach" : health === "watching" ? "hold" : "info"}
          title="How it is going"
        >
          {health_sentence}
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {/* Orders against expectation. */}
          <Card>
            <CardHeader
              title="Orders, day by day"
              description="Each day we compare the orders you actually got against the range we expected without a price change. The table under the chart has the same numbers."
            />
            {readings.length > 0 ? (
              <CardBody>
                <OrdersChart readings={readings} stageCount={rollout.stages.length} />
              </CardBody>
            ) : null}
            <CardBody flush>
              <Table caption="Daily orders against the expected range">
                <THead>
                  <TR>
                    <TH>Day</TH>
                    <TH numeric>Orders</TH>
                    <TH numeric>We expected</TH>
                    <TH className="w-[34%] min-w-[10rem]">How it landed</TH>
                    <TH>Verdict</TH>
                  </TR>
                </THead>
                <TBody>
                  {readings.length === 0 ? (
                    <TableEmptyRow colSpan={5}>
                      Nothing to compare yet. We check once a full day has passed in your
                      store&rsquo;s time.
                    </TableEmptyRow>
                  ) : (
                    readings
                      .slice()
                      .reverse()
                      .map((reading) => {
                        const verdict = verdictForReading(reading);
                        return (
                          <TR
                            key={reading.day}
                            tone={
                              !reading.band_floored && verdict === "below" ? "breach" : undefined
                            }
                          >
                            <TD className="whitespace-nowrap">{formatDay(reading.day)}</TD>
                            <TD numeric className="font-medium">
                              {formatUnits(reading.actual_units)}
                            </TD>
                            <TD numeric className="whitespace-nowrap text-ink-muted">
                              {reading.band_floored
                                ? "—"
                                : `${formatUnits(reading.expected_low, 1)}–${formatUnits(
                                    reading.expected_high,
                                    1,
                                  )}`}
                            </TD>
                            <TD>
                              <ExpectedRangeMark reading={reading} domainMax={domainMax} />
                            </TD>
                            <TD>
                              <VerdictBadge verdict={verdict} floored={reading.band_floored} />
                            </TD>
                          </TR>
                        );
                      })
                  )}
                </TBody>
              </Table>
            </CardBody>
            {readings.length > 0 ? (
              <CardFooter>
                {/* The chart above carries the legend; repeating it here is noise. */}
                <span>{readingSentence(readings[readings.length - 1]!)}</span>
              </CardFooter>
            ) : null}
          </Card>

          {/* Products. */}
          <Card>
            <CardHeader
              title="Products in this change"
              description="Which ones have already moved, and what each one would become."
            />
            <CardBody flush>
              <Table layout="intrinsic" caption="Products in this price change">
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH numeric>Price before</TH>
                    <TH numeric>Price after</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {variants.map((variant) => (
                    <TR key={variant.variant_gid} className={variant.excluded ? "opacity-70" : ""}>
                      <TD>
                        <div className="font-medium">{variant.title}</div>
                        <CellNote>{variant.sku ?? "No SKU"}</CellNote>
                      </TD>
                      <TD numeric className="text-ink-muted">
                        {formatMoney(variant.baseline_price_cents, { currency: shop.currency })}
                      </TD>
                      <TD numeric className="font-medium">
                        {variant.excluded
                          ? "—"
                          : formatMoney(variant.target_price_cents, { currency: shop.currency })}
                      </TD>
                      <TD>
                        {variant.excluded ? (
                          <ExclusionBadge
                            reason={
                              variant.exclusion_reason === "external_change"
                                ? null
                                : variant.exclusion_reason
                            }
                          />
                        ) : variant.reverted_at !== null ? (
                          <Badge tone="breach" size="sm">
                            Put back
                          </Badge>
                        ) : variant.applied_at !== null ? (
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
            <CardFooter>
              <span>
                The &ldquo;price before&rdquo; column is what we captured when this change was
                created. It is the only thing a rollback ever reads.
              </span>
            </CardFooter>
          </Card>

          <SetupCard bundle={bundle} />
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="The steps"
              description="Each step adds more products, never more visitors."
            />
            <CardBody>
              <StageTimeline rollout={rollout} variants={variants} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What has happened"
              description="Everything Priceflag did, and why."
            />
            {events.length === 0 ? (
              <EmptyState
                icon={<IconClock size={18} />}
                title="Nothing yet"
                description="Events appear here the moment anything happens."
              />
            ) : (
              <CardBody>
                <ol className="space-y-4">
                  {events
                    .slice()
                    .reverse()
                    .map((rolloutEvent) => (
                      <li key={rolloutEvent.id} className="space-y-1">
                        <div className="text-xs text-ink-subtle">
                          {formatDateTime(rolloutEvent.at)}
                        </div>
                        <p className="text-base text-ink">{rolloutEvent.message}</p>
                      </li>
                    ))}
                </ol>
              </CardBody>
            )}
          </Card>

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
                    <DetailRow key={entry.id} label={entry.title}>
                      <span className="flex flex-wrap items-center justify-end gap-2">
                        <PriceMove
                          fromCents={entry.before_price_cents}
                          toCents={entry.after_price_cents}
                          currency={entry.currency}
                        />
                        <SourceBadge source={entry.source} actor={entry.actor} />
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

function SetupCard({ bundle }: { bundle: NonNullable<ReturnType<typeof getRolloutBundle>> }) {
  const { rollout, variants } = bundle;
  const { shop } = getDemoStore();
  const included = variants.filter((variant) => !variant.excluded).length;

  return (
    <Card>
      <CardHeader title="How this was set up" description="Fixed when you created it." />
      <CardBody>
        <DetailList>
          <DetailRow label="Change">{changeWords(rollout, shop.currency)}</DetailRow>
          <DetailRow label="Products">
            {countOf(included, "product")}
            {variants.length !== included ? ` (${variants.length - included} left out)` : ""}
          </DetailRow>
          <DetailRow label="Steps">
            {rollout.stages.map((stage) => `${Math.round(stage.fraction * 100)}%`).join(" → ")}
          </DetailRow>
          <DetailRow label="Watched between steps">
            {countOf(rollout.stages[0]?.hold_days ?? 0, "day")}
          </DetailRow>
          <DetailRow label="Created">{formatDateTime(rollout.created_at)}</DetailRow>
          {rollout.started_at ? (
            <DetailRow label="Started">{formatDateTime(rollout.started_at)}</DetailRow>
          ) : null}
          {rollout.scheduled_start_at ? (
            <DetailRow label="Starts">{formatDateTime(rollout.scheduled_start_at)}</DetailRow>
          ) : null}
          {rollout.ended_at ? (
            <DetailRow label="Ended">{formatDateTime(rollout.ended_at)}</DetailRow>
          ) : null}
        </DetailList>
      </CardBody>
    </Card>
  );
}
