"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/cn";
import { Button } from "@/components/ui";
import {
  IconBeaker,
  IconBook,
  IconClose,
  IconGauge,
  IconIbis,
  IconLayers,
  IconMenu,
  IconPlus,
  IconSettings,
  IconTag,
} from "@/components/ui/icons";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Overview",
    icon: <IconGauge size={24} />,
  },
  {
    href: "/products",
    label: "Products",
    icon: <IconTag size={24} />,
  },
  {
    href: "/rollouts",
    label: "Price changes",
    icon: <IconLayers size={24} />,
  },
  {
    href: "/journal",
    label: "Price journal",
    icon: <IconBook size={24} />,
  },
  {
    href: "/connect",
    label: "Connect store",
    icon: <IconPlus size={24} />,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: <IconSettings size={24} />,
  },
];

const FOUNDER_LAB_ITEM: NavItem = {
  href: "/model-lab",
  label: "Founder Lab",
  icon: <IconBeaker size={24} />,
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
      <div className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r border-border bg-surface lg:flex">
        <Brand />
        <NavList pathname={pathname} showFounderLab={showFounderLab} className="flex-1 overflow-y-auto px-3 py-4" />
        <RailFooter statusSlot={statusSlot} storeSlot={storeSlot} />
      </div>

      {/* Mobile: a sticky bar. Merchants check rollouts from phones (PRD R27). */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 lg:hidden">
        <Link href="/" className="flex items-center gap-2.5 rounded-md text-ink">
          <IconIbis size={28} />
          <span className="font-display text-2xl leading-none">Priceflag</span>
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
            <RailFooter statusSlot={statusSlot} storeSlot={storeSlot} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-5">
      <IconIbis size={32} />
      <div className="min-w-0">
        <div className="font-display text-2xl leading-tight text-ink">Priceflag</div>
      </div>
    </div>
  );
}

function RailFooter({
  statusSlot,
  storeSlot,
}: {
  statusSlot?: ReactNode;
  storeSlot?: ReactNode;
}) {
  return (
    <div className="space-y-3 border-t border-border px-3 py-4">
      {statusSlot}
      {storeSlot}
      <form action="/auth/sign-out" method="POST">
        <Button type="submit" variant="ghost" size="sm" fullWidth className="justify-start text-ink-subtle">
          Sign out
        </Button>
      </form>
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
                  "group flex items-center gap-3 rounded-md px-3 py-2.5 outline-none " +
                    "focus-visible:ring-2 focus-visible:ring-focus",
                  active
                    ? "bg-accent-tint text-accent"
                    : "text-ink hover:bg-surface-muted",
                )}
              >
                <span className={cn("shrink-0", active ? "text-accent" : "text-ink")}>
                  {item.icon}
                </span>
                <span className="block text-lg font-medium leading-tight">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
