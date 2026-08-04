import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@/app/globals.css";
import { AppBridgeBoot } from "@/components/lib/app-bridge-boot";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { env, hasShopifyConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: {
    default: "Priceflag",
    template: "%s · Priceflag",
  },
  description:
    "Propose a price change, see what it should do to your profit, roll it out gradually, and undo it automatically if the numbers drop.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Merchants check rollouts from phones (PRD R27) and must be able to zoom.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // App Bridge only when Shopify is configured: demo mode and credential-less
  // deploys must render without reaching for cdn.shopify.com. The API key is the
  // app's public client id, safe in markup by design.
  const shopifyApiKey = hasShopifyConfig() ? env("SHOPIFY_API_KEY") : undefined;

  return (
    <html lang="en">
      {shopifyApiKey !== undefined ? (
        <head>
          <meta name="shopify-api-key" content={shopifyApiKey} />
          {/* Shopify requires this to be the first script and NOT async/deferred:
              it must define window.shopify before anything calls idToken(). */}
          <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
        </head>
      ) : null}
      <body>
        <ToastProvider>
          {shopifyApiKey !== undefined ? <AppBridgeBoot /> : null}
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
