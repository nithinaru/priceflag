"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * App chrome that hides the merchant nav on `/signin`. That page is reachable
 * without a session; Overview / Products must not appear beside it.
 */
export function ConditionalShell({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const hideNav = pathname === "/signin";

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-base focus:font-medium focus:text-accent-ink"
      >
        Skip to content
      </a>

      {hideNav ? null : nav}

      <div className={hideNav ? undefined : "lg:pl-60"}>
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-9">
          {children}
        </main>
      </div>
    </div>
  );
}
