import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/components/format";
import type { JournalActor, JournalKind } from "@/components/mock/engine";

/**
 * Who changed a price, in the merchant's terms. "Changed in Shopify" rather
 * than "external" — the journal's whole value is that it explains a change the
 * merchant may not remember making (PRD R18).
 */
export function ActorBadge({ actor, kind }: { actor: JournalActor; kind: JournalKind }) {
  if (kind === "rollback") {
    return (
      <Badge tone="breach" size="sm">
        Undone
      </Badge>
    );
  }
  if (actor === "external") {
    return (
      <Badge tone="hold" size="sm">
        Changed in Shopify
      </Badge>
    );
  }
  if (actor === "you") {
    return (
      <Badge tone="neutral" size="sm">
        You
      </Badge>
    );
  }
  return (
    <Badge tone="accent" size="sm">
      Priceflag
    </Badge>
  );
}

/** `$34.00 → $36.00`, with the new price emphasised. */
export function PriceMove({
  fromCents,
  toCents,
  currency = "USD",
}: {
  fromCents: number;
  toCents: number;
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
