import { Badge, type BadgeTone } from "@/components/ui/badge";
import { formatMoney } from "@/components/format";
import type { JournalActor, JournalSource } from "@/lib/contracts";
import type { Cents } from "@/lib/money";

/**
 * Who moved a price, in the merchant's terms. "Changed in Shopify" rather than
 * "external" — the journal's whole value is explaining a change the merchant may
 * not remember making, since Shopify keeps no price audit trail (R18).
 */

const SOURCE: Record<JournalSource, { label: string; tone: BadgeTone }> = {
  rollout: { label: "Priceflag", tone: "accent" },
  rollback: { label: "Undone", tone: "breach" },
  kill_switch: { label: "Everything reverted", tone: "breach" },
  external: { label: "Changed in Shopify", tone: "hold" },
  manual: { label: "You", tone: "neutral" },
  seed: { label: "Before Priceflag", tone: "neutral" },
};

export function SourceBadge({
  source,
  actor,
}: {
  source: JournalSource;
  actor?: JournalActor;
}) {
  const meta = SOURCE[source];
  // A "manual" write by Priceflag itself would be misleading as "You".
  const label = source === "manual" && actor && actor !== "merchant" ? "Priceflag" : meta.label;
  return (
    <Badge tone={meta.tone} size="sm">
      {label}
    </Badge>
  );
}

/** `$34.00 → $36.00`, with the new price emphasised. */
export function PriceMove({
  fromCents,
  toCents,
  currency = "USD",
}: {
  fromCents: Cents;
  toCents: Cents;
  currency?: string;
}) {
  return (
    <span className="whitespace-nowrap">
      <span aria-hidden="true">
        <span className="text-ink-subtle">{formatMoney(fromCents, { currency })}</span>
        <span className="px-1 text-ink-subtle">→</span>
        <span className="font-medium">{formatMoney(toCents, { currency })}</span>
      </span>
      <span className="sr-only">
        from {formatMoney(fromCents, { currency })} to {formatMoney(toCents, { currency })}
      </span>
    </span>
  );
}
