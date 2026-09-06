import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { CardTone } from "@/components/ui/card";
import { cn } from "@/components/cn";
import { countOf, formatMoney, formatPct } from "@/components/format";
import type { Confidence, ExclusionReason, Guardrails } from "@/lib/contracts";
import type { CogsSource, Rollout, RolloutStatus } from "@/lib/types";
import type { ReadingVerdict, RolloutHealth } from "@/lib/engine/readings";

/**
 * Every merchant-facing word about rollout state, in one file, so the app cannot
 * say "guardrail threshold" on one screen and "abort condition" on another.
 * No statistics vocabulary anywhere in here (R25).
 *
 * Where Lane B already writes the sentence — `guardrails.rules[].sentence`,
 * `health_sentence`, `readingSentence`, `confidence_explanation`, event
 * `message` — that string is rendered **verbatim** and nothing here competes
 * with it. The wording below covers only labels and the cases the engine has no
 * opinion about.
 */

type StatusMeta = {
  label: string;
  tone: BadgeTone;
  /** True when a Priceflag price could be on the storefront in this state. */
  couldBeLive: boolean;
  /** The one-line answer to "what is live right now?". */
  sentence: string;
};

const STATUS: Record<RolloutStatus, StatusMeta> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    couldBeLive: false,
    sentence: "Nothing has changed on your storefront.",
  },
  scheduled: {
    label: "Scheduled",
    tone: "hold",
    couldBeLive: false,
    sentence: "Set to start later. Nothing has changed on your storefront yet.",
  },
  running: {
    label: "Live",
    tone: "live",
    couldBeLive: true,
    sentence: "New prices are on your storefront right now.",
  },
  paused: {
    label: "Paused",
    tone: "hold",
    couldBeLive: true,
    sentence: "Stopped where it was. Nothing else will move until you decide.",
  },
  completed: {
    label: "Finished",
    tone: "neutral",
    couldBeLive: true,
    sentence: "Every selected product is on the new price and monitoring has stopped.",
  },
  rolled_back: {
    label: "Undone",
    tone: "breach",
    couldBeLive: false,
    sentence: "Every price was put back to what it was before.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    couldBeLive: false,
    sentence: "Cancelled before anything went live.",
  },
};

export function rolloutStatusMeta(status: RolloutStatus): StatusMeta {
  return STATUS[status];
}

