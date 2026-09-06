"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { cn } from "@/components/cn";
import { DotsLoading } from "@/components/motion/anime-presence";
import { MetalCta } from "@/components/motion/metal-cta";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-quiet"
  | "neon"
  | "neonDark";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * One primary action per screen (BUILD_BRIEF §4, Lane A design bar):
 * - `primary`   the single thing the merchant is here to do
 * - `secondary` supporting actions
 * - `ghost`     tertiary / in-table actions
 * - `danger`    destructive-but-safe and *wanted* — rollback is the merchant's
 *               escape hatch, so it must look reachable, not scary
 * - `danger-quiet` the same action when it is not the point of the screen
 */

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium " +
  "whitespace-nowrap transition-[background-color,border-color,color] duration-100 " +
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "border-border-strong bg-surface text-ink hover:bg-surface-muted active:bg-surface-inset",
  ghost: "border-transparent bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "border-breach-border bg-breach-tint text-breach hover:bg-breach hover:text-white",
  "danger-quiet": "border-transparent bg-transparent text-breach hover:bg-breach-tint",
  neon:
    "relative overflow-hidden rounded-full border-transparent bg-[#d8f24b] text-[#13200a] " +
    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.45),0_0_18px_rgba(216,242,75,0.5)] " +
    "transition-[background-color,border-color,color,transform,box-shadow] duration-150 " +
    "hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5),0_0_28px_rgba(216,242,75,0.65),0_6px_16px_rgba(19,32,10,0.12)] " +
    "active:translate-y-0 active:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35),0_0_14px_rgba(216,242,75,0.4)] " +
    "motion-reduce:transition-[background-color,border-color,color,box-shadow] motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0 " +
    "after:pointer-events-none after:absolute after:inset-y-0 after:w-1/3 after:-skew-x-12 after:bg-gradient-to-r after:from-transparent after:via-white/35 after:to-transparent " +
    "after:-translate-x-[250%] hover:after:translate-x-[350%] after:transition-transform after:duration-500 after:ease-out motion-reduce:after:hidden",
  neonDark:
    "rounded-full border-transparent bg-[#030818] text-[#d8f24b] " +
    "shadow-[inset_0_1px_0_0_rgba(216,242,75,0.1)] hover:bg-[#0a1020] active:bg-[#020610]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-9 px-3.5 text-base",
  lg: "h-11 px-5 text-md",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction. Keeps the label so width is stable. */
  loading?: boolean;
  /** Announced while `loading` is true, e.g. "Putting prices back". */
  loadingLabel?: string;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
};

function isMetalVariant(variant: ButtonVariant): boolean {
  return variant === "neon" || variant === "neonDark";
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel,
  iconLeft,
  iconRight,
  fullWidth = false,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  const button = (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, cn(fullWidth && "w-full", className))}
      {...props}
    >
      {loading ? <DotsLoading /> : iconLeft}
      <span>{children}</span>
      {loading ? null : iconRight}
      {loading && loadingLabel ? (
        <span aria-live="polite" className="sr-only">
          {loadingLabel}
        </span>
      ) : null}
    </button>
  );

  if (!isMetalVariant(variant)) return button;

  return (
    <MetalCta
      paused={loading}
      theme={variant === "neonDark" ? "dark" : "light"}
      className={fullWidth ? "w-full" : undefined}
    >
      {button}
    </MetalCta>
  );
}

type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
};

/** A link that looks like a button. Use for navigation, never for actions. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  iconLeft,
  iconRight,
  fullWidth = false,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  const link = (
    <Link
      className={buttonClasses(variant, size, cn(fullWidth && "w-full", className))}
      {...props}
    >
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </Link>
  );

  if (!isMetalVariant(variant)) return link;

  return (
    <MetalCta theme={variant === "neonDark" ? "dark" : "light"} className={fullWidth ? "w-full" : undefined}>
      {link}
    </MetalCta>
  );
}

/** Plain inline text link, for prose and table cells. */
export function TextLink({
  className,
  children,
  standalone = false,
  ...props
}: ComponentProps<typeof Link> & {
  /**
   * The link is its own control rather than a word inside a sentence — a
   * breadcrumb, a card action, a footer link.
   *
   * WCAG 2.2 SC 2.5.8 (AA) wants a 24×24 target, and exempts links whose size is
   * "constrained by the line-height of non-target text" — i.e. inline links in a
   * paragraph. Standalone ones are not exempt, and at our type scale they come
   * out 15–22px high, so they get the height explicitly.
   */
  standalone?: boolean;
}) {
  return (
    <Link
      className={cn(
        "rounded-sm font-medium text-accent underline decoration-accent-border decoration-1 " +
          "underline-offset-2 hover:decoration-accent focus-visible:outline-2 " +
          "focus-visible:outline-offset-2 focus-visible:outline-focus",
        standalone && "inline-flex min-h-6 items-center",
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  );
}

