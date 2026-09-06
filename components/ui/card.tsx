import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/components/cn";
import { LiveCardOutline } from "@/components/motion/anime-presence";

export type CardTone = "default" | "live" | "hold" | "breach" | "accent";

/**
 * Cards are white with a 1px hairline. Tone is kept for call-site compatibility
 * but must not paint tinted panels or coloured edge bars.
 */
export function Card({
  tone: _tone = "default",
  edge: _edge = false,
  runningPulse = false,
  className,
  children,
  ...props
}: {
  tone?: CardTone;
  /** Ignored. Status is words + a small mark, not a coloured bar. */
  edge?: boolean;
  /** Spring outline while a rollout is running. */
  runningPulse?: boolean;
} & HTMLAttributes<HTMLElement>) {
  return (
    <LiveCardOutline active={runningPulse}>
      <section
        className={cn(
          // `min-w-0` so a card that is a grid or flex child can shrink below its
          // content width; without it a wide table pushes the whole page sideways.
          "relative min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-sm",
          className,
        )}
        {...props}
      >
        {children}
      </section>
    </LiveCardOutline>
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
        {title ? <h2 className="font-display text-md text-ink">{title}</h2> : null}
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
          "bg-surface px-4 py-3 text-sm text-ink-muted sm:px-5",
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
