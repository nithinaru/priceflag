import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { CardTone } from "@/components/ui/card";
import { cn } from "@/components/cn";
import {
  formatMoney,
  formatPercentPoints,
  countOf,
  formatPercent,
} from "@/components/format";
import type {
  ConfidenceTier,
  ForecastSummary,
  Guardrail,
  PriceChange,
  ReadingVerdict,
  RolloutStatus,
} from "@/components/mock/engine";

/**
 * All merchant-facing wording for rollout state lives here, in one file, so the
 * app cannot say "guardrail threshold" on one screen and "abort condition" on
 * another. Rule: describe what happened and what happens next. No statistics
 * vocabulary anywhere in this file (PRD R25).
 */

type StatusMeta = {
  label: string;
  tone: BadgeTone;
  /** True when a Priceflag price is on the storefront at this moment. */
  isLive: boolean;
  /** The one-line answer to "what is live right now?". */
  sentence: string;
};

const STATUS: Record<RolloutStatus, StatusMeta> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    isLive: false,
    sentence: "Nothing has changed on your storefront.",
  },
  scheduled: {
    label: "Scheduled",
    tone: "hold",
    isLive: false,
    sentence: "Set to start later. Nothing has changed on your storefront yet.",
  },
  live: {
    label: "Live",
    tone: "live",
    isLive: true,
    sentence: "New prices are on your storefront right now.",
  },
  holding: {
    label: "Live · holding",
    tone: "live",
    isLive: true,
    sentence: "New prices are live. We're waiting before moving to the next step.",
  },
  paused_external: {
    label: "Paused",
    tone: "hold",
    isLive: true,
    sentence: "Stopped, because a price was changed outside Priceflag. Nothing else will move.",
  },
  rolled_back: {
    label: "Undone",
    tone: "breach",
    isLive: false,
    sentence: "Every price was put back to what it was before.",
  },
  completed: {
    label: "Finished",
    tone: "neutral",
    isLive: false,
    sentence: "All the selected products are on the new price and monitoring has stopped.",
  },
};

export function rolloutStatusMeta(status: RolloutStatus): StatusMeta {
  return STATUS[status];
}

/**
 * Card tone follows the status, not merely "is something live" — a paused
 * rollout must not wear the calm green of a healthy one.
 */
export function rolloutCardTone(status: RolloutStatus): CardTone {
  switch (status) {
    case "live":
    case "holding":
      return "live";
    case "paused_external":
    case "scheduled":
      return "hold";
    case "rolled_back":
      return "breach";
    default:
      return "default";
  }
}

export function RolloutStatusBadge({
  status,
  size = "md",
}: {
  status: RolloutStatus;
  size?: "sm" | "md";
}) {
  const meta = STATUS[status];
  return (
    <Badge tone={meta.tone} size={size} dot pulse={status === "live" || status === "holding"}>
      {meta.label}
    </Badge>
  );
}

/** "6% higher" · "12% lower" · "$20.00 more". Never "+6%" on its own. */
export function changeSentence(change: PriceChange, currency = "USD"): string {
  const rising = change.value > 0;
  if (change.kind === "percent") {
    return `${formatPercentPoints(Math.abs(change.value))} ${rising ? "higher" : "lower"}`;
  }
  return `${formatMoney(Math.abs(change.value), { currency })} ${rising ? "more" : "less"}`;
}

/**
 * The breakeven sentence — pure margin arithmetic, true regardless of any
 * model, which is why it is stated before anything a model produced (R6).
 */
export function breakevenSentence(forecast: ForecastSummary): string {
  const drop = forecast.breakevenUnitsDropPct;
  if (drop > 0) {
    return `You could sell ${formatPercentPoints(drop)} fewer units and still make the same profit.`;
  }
  if (drop < 0) {
    return `You need ${formatPercentPoints(Math.abs(drop))} more units to make the same profit.`;
  }
  return "Your profit per sale does not change.";
}

type ConfidenceMeta = {
  label: string;
  tone: BadgeTone;
  /** Used when the engine sends no `explanation`. */
  fallback: string;
};

