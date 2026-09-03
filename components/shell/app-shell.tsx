import type { ReactNode } from "react";
import { Nav } from "@/components/shell/nav";
import { LiveStatus, StoreCard } from "@/components/shell/live-status";
import { ConditionalShell } from "@/components/shell/conditional-shell";
import { isDemoMode } from "@/lib/config";

/**
 * App frame: a permanent nav rail on desktop, a sticky bar plus drawer on
 * mobile, and one content column. The live-status card is rendered here (on the
 * server) and passed into the client nav, so "what is live right now" is
 * answered on every screen without the nav needing the data itself.
 *
 * `/signin` skips the nav so an unsigned visitor does not see merchant chrome.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ConditionalShell
      nav={<Nav statusSlot={<LiveStatus />} storeSlot={<StoreCard />} showFounderLab={isDemoMode()} />}
    >
      {children}
    </ConditionalShell>
  );
}
