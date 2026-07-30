"use client";

import { useRef, useState } from "react";
import { cn } from "@/components/cn";
import { CellNote } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { IconCheck, IconClose } from "@/components/ui/icons";
import {
  centsToInputValue,
  formatMoney,
  parseMoneyToCents,
  type Cents,
} from "@/components/format";
import { saveProductCost } from "@/components/mock/engine";
import type { CogsSource } from "@/components/mock/engine";

/**
 * Cost, editable in place.
 *
 * Cost is the one number a merchant is expected to supply, and it gates every
 * profit figure in the app (R3), so editing it must be a two-second job from
 * wherever they noticed it was missing — not a trip to the Shopify admin.
 *
 * States: has a cost (with where it came from), has no cost (an explicit
 * invitation, never a blank), editing, saving, failed-to-save.
 */
export function CostCell({
  productId,
  productTitle,
  priceCents,
  cogsCents,
  cogsSource,
  onSaved,
}: {
  productId: string;
  productTitle: string;
  priceCents: Cents;
  cogsCents: Cents | null;
  cogsSource: CogsSource | null;
  onSaved: (cogsCents: Cents | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => centsToInputValue(cogsCents));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  function startEditing() {
    setDraft(centsToInputValue(cogsCents));
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function commit() {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : parseMoneyToCents(trimmed);

    if (trimmed !== "" && next === null) {
      setError("Enter a number, like 12.50.");
      return;
    }
    if (next !== null && next < 0) {
      setError("A cost can't be negative.");
      return;
    }
    if (next !== null && next > priceCents) {
      // Allowed — loss leaders are real — but say so, because a typo looks
      // exactly like this and a negative margin would silently poison a forecast.
      toast({
        tone: "warning",
        title: "That cost is above the price",
        description: `${productTitle} would lose ${formatMoney(
          next - priceCents,
        )} on every sale. Saved anyway — change it if that was a typo.`,
      });
    }
    if (next === cogsCents) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    const result = await saveProductCost(productId, next);
    setSaving(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setEditing(false);
    onSaved(result.cogsCents);
    toast({
      tone: "success",
      title: next === null ? "Cost cleared" : "Cost saved",
      description:
        next === null
          ? `${productTitle} has no cost again, so its profit is unknown.`
          : `${productTitle} costs ${formatMoney(next)}. Its profit is worked out from that.`,
    });
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <div className="relative">
            <span
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-base text-ink-subtle"
              aria-hidden="true"
            >
              $
            </span>
            <input
              ref={inputRef}
              autoFocus
              inputMode="decimal"
              value={draft}
              disabled={saving}
              aria-label={`Cost for ${productTitle}, in dollars`}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
              }}
              className={cn(
                "h-8 w-24 rounded-md border bg-surface pl-5 pr-2 text-right text-md outline-none " +
                  "focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus/35 " +
                  "disabled:text-ink-subtle sm:text-base",
                error ? "border-breach" : "border-border-strong",
              )}
            />
          </div>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={saving}
            aria-label={`Save cost for ${productTitle}`}
            className="rounded-md p-1.5 text-live outline-none hover:bg-live-tint focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            <IconCheck size={15} />
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            aria-label={`Stop editing the cost for ${productTitle}`}
            className="rounded-md p-1.5 text-ink-subtle outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
          >
            <IconClose size={15} />
          </button>
        </div>
        {saving ? (
          <CellNote className="text-ink-subtle">Saving…</CellNote>
        ) : error ? (
          <span className="text-xs text-breach">{error}</span>
        ) : (
          <CellNote>Enter to save, Esc to stop</CellNote>
        )}
      </div>
    );
  }

  if (cogsCents === null) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className="rounded-md border border-hold-border bg-hold-tint px-2 py-1 text-xs font-medium text-hold outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-focus"
      >
        Add cost
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      aria-label={`Cost for ${productTitle} is ${formatMoney(cogsCents)}. Edit it.`}
      className="group -mr-1.5 rounded-md px-1.5 py-1 text-right outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="block tabular-nums">{formatMoney(cogsCents)}</span>
      {/* Margin lives in the profit column; repeating it here is noise. */}
      <CellNote className="group-hover:text-ink-muted">
        {cogsSource === "shopify" ? "From Shopify" : "Added by you"}
      </CellNote>
    </button>
  );
}
