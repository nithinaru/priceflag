import type { Metadata } from "next";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  DetailList,
  DetailRow,
  PageHeader,
  TextLink,
} from "@/components/ui";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { countOf } from "@/components/format";
import { getDemoStore } from "@/components/demo/store";
import { getLiveVariantGids } from "@/components/demo/rollouts";
import { describeEnvironment } from "@/lib/config";
import { NotConnected } from "@/components/shell/not-connected";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getRealSettings, type SettingsData } from "@/app/lib/store-data";

export const metadata: Metadata = {
  title: "Settings",
};

export const dynamic = "force-dynamic";

/**
 * Settings, and the demo ↔ real switch.
 *
 * The switch is **not a toggle in the UI**, and that is deliberate: which store
 * Priceflag is talking to is decided by the server's configuration, and a UI
 * control that appeared to change it would be lying about something that governs
 * whether real prices can move. So this explains what mode you are in, what it
 * means, and exactly what to do to change it.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const ctx = await resolveShopForPage(await searchParams);
  if (ctx.mode === "real" && ctx.shop === null) return <NotConnected />;

  const environment = describeEnvironment();
  const demo = ctx.mode === "demo";
  const data = demo ? demoSettings() : await getRealSettings(ctx.shop!);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={data.shopDomain}
      />

      <Card tone={demo ? "hold" : "live"} edge>
        <CardHeader
          title={demo ? "Demo store" : data.shopDomain}
          description={
            demo
              ? "Everything you see is simulated: a made-up catalog with made-up sales. Price changes here move nothing, and nothing is sent to Shopify. It is the safest place to learn what the product does."
              : "Price changes you start here change real prices on a real storefront."
          }
          action={
            demo ? (
              <ButtonLink href="/connect" variant="neon" size="sm">
                Connect a real store
              </ButtonLink>
            ) : null
          }
        >
          <div className="pt-1">
            <Badge tone={demo ? "hold" : "live"} size="md" dot>
              {demo ? "Demo data" : "Live store"}
            </Badge>
          </div>
        </CardHeader>
        <CardBody>
          <DetailList>
            <DetailRow label="Store">{data.shopDomain}</DetailRow>
            <DetailRow label="Products loaded">{countOf(data.productCount, "product")}</DetailRow>
            <DetailRow label="On a Priceflag price right now">
              {data.liveCount === 0 ? "None" : countOf(data.liveCount, "product")}
            </DetailRow>
            <DetailRow label="Currency">{data.currency}</DetailRow>
            <DetailRow label="Day boundaries">
              {data.timezone} — a day ends when it ends for your shoppers, not at UTC midnight
            </DetailRow>
          </DetailList>
        </CardBody>
        {demo ? (
          <CardFooter>
            <span>
              Switching to a real store is a server setting, not a button here — a toggle that only
              looked like it changed which storefront can be repriced would be a dangerous lie.{" "}
              <TextLink href="/connect">See what is configured</TextLink>.
            </span>
          </CardFooter>
        ) : null}
      </Card>

      <NotificationSettings
        initialEmails={data.notifyEmails}
        emailConfigured={environment.resend}
        demoMode={demo}
      />

      <Card>
        <CardHeader
          title="What Priceflag will never do"
          description="Worth stating plainly, because it is the reason this product works the way it does."
        />
        <CardBody>
          <ul className="space-y-2">
            {[
              "Show different prices to different shoppers. Everyone sees the same price, always — that is what keeps your ad feeds, your checkout and your customers' trust consistent.",
              "Change a price you did not ask it to change.",
              "Delete anything from your price journal. It only ever grows.",
              "Store anything about an individual customer. We read order totals by day, never who bought what.",
            ].map((line) => (
              <li key={line} className="flex gap-2 text-base text-ink-muted">
                <span aria-hidden="true" className="text-ink-subtle">
                  •
                </span>
                <span className="max-w-prose">{line}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function demoSettings(): SettingsData {
  const { shop, products } = getDemoStore();
  return {
    shopDomain: shop.domain,
    currency: shop.currency,
    timezone: shop.timezone,
    productCount: products.length,
    liveCount: getLiveVariantGids().length,
    notifyEmails: [],
  };
}
