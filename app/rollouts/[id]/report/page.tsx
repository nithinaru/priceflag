import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  Badge,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  DetailList,
  DetailRow,
  Notice,
  PageHeader,
  Stat,
  StatGroup,
  TextLink,
} from "@/components/ui";
import { RangeBar } from "@/components/propose/range-bar";
import { changeWords, countOf, rolloutStatusMeta, RolloutStatusBadge } from "@/components/domain/status";
import { formatDay, formatMoneyDelta, formatPctDelta, formatUnits } from "@/components/format";
import { getDemoStore } from "@/components/demo/store";
import { getRolloutBundle } from "@/components/demo/rollouts";
import {
  buildDemoReport,
  buildReportFromBundle,
  bundleHadPredictedRange,
  hadPredictedRange,
} from "@/components/demo/report";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealRolloutBundle } from "@/app/lib/store-data";
import { getMode } from "@/lib/config";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageSearchParams>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  // Real mode stays generic: naming another shop's rollout in a tab title would
  // be a cross-shop leak for the price of a guessed id.
  if (getMode() !== "demo") return { title: "Results" };
  const bundle = getRolloutBundle(id);
  return { title: bundle ? `${bundle.rollout.name} — results` : "Results" };
}

/**
 * What actually happened, against what we said would happen (R20/R30).
 *
 * This is the retention loop: it is the screen that decides whether a merchant
 * believes the next forecast. So the honesty rule is absolute — when the forecast
 * did not promise a range, this page says there is nothing to score rather than
 * grading itself against a prediction nobody made. Getting that wrong once buys a
 * flattering screenshot and costs the whole product's credibility.
 */
