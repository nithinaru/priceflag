import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Hedvig_Letters_Serif, Inter } from "next/font/google";
import "@/app/globals.css";
import { AppBridgeBoot } from "@/components/lib/app-bridge-boot";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { env, hasShopifyConfig, isDemoMode } from "@/lib/config";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["400", "500", "600"],
});

const hedvig = Hedvig_Letters_Serif({
  subsets: ["latin"],
  variable: "--font-hedvig",
  display: "swap",
  weight: "400",
});

export const metadata: Metadata = {
  title: {
    default: "Priceflag",
    template: "%s · Priceflag",
  },
  description:
    "Forecast a price change, roll it out gradually, and pause automatically for a merchant decision if performance crosses a safety limit.",
  icons: {
    icon: "/ibis.svg",
    apple: "/ibis.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Merchants check rollouts from phones (PRD R27) and must be able to zoom.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // App Bridge only in real mode with Shopify configured: demo mode and
  // credential-less deploys must render without reaching for cdn.shopify.com
  // (in demo the script would only warn about its missing embedded context).
  // The API key is the app's public client id, safe in markup by design.
  const shopifyApiKey =
    hasShopifyConfig() && !isDemoMode() ? env("SHOPIFY_API_KEY") : undefined;

  return (
    <html
      lang="en"
      data-theme="light"
      className={`${inter.variable} ${hedvig.variable} font-sans`}
    >
      {shopifyApiKey !== undefined ? (
        <head>
          <meta name="shopify-api-key" content={shopifyApiKey} />
          {/* Shopify requires this to be the first script and NOT async/deferred:
              it must define window.shopify before anything calls idToken(). */}
          <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
        </head>
      ) : null}
      <body className="bg-canvas font-sans text-ink antialiased">
        <ToastProvider>
          {shopifyApiKey !== undefined ? <AppBridgeBoot /> : null}
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
