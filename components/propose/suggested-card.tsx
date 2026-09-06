"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardFooter, CardHeader } from "@/components/ui";
import { ConfidenceBadge } from "@/components/domain/status";
import { PriceMove } from "@/components/domain/journal";
import { formatMoneyDelta } from "@/components/format";
import type { RecommendSuggestion } from "@/app/api/recommend/route";

/**
 * The "Suggested" card in the propose flow (consumes POST /api/recommend).
 *
 * An offer, not a directive: the wizard applies one uniform change to the whole
 * selection, while suggestions are per-SKU — so each row's only action narrows
 * the selection to that SKU and prefills the merchant's own wizard with the
 * suggested absolute change. Nothing here writes anything; the merchant still
 * walks the same forecast → draft → confirm path as a hand-typed change.
 *
 * Deliberately quieter than the forecast card (default tone, no accent edge):
 * the merchant's own change is the headline of this screen.
 */
const VISIBLE_ROWS = 3;

export function SuggestedCard({
  suggestions,
  currency,
  titleByGid,
  onUse,
}: {
  suggestions: RecommendSuggestion[];
  currency: string;
  /** Product titles keyed by variant gid (from the forecast's product lines). */
  titleByGid: ReadonlyMap<string, string>;
  onUse: (suggestion: RecommendSuggestion) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  // No usable suggestions → no card. An empty offer is just noise.
  if (suggestions.length === 0) return null;

  const visible = showAll ? suggestions : suggestions.slice(0, VISIBLE_ROWS);
  const hiddenCount = suggestions.length - VISIBLE_ROWS;

  return (
    <Card>
      <CardHeader title="Suggested" description="Nothing writes without your approval." />
      <CardBody flush>
        <ul className="divide-y divide-border">
          {visible.map((suggestion) => (
            <li key={suggestion.variant_gid} className="px-4 py-3.5 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">
                    {titleByGid.get(suggestion.variant_gid) ?? "One of your selected products"}
                  </span>
                  <ConfidenceBadge tier={suggestion.confidence} />
                </span>
                <span className="flex items-center gap-3">
                  <PriceMove
                    fromCents={suggestion.current_price_cents}
                    toCents={suggestion.recommended_price_cents}
                    currency={currency}
                  />
                  <Button size="sm" onClick={() => onUse(suggestion)}>
                    Use this price
                  </Button>
                </span>
              </div>
              <p className="mt-1.5 text-sm text-ink-muted">
                {formatMoneyDelta(suggestion.expected.nominal_profit_delta_cents_per_day, { currency })} a day
                if sales respond the way they have before
                {" · "}
                {formatMoneyDelta(suggestion.expected.robust_profit_delta_cents_per_day, { currency })} a day
                at the cautious end of the likely range.
              </p>
              <p className="mt-1 max-w-prose text-sm text-ink-subtle">{suggestion.rationale}</p>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 ? (
          <div className="border-t border-border px-4 py-2.5 sm:px-5">
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="rounded text-sm font-medium text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {showAll ? "Show fewer" : `Show ${hiddenCount} more`}
            </button>
          </div>
        ) : null}
      </CardBody>
      <CardFooter>
        <span>Worked out by {suggestions[0]!.model_version}.</span>
      </CardFooter>
    </Card>
  );
}
