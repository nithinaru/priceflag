"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/cn";
import {
  IconBeaker,
  IconBook,
  IconClose,
  IconFlag,
  IconGauge,
  IconLayers,
  IconMenu,
  IconSettings,
  IconTag,
} from "@/components/ui/icons";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** One line of plain language, so the nav itself explains the app. */
  hint: string;
};

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Overview",
    icon: <IconGauge size={17} />,
    hint: "What is live right now",
  },
  {
    href: "/products",
    label: "Products",
    icon: <IconTag size={17} />,
    hint: "Prices, costs and profit per product",
  },
  {
    href: "/rollouts",
    label: "Price changes",
    icon: <IconLayers size={17} />,
    hint: "Changes going out, and ones that finished",
  },
  {
    href: "/journal",
    label: "Price journal",
    icon: <IconBook size={17} />,
    hint: "Every price change ever made",
  },
  {
    href: "/settings",
    label: "Settings",
    icon: <IconSettings size={17} />,
    hint: "Which store, and who we email",
  },
];

const FOUNDER_LAB_ITEM: NavItem = {
  href: "/model-lab",
  label: "Founder Lab",
  icon: <IconBeaker size={17} />,
  hint: "Run pricing scenarios safely",
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({
  statusSlot,
  storeSlot,
  showFounderLab = false,
}: {
  statusSlot?: ReactNode;
  storeSlot?: ReactNode;
  showFounderLab?: boolean;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer when navigation actually happens.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  return (
    <>
      {/* Desktop: a permanent rail. */}
      <div className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <Brand />
        <NavList pathname={pathname} showFounderLab={showFounderLab} className="flex-1 overflow-y-auto px-3 py-4" />
        <div className="space-y-3 border-t border-border px-3 py-4">
          {statusSlot}
          {storeSlot}
        </div>
      </div>

      {/* Mobile: a sticky bar. Merchants check rollouts from phones (PRD R27). */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5 lg:hidden">
        <Link href="/" className="flex items-center gap-2 rounded-md font-semibold text-ink">
          <span className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-ink">
            <IconFlag size={15} />
          </span>
          Priceflag
        </Link>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-expanded={drawerOpen}
          aria-controls="pf-mobile-nav"
          className={
            "inline-flex items-center gap-2 rounded-md border border-border-strong px-2.5 py-1.5 " +
            "text-sm font-medium text-ink outline-none hover:bg-surface-muted " +
            "focus-visible:ring-2 focus-visible:ring-focus"
          }
        >
          <IconMenu size={16} />
          Menu
        </button>
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-overlay"
            onClick={() => setDrawerOpen(false)}
            role="presentation"
          />
          <div
            id="pf-mobile-nav"
            className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col bg-surface shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="font-semibold text-ink">Menu</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1.5 text-ink-subtle outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
              >
                <IconClose size={18} />
              </button>
            </div>
            <NavList pathname={pathname} showFounderLab={showFounderLab} className="flex-1 overflow-y-auto px-3 py-4" />
            <div className="space-y-3 border-t border-border px-3 py-4">
              {statusSlot}
              {storeSlot}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
      <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-ink">
        <IconFlag size={17} />
      </span>
      <div className="min-w-0">
        <div className="text-md font-semibold leading-tight text-ink">Priceflag</div>
        <div className="text-xs text-ink-subtle">Price changes, safely</div>
      </div>
    </div>
  );
}

function NavList({
  pathname,
  showFounderLab,
  className,
}: {
  pathname: string;
  showFounderLab: boolean;
  className?: string;
}) {
  const items = showFounderLab ? [...ITEMS.slice(0, 2), FOUNDER_LAB_ITEM, ...ITEMS.slice(2)] : ITEMS;
  return (
    <nav className={className} aria-label="Main">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-start gap-2.5 rounded-md px-2.5 py-2 outline-none " +
                    "focus-visible:ring-2 focus-visible:ring-focus",
                  active
                    ? "bg-accent-tint text-accent"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink",
                )}
              >
                <span className={cn("mt-0.5 shrink-0", active ? "text-accent" : "text-ink-subtle")}>
                  {item.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-base font-medium">{item.label}</span>
                  <span
                    className={cn(
                      "block text-xs",
                      active ? "text-accent/80" : "text-ink-subtle",
                    )}
                  >
                    {item.hint}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
