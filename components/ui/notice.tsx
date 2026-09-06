import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { IconAlert, IconInfo, IconPause } from "@/components/ui/icons";

export type NoticeTone = "info" | "hold" | "breach";

const MARKS: Record<NoticeTone, { mark: string; icon: ReactNode }> = {
  info: {
    mark: "bg-accent",
    icon: <IconInfo size={17} className="text-accent" />,
  },
  hold: {
    mark: "bg-accent",
    icon: <IconPause size={17} className="text-ink" />,
  },
  breach: {
    mark: "bg-neon",
    icon: <IconAlert size={17} className="text-ink" />,
  },
};

/**
 * An in-page banner for a state the merchant needs to act on or understand:
 * a rollout paused because someone edited a price in Shopify, costs missing,
 * a guardrail tripped. Always says what happened *and* what happens next.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { mark, icon } = MARKS[tone];
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3 text-ink",
        className,
      )}
    >
      <div className="mt-1.5 flex shrink-0 items-center gap-2">
        <span className={cn("size-1.5 rounded-full", mark)} aria-hidden="true" />
        {icon}
      </div>
      <div className="min-w-[16rem] flex-1 space-y-1">
        <p className="text-base font-semibold">{title}</p>
        {children ? <div className="max-w-prose text-base text-ink-muted">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
