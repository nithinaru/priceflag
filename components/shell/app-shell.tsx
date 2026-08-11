import type { ReactNode } from "react";
import { Nav } from "@/components/shell/nav";
import { LiveStatus, StoreCard } from "@/components/shell/live-status";
import { isDemoMode } from "@/lib/config";

/**
 * App frame: a permanent nav rail on desktop, a sticky bar plus drawer on
 * mobile, and one content column. The live-status card is rendered here (on the
 * server) and passed into the client nav, so "what is live right now" is
 * answered on every screen without the nav needing the data itself.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-base focus:font-medium focus:text-accent-ink"
      >
        Skip to content
      </a>

      <Nav statusSlot={<LiveStatus />} storeSlot={<StoreCard />} showFounderLab={isDemoMode()} />

      <div className="lg:pl-60">
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
          {children}
        </main>
      </div>
    </div>
  );
}
