import type { ReactNode } from "react";
import { cn } from "@/components/cn";

export type BadgeTone = "neutral" | "live" | "hold" | "breach" | "accent";
export type BadgeSize = "sm" | "md";

/**
 * Status colour meanings are fixed app-wide (see app/globals.css):
 * live = on the storefront now · hold = waiting on purpose · breach = below the
 * expected range or reverted · accent = an action or a link · neutral = a fact.
 */

const TONES: Record<BadgeTone, string> = {
  neutral: "border-neutral-border bg-neutral-tint text-ink-muted",
  live: "border-live-border bg-live-tint text-live",
  hold: "border-hold-border bg-hold-tint text-hold",
  breach: "border-breach-border bg-breach-tint text-breach",
  accent: "border-accent-border bg-accent-tint text-accent",
};

const DOTS: Record<BadgeTone, string> = {
  neutral: "bg-ink-subtle",
  live: "bg-live",
  hold: "bg-hold",
  breach: "bg-breach",
  accent: "bg-accent",
};

const SIZES: Record<BadgeSize, string> = {
  sm: "h-5 gap-1 px-1.5 text-2xs",
  md: "h-6 gap-1.5 px-2 text-xs",
};

export function Badge({
  tone = "neutral",
  size = "md",
  dot = false,
  /** Pulses the dot. Reserved for "changing right now" — reduced-motion safe. */
  pulse = false,
  icon,
  className,
  children,
}: {
  tone?: BadgeTone;
  size?: BadgeSize;
  dot?: boolean;
  pulse?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-medium",
        TONES[tone],
        SIZES[size],
        className,
      )}
    >
      {dot ? (
        <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
          {pulse ? (
            <span
              className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-70", DOTS[tone])}
            />
          ) : null}
          <span className={cn("relative inline-flex size-1.5 rounded-full", DOTS[tone])} />
        </span>
      ) : null}
      {icon}
      {children}
    </span>
  );
}

/**
 * A one-word label above a value. Not a status — used for row metadata such as
 * "cost from Shopify" where colour would over-signal.
 */
export function Tag({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm bg-surface-inset px-1.5 text-2xs " +
          "font-medium uppercase text-ink-subtle",
        className,
      )}
    >
      {children}
    </span>
  );
}
