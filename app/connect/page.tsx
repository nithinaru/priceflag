import type { Metadata } from "next";
import { Badge, PageHeader, PageSection } from "@/components/ui";
import { ConnectPanel, type ConnectedShopState } from "@/components/onboarding/connect-panel";
import { maybeBeginShopifyInstall, resolveShopForPage, type PageSearchParams } from "@/app/lib/shop-context";
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
 * When a store is already connected (or the install flow just landed back here),
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
  const shopifyConfigured = environment.shopify || environment.shopifyStaticToken;

  const context = await resolveShopForPage(params);
  maybeBeginShopifyInstall(context);
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
        meta={
          <Badge tone={badge.tone} size="md" dot>
            {badge.label}
          </Badge>
        }
      />

      {!shopifyConfigured && environment.mode !== "demo" ? (
        <PageSection>
          <p className="text-base text-ink-muted">
            Shopify is not configured on this deployment.
          </p>
        </PageSection>
      ) : null}

      <ConnectPanel
        shopifyConfigured={shopifyConfigured}
        demoMode={environment.mode === "demo"}
        installBase="/api/auth"
        connected={connected}
        installedNow={installedNow && connected === null}
      />
    </div>
  );
}
