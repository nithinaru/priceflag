import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader, DetailList, DetailRow, PageHeader, TextLink } from "@/components/ui";
import { ConnectPanel, type ConnectedShopState } from "@/components/onboarding/connect-panel";
import { resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
import { getAdapter } from "@/lib/adapters";
import { describeEnvironment } from "@/lib/config";
import { syncProgressFromRun } from "@/lib/sync";

export const metadata: Metadata = {
  title: "Connect your store",
};

// What is configured is read at request time, not baked into the build.
export const dynamic = "force-dynamic";

/**
 * The install path. Reads what is actually configured on the server
 * (`lib/config.describeEnvironment`, the same probe behind `GET /api/health`)
 * rather than guessing, so the page can never offer an install that would 404.
 *
 * When a store is already connected (or the OAuth flow just landed back here),
 * the latest sync run is read server-side so the panel's first paint shows the
 * real state — the client then polls `/api/sync/status` for the rest.
 */
export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const params = await searchParams;
  const environment = describeEnvironment();

  const context = await resolveShopForPage(params);
  let connected: ConnectedShopState | null = null;
  if (context.mode === "real" && context.shop !== null) {
    const run = await getAdapter().getLatestSyncRun(context.shop.id);
    connected = {
      domain: context.shop.shop_domain,
      syncState:
        run === null
          ? "none"
          : run.stage === "done"
            ? "done"
            : run.stage === "error"
              ? "error"
              : "running",
      progress: syncProgressFromRun(run),
    };
  }

  const installedParam = params["installed"];
  const installedNow = (Array.isArray(installedParam) ? installedParam[0] : installedParam) === "1";

  const badge =
    environment.mode === "demo"
      ? { tone: "hold" as const, label: "Demo store" }
      : connected !== null
        ? { tone: "live" as const, label: "Connected" }
        : { tone: "hold" as const, label: "Not connected yet" };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connect your store"
        description="One install, and Priceflag can show you what a price change would do before you make it."
        meta={
          <Badge tone={badge.tone} size="md" dot>
            {badge.label}
          </Badge>
        }
      />

      <ConnectPanel
        shopifyConfigured={environment.shopify || environment.shopifyStaticToken}
        installBase="/api/auth"
        connected={connected}
        installedNow={installedNow && connected === null}
      />

      <Card>
        <CardHeader
          title="What this copy of Priceflag is set up for"
          description="Useful if you are running Priceflag yourself rather than installing it from the app store."
        />
        <CardBody>
          <DetailList>
            <DetailRow label="Mode">
              {environment.mode === "demo"
                ? "Demo — a simulated store, so nothing here can affect a real storefront"
                : "Real — connected to a Shopify store"}
            </DetailRow>
            <DetailRow label="Shopify credentials">
              <Configured
                on={environment.shopify || environment.shopifyStaticToken}
                yes="Set"
                no="Not set — installing is unavailable"
              />
            </DetailRow>
            <DetailRow label="Database">
              <Configured on={environment.supabase} yes="Connected" no="Not set — using local demo state" />
            </DetailRow>
            <DetailRow label="Email notifications">
              <Configured on={environment.resend} yes="Set" no="Not set — no emails will be sent" />
            </DetailRow>
            <DetailRow label="Shopify API version">{environment.shopifyApiVersion}</DetailRow>
          </DetailList>
        </CardBody>
      </Card>

      <p className="text-base text-ink-muted">
        Already connected and just want to look around?{" "}
        <TextLink href="/products">Your products</TextLink> is the place to start.
      </p>
    </div>
  );
}

function Configured({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return (
    <span className={on ? "text-ink" : "text-hold"}>
      {on ? yes : no}
    </span>
  );
}
