import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { MotionViewTransition } from "@/components/motion/view-transition";

/**
 * Page title, one sentence of context, and at most one primary action. The
 * sentence is not decoration: it is how the merchant knows what this screen is
 * for without documentation. Titles use CSS `text-wrap: balance` — a script
 * inside `h1` leaked into the accessible name.
 */
export function PageHeader({
  title,
  description,
  action,
  meta,
  breadcrumb,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Badges or counts that qualify the title. */
  meta?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("space-y-3", className)}>
      {breadcrumb ? <div className="text-sm text-ink-muted">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <MotionViewTransition name="pf-title">
              <h1 className="text-balance font-display text-2xl text-ink">{title}</h1>
            </MotionViewTransition>
            {meta}
          </div>
          {description ? (
            <p className="max-w-prose text-md text-ink-muted">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
    </header>
  );
}