/** Card tone follows status — a paused rollout must not wear healthy green. */
export function rolloutCardTone(status: RolloutStatus): CardTone {
  switch (status) {
    case "running":
      return "live";
    case "paused":
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
    <Badge tone={meta.tone} size={size} dot pulse={status === "running"}>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ health */

const HEALTH: Record<RolloutHealth, { label: string; tone: BadgeTone }> = {
  healthy: { label: "On track", tone: "live" },
  watching: { label: "Worth watching", tone: "hold" },
  breaching: { label: "Below your limit", tone: "breach" },
  too_early: { label: "Too early to tell", tone: "neutral" },
  monitoring_ended: { label: "Monitoring ended", tone: "neutral" },
  not_live: { label: "Not live", tone: "neutral" },
};

export function healthMeta(health: RolloutHealth): { label: string; tone: BadgeTone } {
  return HEALTH[health];
}

export function HealthBadge({ health, size = "md" }: { health: RolloutHealth; size?: "sm" | "md" }) {
  const meta = HEALTH[health];
  return (
    <Badge tone={meta.tone} size={size} dot>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ change */

/** "6% higher" · "12% lower" · "$8.00 more". Never a bare "+6%". */
export function changeWords(
  change: Pick<Rollout, "change_type" | "change_pct" | "change_absolute_cents">,
  currency = "USD",
): string {
  if (change.change_type === "percent") {
    const points = change.change_pct ?? 0;
    return `${formatPct(Math.abs(points), Number.isInteger(points) ? 0 : 1)} ${points >= 0 ? "higher" : "lower"}`;
  }
  const cents = change.change_absolute_cents ?? 0;
  return `${formatMoney(Math.abs(cents), { currency })} ${cents >= 0 ? "more" : "less"}`;
}

/* -------------------------------------------------------------- confidence */

type ConfidenceMeta = {
  label: string;
  tone: BadgeTone;
  /** Used only when the engine sends no explanation of its own. */
  fallback: string;
};

const CONFIDENCE: Record<Confidence, ConfidenceMeta> = {
  fitted: {
    label: "Based on your own sales",
    tone: "accent",
    fallback:
      "These products have sold at more than one price, so this range is worked out from your store's own history.",
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
      "These products have not sold at a different price before, so this is a broad consumer-goods range rather than a prediction learned from your store.",
  },
};

export function ConfidenceBadge({ tier, size = "sm" }: { tier: Confidence; size?: "sm" | "md" }) {
  return (
    <Badge tone={CONFIDENCE[tier].tone} size={size}>
      {CONFIDENCE[tier].label}
    </Badge>
  );
}

/** Badge plus the one line saying why the number is only that trustworthy. */
export function ConfidenceNote({
  tier,
  explanation,
  className,
}: {
  tier: Confidence;
  /** `confidence_explanation` from the engine. Preferred over the fallback. */
  explanation?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <ConfidenceBadge tier={tier} />
      <p className="max-w-prose text-sm text-ink-muted">
        {explanation || CONFIDENCE[tier].fallback}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- guardrails */

/**
 * The stored sentence, rendered verbatim — it is what the merchant read when
 * they agreed to it, and the contract says never to regenerate it.
 */
function guardrailSentences(guardrails: Guardrails): string[] {
  return guardrails.rules.map((rule) => rule.sentence);
}

export function GuardrailSummary({
  guardrails,
  className,
}: {
  guardrails: Guardrails;
  className?: string;
}) {
  const sentences = guardrailSentences(guardrails);
  if (sentences.length === 0) {
    return (
      <p className={cn("max-w-prose", className)}>
        <span className="font-medium text-ink">No pause limit: </span>
        this change has no rule that will stop later stages for review.
      </p>
    );
  }
  return (
    <div className={cn("max-w-prose space-y-1", className)}>
      <p>
        <span className="font-medium text-ink">Your safety net: </span>
        {sentences[0]}
      </p>
      {sentences.slice(1).map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
      {!guardrails.auto_rollback ? (
        <p className="text-hold">
          Prices will not go back on their own — we pause and email you instead.
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- reading */

const VERDICT: Record<ReadingVerdict, { label: string; tone: BadgeTone }> = {
  within: { label: "In range", tone: "live" },
  below: { label: "Below range", tone: "breach" },
  above: { label: "Above range", tone: "live" },
};

export function VerdictBadge({
  verdict,
  floored = false,
}: {
  verdict: ReadingVerdict;
  /**
   * Too few unit sales for the day to mean anything. Rendered distinctly, because
   * "there isn't enough data to check" is not "we checked and it's fine".
   */
  floored?: boolean;
}) {
  if (floored) {
    return (
      <Badge tone="neutral" size="sm">
        Too quiet to judge
      </Badge>
    );
  }
  const meta = VERDICT[verdict];
  return (
    <Badge tone={meta.tone} size="sm">
      {meta.label}
    </Badge>
  );
}

/* ---------------------------------------------------------------- products */

/** Where cost came from, so a margin is never unattributed (R3). */
export function CostSourceNote({ source }: { source: CogsSource }) {
  if (source === "none") return <span className="text-xs text-hold">Cost missing</span>;
  return (
    <span className="text-xs text-ink-subtle">
      {source === "shopify" ? "From Shopify" : "Added by you"}
    </span>
  );
}

const EXCLUSION: Record<Exclude<ExclusionReason, null>, string> = {
  gift_card: "Gift card",
  subscription: "Subscription",
  not_active: "Not active in Shopify",
  zero_price: "No price set",
};

export function exclusionWords(reason: ExclusionReason): string | null {
  return reason === null ? null : EXCLUSION[reason];
}

/** Why Priceflag will not touch this product (R22). */
export function ExclusionBadge({ reason }: { reason: ExclusionReason }) {
  const words = exclusionWords(reason);
  if (words === null) return null;
  return (
    <Badge tone="neutral" size="sm">
      {words}
    </Badge>
  );
}

/** "3 of 6 products" — a step is a set of products, never a share of traffic. */
export function stageScopeLabel(count: number, total: number): string {
  return `${count} of ${total} ${total === 1 ? "product" : "products"}`;
}

export { countOf };
