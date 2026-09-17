import type { Metadata } from "next";
import {
  Badge,
  ButtonLink,
  DetailList,
  DetailRow,
  PageHeader,
  PageSection,
} from "@/components/ui";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { countOf } from "@/components/format";
import { getDemoStore } from "@/components/demo/store";
import { getLiveVariantGids } from "@/components/demo/rollouts";
import { describeEnvironment } from "@/lib/config";
import { NotConnected } from "@/components/shell/not-connected";
import { maybeBeginShopifyInstall, resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
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
  maybeBeginShopifyInstall(ctx);
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

      <PageSection title={data.shopDomain}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge tone={demo ? "hold" : "live"} size="md" dot>
            {demo ? "Demo" : "Live"}
          </Badge>
          {demo ? (
            <ButtonLink href="/connect" variant="neon" size="sm">
              Connect a real store
            </ButtonLink>
          ) : null}
        </div>
        <DetailList>
          <DetailRow label="Store">{data.shopDomain}</DetailRow>
          <DetailRow label="Products loaded">{countOf(data.productCount, "product")}</DetailRow>
          <DetailRow label="On a Priceflag price right now">
            {data.liveCount === 0 ? "None" : countOf(data.liveCount, "product")}
          </DetailRow>
          <DetailRow label="Currency">{data.currency}</DetailRow>
          <DetailRow label="Day boundaries">{data.timezone}</DetailRow>
        </DetailList>
      </PageSection>

      <NotificationSettings
        initialEmails={data.notifyEmails}
        emailConfigured={environment.resend}
        demoMode={demo}
      />
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
