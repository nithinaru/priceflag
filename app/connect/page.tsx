import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader, DetailList, DetailRow, PageHeader, TextLink } from "@/components/ui";
import { ConnectPanel } from "@/components/onboarding/connect-panel";
import { describeEnvironment } from "@/lib/config";

export const metadata: Metadata = {
  title: "Connect your store",
};

// What is configured is read at request time, not baked into the build.
export const dynamic = "force-dynamic";

/**
 * The install path. Reads what is actually configured on the server
 * (`lib/config.describeEnvironment`, the same probe behind `GET /api/health`)
 * rather than guessing, so the page can never offer an install that would 404.
 */
export default function ConnectPage() {
  const environment = describeEnvironment();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connect your store"
        description="One install, and Priceflag can show you what a price change would do before you make it."
        meta={
          <Badge tone={environment.mode === "demo" ? "hold" : "live"} size="md" dot>
            {environment.mode === "demo" ? "Demo store" : "Connected"}
          </Badge>
        }
      />

      <ConnectPanel
        shopifyConfigured={environment.shopify || environment.shopifyStaticToken}
        installBase="/api/auth"
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
