import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { FlowNumber } from "@/components/motion/flow-number";

/**
 * A single number with its label and, where it exists, the sentence that makes
 * it meaningful. No stat ships without that sentence — an unexplained number is
 * the thing this UI is trying not to do (PRD R25).
 */
const FLOWABLE =
  /^([+$−-]?)(\$?)(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?(%?)$/;

function flowableValue(value: ReactNode): ReactNode {
  if (typeof value === "number" && Number.isFinite(value)) {
    return <FlowNumber value={value} />;
  }
  if (typeof value !== "string") return value;
  const match = value.trim().match(FLOWABLE);
  if (!match) return value;
  const signToken = match[1] ?? "";
  const dollar = match[2] ?? "";
  const digits = (match[3] ?? "").replace(/,/g, "");
  const fraction = match[4] ?? "";
  const percent = match[5] ?? "";
  const magnitude = Number(`${digits}${fraction}`);
  if (!Number.isFinite(magnitude)) return value;
  const negative = signToken === "−" || signToken === "-";
  const plus = signToken === "+";
  const prefix = `${plus ? "+" : negative ? "−" : ""}${dollar}`;
  return (
    <FlowNumber
      value={magnitude}
      prefix={prefix || undefined}
      suffix={percent || undefined}
      format={
        fraction
          ? { minimumFractionDigits: fraction.length - 1, maximumFractionDigits: fraction.length - 1 }
          : { maximumFractionDigits: 0 }
      }
    />
  );
}

export function Stat({
  label,
  value,
  /** Plain-language context: "8 above what we expected". */
  note,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "default" | "live" | "hold" | "breach";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "default" && "text-ink",
          tone === "live" && "text-live",
          tone === "hold" && "text-hold",
          tone === "breach" && "text-breach",
        )}
      >
        {flowableValue(value)}
      </dd>
      {note ? <dd className="mt-1 text-sm text-ink-muted">{note}</dd> : null}
    </div>
  );
}

export function StatGroup({
  columns = 3,
  className,
  children,
}: {
  columns?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn(
        // One column on a phone: a stat whose value is a range needs the width,
        // and a clipped money figure is worse than a taller page.
        "grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2",
        columns === 3 && "lg:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/** Label/value pairs that read as facts rather than metrics. */
export function DetailList({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn("divide-y divide-border", className)}>{children}</dl>;
}

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <dt className="text-base text-ink-muted">{label}</dt>
      <dd className="text-base font-medium text-ink tabular-nums">{children}</dd>
    </div>
  );
}
