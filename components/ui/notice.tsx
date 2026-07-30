import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { IconAlert, IconInfo, IconPause } from "@/components/ui/icons";

export type NoticeTone = "info" | "hold" | "breach";

const TONES: Record<NoticeTone, { box: string; icon: ReactNode }> = {
  info: {
    box: "border-accent-border bg-accent-tint text-ink",
    icon: <IconInfo size={17} className="text-accent" />,
  },
  hold: {
    box: "border-hold-border bg-hold-tint text-ink",
    icon: <IconPause size={17} className="text-hold" />,
  },
  breach: {
    box: "border-breach-border bg-breach-tint text-ink",
    icon: <IconAlert size={17} className="text-breach" />,
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
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-3 rounded-lg border px-4 py-3",
        TONES[tone].box,
        className,
      )}
    >
      <div className="mt-0.5 shrink-0">{TONES[tone].icon}</div>
      <div className="min-w-[16rem] flex-1 space-y-1">
        <p className="text-base font-semibold">{title}</p>
        {children ? <div className="max-w-prose text-base text-ink-muted">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