export default async function ReportPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  const demoMode = ctx.mode === "demo";
  const bundle = demoMode ? getRolloutBundle(id) : await getRealRolloutBundle(ctx.shop!, id);
  if (!bundle) notFound();

  const report = demoMode ? buildDemoReport(id) : buildReportFromBundle(bundle);
  const { rollout } = bundle;
  const currency = demoMode ? getDemoStore().shop.currency : ctx.shop!.currency;
  const scored = demoMode ? hadPredictedRange(id) : bundleHadPredictedRange(bundle);
  const money = (cents: number) => formatMoneyDelta(cents, { currency, showCents: false });

  if (!report) {
    return (
      <div className="space-y-6">
        <PageHeader
          breadcrumb={<TextLink standalone href={`/rollouts/${id}`}>← {rollout.name}</TextLink>}
          title="Results"
        />
        <Notice tone="info" title="Nothing to report yet">
          This price change has no full day of orders behind it, so there is nothing to compare.
          Results appear here once it has been live for a day.
        </Notice>
      </div>
    );
  }

  const profitKnown = report.realized.profit_delta_cents !== null;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<TextLink standalone href={`/rollouts/${id}`}>← {rollout.name}</TextLink>}
        title="What actually happened"
        meta={<RolloutStatusBadge status={rollout.status} />}
        description={`${countOf(report.window.days, "day")} of orders, ${formatDay(
          report.window.start_day,
        )} to ${formatDay(report.window.end_day)}, compared with what those days would have looked like at the old price.`}
      />

      {/* The verdict, first. */}
      <Card tone={scored ? (report.in_range ? "live" : "hold") : "default"} edge={scored}>
        <CardHeader
          eyebrow="The short version"
          title={
            scored
              ? report.in_range
                ? "This landed inside the range we predicted"
                : "This landed outside the range we predicted"
              : "We did not predict a range for this one"
          }
        />
        <CardBody className="space-y-5">
          <p className="max-w-prose text-lg text-ink">{report.narrative}</p>

          <StatGroup columns={3}>
            <Stat
              label="Profit over the period"
              value={profitKnown ? money(report.realized.profit_delta_cents!) : "Unknown"}
              tone={
                !profitKnown
                  ? "default"
                  : report.realized.profit_delta_cents! >= 0
                    ? "live"
                    : "breach"
              }
              note={
                profitKnown
                  ? "Against what the same days would have made at the old price."
                  : "Some of these products have no cost saved, so profit cannot be worked out."
              }
            />
            <Stat
              label="Revenue over the period"
              value={money(report.realized.revenue_delta_cents)}
              note="Revenue can fall while profit rises — that is often the point."
            />
            <Stat
              label="Orders"
              value={formatPctDelta(report.realized.units_change_pct, 0)}
              note="Against what we expected those days to do without a price change."
            />
          </StatGroup>
        </CardBody>
        <CardFooter>
          <span>
            {scored
              ? "Every forecast Priceflag makes is checked against what happened, including the ones we got wrong."
              : "There was not enough sales history to predict a range when this change was created, so we did not make one."}
          </span>
        </CardFooter>
      </Card>

      {/* Predicted vs realized — only when something was predicted. */}
      {scored ? (
        <Card>
          <CardHeader
            title="What we said, and what happened"
            description="The band is what we predicted. The marker is where it actually landed."
          />
          <CardBody className="space-y-6">
            {profitKnown ? (
              <PredictedVsRealized
                label={`Profit over ${report.window.days} days`}
                low={report.predicted.low.profit_delta_cents}
                high={report.predicted.high.profit_delta_cents}
                predicted={report.predicted.expected.profit_delta_cents}
                realized={report.realized.profit_delta_cents}
                format={money}
              />
            ) : null}
            <PredictedVsRealized
              label="Orders"
              low={report.predicted.low.units_change_pct}
              high={report.predicted.high.units_change_pct}
              predicted={report.predicted.expected.units_change_pct}
              realized={report.realized.units_change_pct}
              format={(value) => formatPctDelta(value, 0)}
            />
          </CardBody>
        </Card>
      ) : (
        <Notice tone="info" title="Why there is no score here">
          When this change was created, these products had not sold at more than one price, so there
          was nothing in your own history to predict from. We said so at the time rather than
          guessing, and we are not going to invent a prediction now just to grade ourselves against
          it. As your store builds up more selling history, these reports start carrying a real
          prediction to check.
        </Notice>
      )}

      {report.elasticity_update ? (
        <Card>
          <CardHeader
            title="What we learned about your customers"
            description="This feeds into the next forecast for these products."
          />
          <CardBody>
            <p className="max-w-prose text-base text-ink">
              {report.elasticity_update.direction === "less_sensitive"
                ? "Your customers were less put off by the higher price than we assumed. The next forecast for these products will be a little more optimistic."
                : report.elasticity_update.direction === "more_sensitive"
                  ? "Your customers were more price-sensitive than we assumed. The next forecast for these products will be more cautious."
                  : "Your customers behaved about as we assumed they would."}
            </p>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="The change itself" description="For the record." />
        <CardBody>
          <DetailList>
            <DetailRow label="What changed">{changeWords(rollout, currency)}</DetailRow>
            <DetailRow label="Products">
              {countOf(bundle.variants.filter((variant) => !variant.excluded).length, "product")}
            </DetailRow>
            <DetailRow label="How it ended">{rolloutStatusMeta(rollout.status).sentence}</DetailRow>
            <DetailRow label="Days of orders behind this">
              {countOf(report.window.days, "day")}
            </DetailRow>
            <DetailRow label="Units sold while live">
              {formatUnits(bundle.readings.reduce((sum, reading) => sum + reading.actual_units, 0))}
            </DetailRow>
          </DetailList>
        </CardBody>
        <CardFooter>
          <TextLink standalone href={`/rollouts/${id}`}>Back to the day-by-day view</TextLink>
          <TextLink standalone href="/journal">Every price this change moved</TextLink>
        </CardFooter>
      </Card>
    </div>
  );
}

function PredictedVsRealized({
  label,
  low,
  high,
  predicted,
  realized,
  format,
}: {
  label: string;
  low: number | null;
  high: number | null;
  predicted: number | null;
  realized: number | null;
  format: (value: number) => string;
}) {
  if (low === null || high === null || predicted === null || realized === null) return null;

  const lowest = Math.min(low, high);
  const highest = Math.max(low, high);
  const inside = realized >= lowest && realized <= highest;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-md font-medium text-ink">{label}</span>
        <Badge tone={inside ? "live" : "hold"} size="sm">
          {inside ? "Inside the range" : "Outside the range"}
        </Badge>
      </div>

      <RangeBar
        className="mt-2"
        label={`${label}, predicted range`}
        low={lowest}
        high={highest}
        expected={predicted}
        format={format}
        tone="neutral"
      />

      <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-base">
        <span className="text-ink-muted">
          We said{" "}
          <span className="font-medium tabular-nums text-ink">{format(predicted)}</span>, somewhere
          between {format(lowest)} and {format(highest)}
        </span>
        <span className="text-ink-muted">
          It was{" "}
          <span className={`font-medium tabular-nums ${inside ? "text-live" : "text-hold"}`}>
            {format(realized)}
          </span>
        </span>
      </div>
    </div>
  );
}
