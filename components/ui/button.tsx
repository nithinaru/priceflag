import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { cn } from "@/components/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet";
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
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, cn(fullWidth && "w-full", className))}
      {...props}
    >
      {loading ? <Spinner /> : iconLeft}
      <span>{children}</span>
      {loading ? null : iconRight}
      {loading && loadingLabel ? (
        <span aria-live="polite" className="sr-only">
          {loadingLabel}
        </span>
      ) : null}
    </button>
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
  return (
    <Link
      className={buttonClasses(variant, size, cn(fullWidth && "w-full", className))}
      {...props}
    >
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </Link>
  );
}

/** Plain inline text link, for prose and table cells. */
export function TextLink({ className, children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "rounded-sm font-medium text-accent underline decoration-accent-border decoration-1 " +
          "underline-offset-2 hover:decoration-accent focus-visible:outline-2 " +
          "focus-visible:outline-offset-2 focus-visible:outline-focus",
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
