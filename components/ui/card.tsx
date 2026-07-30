import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/components/cn";

export type CardTone = "default" | "live" | "hold" | "breach" | "accent";

const TONES: Record<CardTone, string> = {
  default: "border-border bg-surface",
  live: "border-live-border bg-surface",
  hold: "border-hold-border bg-surface",
  breach: "border-breach-border bg-surface",
  accent: "border-accent-border bg-surface",
};

/** A left edge in the status colour, so state is readable before any text is. */
const EDGES: Record<CardTone, string> = {
  default: "",
  live: "before:bg-live",
  hold: "before:bg-hold",
  breach: "before:bg-breach",
  accent: "before:bg-accent",
};

export function Card({
  tone = "default",
  edge = false,
  className,
  children,
  ...props
}: {
  tone?: CardTone;
  /** Draw the status edge. Only meaningful with a non-default tone. */
  edge?: boolean;
} & HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        // `min-w-0` so a card that is a grid or flex child can shrink below its
        // content width; without it a wide table pushes the whole page sideways.
        "relative min-w-0 overflow-hidden rounded-lg border shadow-sm",
        TONES[tone],
        edge &&
          cn(
            "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-['']",
            EDGES[tone],
          ),
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  eyebrow,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** At most one action here, and never the screen's primary action twice. */
  action?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <div className="text-2xs font-semibold uppercase text-ink-subtle">{eyebrow}</div>
        ) : null}
        {title ? <h2 className="text-md font-semibold text-ink">{title}</h2> : null}
        {description ? <p className="max-w-prose text-base text-ink-muted">{description}</p> : null}
        {children}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
  flush = false,
}: {
  className?: string;
  children: ReactNode;
  /** No padding — for tables and lists that draw their own edges. */
  flush?: boolean;
}) {
  return (
    <div className={cn("min-w-0", !flush && "px-4 pb-4 sm:px-5 sm:pb-5", className)}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border " +
          "bg-surface-muted px-4 py-3 text-sm text-ink-muted sm:px-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A horizontal rule that lines up with card padding. */
export function CardDivider() {
  return <div className="border-t border-border" role="presentation" />;
}