const CONFIDENCE: Record<ConfidenceTier, ConfidenceMeta> = {
  fitted: {
    label: "Based on your own sales",
    tone: "accent",
    fallback:
      "These products have sold at more than one price, so this range is worked out from your store's history.",
  },
  partial: {
    label: "Based on limited history",
    tone: "hold",
    fallback:
      "Only some of these products have sold at more than one price, so treat this range as a rough guide.",
  },
  assumption: {
    label: "Based on a general assumption",
    tone: "neutral",
    fallback:
      "These products have never sold at a different price, so this range is a general assumption — not your store's own numbers.",
  },
};

export function confidenceMeta(tier: ConfidenceTier): ConfidenceMeta {
  return CONFIDENCE[tier];
}

export function ConfidenceBadge({ tier }: { tier: ConfidenceTier }) {
  const meta = CONFIDENCE[tier];
  return (
    <Badge tone={meta.tone} size="sm">
      {meta.label}
    </Badge>
  );
}

/** Badge plus the one line that says why the number is only that trustworthy. */
export function ConfidenceNote({
  tier,
  explanation,
  className,
}: {
  tier: ConfidenceTier;
  explanation?: string;
  className?: string;
}) {
  const meta = CONFIDENCE[tier];
  return (
    <div className={cn("space-y-1.5", className)}>
      <ConfidenceBadge tier={tier} />
      <p className="max-w-prose text-sm text-ink-muted">{explanation || meta.fallback}</p>
    </div>
  );
}

/**
 * The guardrail, as one sentence. Stored as three fields so A3 can make the
 * numbers editable blanks inside this exact sentence (R10).
 */
export function guardrailSentence(guardrail: Guardrail): string {
  return (
    `If daily orders fall more than ${formatPercentPoints(guardrail.unitsDropPct)} below what we ` +
    `expect for ${countOf(guardrail.forDays, "day")} in a row, every price goes back automatically.`
  );
}

type VerdictMeta = { label: string; tone: BadgeTone; sentence: string };

const VERDICT: Record<ReadingVerdict, VerdictMeta> = {
  within: { label: "In range", tone: "live", sentence: "Orders landed where we expected." },
  below: {
    label: "Below range",
    tone: "breach",
    sentence: "Fewer orders than we expected on this day.",
  },
  above: {
    label: "Above range",
    tone: "live",
    sentence: "More orders than we expected on this day.",
  },
};

export function verdictMeta(verdict: ReadingVerdict): VerdictMeta {
  return VERDICT[verdict];
}

export function VerdictBadge({ verdict }: { verdict: ReadingVerdict }) {
  const meta = VERDICT[verdict];
  return (
    <Badge tone={meta.tone} size="sm">
      {meta.label}
    </Badge>
  );
}

/** "3 of 6 products" — a stage is a set of products, never a share of traffic. */
export function stageScopeLabel(skuCount: number, totalSkus: number): string {
  return `${skuCount} of ${totalSkus} ${totalSkus === 1 ? "product" : "products"}`;
}

/** Where cost came from, so a margin number is never unattributed (R3). */
export function CostSourceNote({
  source,
}: {
  source: "shopify" | "manual" | null;
}) {
  if (source === null) {
    return <span className="text-xs text-hold">Cost missing</span>;
  }
  return (
    <span className="text-xs text-ink-subtle">
      {source === "shopify" ? "From Shopify" : "Added by you"}
    </span>
  );
}

/** Small helper for the many "x% of expected" phrasings. */
export function shareOfExpected(actual: number, expected: number): string {
  if (expected <= 0) return "—";
  return formatPercent(actual / expected, { digits: 0 });
}

export function ProductKindBadge({ kind }: { kind: "standard" | "subscription" | "gift_card" }) {
  if (kind === "standard") return null;
  const label = kind === "subscription" ? "Subscription" : "Gift card";
  return (
    <Badge tone="neutral" size="sm">
      {label}
    </Badge>
  );
}

/** Wraps a value with the sentence that explains it. Used all over. */
export function Explained({
  children,
  note,
}: {
  children: ReactNode;
  note: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div>{children}</div>
      <p className="text-sm text-ink-muted">{note}</p>
    </div>
  );
}
