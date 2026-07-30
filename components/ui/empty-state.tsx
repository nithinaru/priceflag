import type { ReactNode } from "react";
import { cn } from "@/components/cn";

/**
 * Every empty state names what to do next and links somewhere real — no dead
 * ends (PRD R26). If there is nothing useful to do yet, say why, not "no data".
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  tone = "default",
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** The one thing to do next. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  tone?: "default" | "hold" | "breach";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {icon ? (
        <div
          className={cn(
            "mb-4 flex size-11 items-center justify-center rounded-full border",
            tone === "default" && "border-border bg-surface-muted text-ink-subtle",
            tone === "hold" && "border-hold-border bg-hold-tint text-hold",
            tone === "breach" && "border-breach-border bg-breach-tint text-breach",
          )}
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-md font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-md text-base text-ink-muted">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
