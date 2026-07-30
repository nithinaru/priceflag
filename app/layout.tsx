import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@/app/globals.css";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";

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
  return (
    <html lang="en">
      <body>
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
