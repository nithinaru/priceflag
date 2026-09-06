import type { ReactNode } from "react";
import { cn } from "@/components/cn";

export type BadgeTone = "neutral" | "live" | "hold" | "breach" | "accent";
export type BadgeSize = "sm" | "md";

/**
 * Status colour meanings are fixed app-wide (see app/globals.css):
 * live = on the storefront now · hold = waiting on purpose · breach = below the
 * expected range or reverted · accent = an action or a link · neutral = a fact.
 * Panels stay white; a small neon or accent mark carries the tone.
 */

const DOTS: Record<BadgeTone, string> = {
  neutral: "bg-ink-subtle",
  live: "bg-neon",
  hold: "bg-accent",
  breach: "bg-accent",
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
  const showMark = dot || tone !== "neutral";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-surface font-medium text-ink",
        SIZES[size],
        className,
      )}
    >
      {showMark ? (
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
        "inline-flex h-5 items-center rounded-sm border border-border bg-surface px-1.5 text-2xs " +
          "font-medium uppercase text-ink-subtle",
        className,
      )}
    >
      {children}
    </span>
  );
}
