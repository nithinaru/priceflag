"use client";

import { useMemo, useState } from "react";
import {
  Button,
  CellNote,
  PageSection,
  SearchInput,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableEmptyRow,
  TextLink,
} from "@/components/ui";
import { IconDownload } from "@/components/ui/icons";
import { PriceMove, SourceBadge } from "@/components/domain/journal";
import { countOf, formatDateTime, formatPctDelta } from "@/components/format";
import { journalToCsv, toJournalContract } from "@/lib/engine/journal";
import type { JournalSource } from "@/lib/contracts";
import type { JournalEntry } from "@/lib/types";

/**
 * The price journal, filterable and exportable.
 *
 * Filters mirror `GET /api/journal`'s query parameters (`source`, `rollout_id`,
 * `variant_gid`, `from`, `to`) so moving to the endpoint is a swap, not a
 * redesign. Filtering happens client-side for now because the whole journal is
 * already here; the moment it paginates this becomes a fetch.
 *
 * The export uses **Lane B's own `journalToCsv`**, which is what
 * `/api/journal.csv` will serve (B7). Reimplementing CSV here would guarantee the
 * downloaded file and the endpoint's file eventually disagree about quoting.
 */
export function JournalTable({
  entries,
  rolloutNames,
}: {
  entries: JournalEntry[];
  /** rollout id → name, for the "why" column and the CSV. */
  rolloutNames: Record<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<JournalSource | "all">("all");
  const [rolloutId, setRolloutId] = useState("all");
  const [days, setDays] = useState("all");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cutoff = days === "all" ? null : cutoffFor(entries, Number(days));

    return entries.filter((entry) => {
      if (needle) {
        const haystack = `${entry.title} ${entry.sku ?? ""} ${entry.reason ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (source !== "all" && entry.source !== source) return false;
      if (rolloutId !== "all") {
        if (rolloutId === "none" ? entry.rollout_id !== null : entry.rollout_id !== rolloutId) {
          return false;
        }
      }
      if (cutoff && entry.applied_at < cutoff) return false;
      return true;
    });
  }, [entries, query, source, rolloutId, days]);

  const filtersActive =
    query.trim() !== "" || source !== "all" || rolloutId !== "all" || days !== "all";

  function download() {
    const csv = journalToCsv(
      filtered.map((entry) =>
        toJournalContract(entry, entry.rollout_id ? rolloutNames[entry.rollout_id] : null),
      ),
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filtersActive ? "priceflag-journal-filtered.csv" : "priceflag-journal.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const rolloutOptions = Object.entries(rolloutNames);

  return (
    <PageSection title="All price changes">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[13rem] flex-1">
          <label htmlFor="journal-search" className="mb-1.5 block text-sm font-medium text-ink">
            Search
          </label>
          <SearchInput
            id="journal-search"
            placeholder="Product, SKU or reason"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="min-w-[10rem]">
          <label htmlFor="journal-source" className="mb-1.5 block text-sm font-medium text-ink">
            Who changed it
          </label>
          <Select
            id="journal-source"
            value={source}
            onChange={(event) => setSource(event.target.value as JournalSource | "all")}
          >
            <option value="all">Anyone</option>
            <option value="rollout">Priceflag</option>
            <option value="rollback">Undone</option>
            <option value="kill_switch">Everything reverted</option>
            <option value="external">Changed in Shopify</option>
            <option value="manual">You</option>
            <option value="seed">Before Priceflag</option>
          </Select>
        </div>

        <div className="min-w-[11rem]">
          <label htmlFor="journal-rollout" className="mb-1.5 block text-sm font-medium text-ink">
            Price change
          </label>
          <Select
            id="journal-rollout"
            value={rolloutId}
            onChange={(event) => setRolloutId(event.target.value)}
          >
            <option value="all">Any</option>
            <option value="none">Not from a price change</option>
            {rolloutOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </div>

        <div className="min-w-[9rem]">
          <label htmlFor="journal-when" className="mb-1.5 block text-sm font-medium text-ink">
            When
          </label>
          <Select id="journal-when" value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        </div>

        {filtersActive ? (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setSource("all");
              setRolloutId("all");
              setDays("all");
            }}
          >
            Clear filters
          </Button>
        ) : null}

        <Button
          variant="secondary"
          size="sm"
          onClick={download}
          disabled={filtered.length === 0}
          iconLeft={<IconDownload size={15} />}
        >
          Download {filtersActive ? "these" : "all"} as CSV
        </Button>
      </div>

      <Table layout="intrinsic" caption="Journal">
        <THead>
          <TR>
            <TH>When</TH>
            <TH>Product</TH>
            <TH numeric>Price</TH>
            <TH numeric>Change</TH>
            <TH>Who</TH>
            <TH>Why</TH>
          </TR>
        </THead>
        <TBody>
          {filtered.length === 0 ? (
            <TableEmptyRow colSpan={6}>
              {filtersActive ? "Nothing matches" : "No price changes yet"}
            </TableEmptyRow>
          ) : (
            filtered.map((entry) => {
              const changePct =
                entry.before_price_cents > 0
                  ? ((entry.after_price_cents - entry.before_price_cents) /
                      entry.before_price_cents) *
                    100
                  : 0;
              return (
                <TR key={entry.id}>
                  <TD className="whitespace-nowrap text-ink-muted">
                    {formatDateTime(entry.applied_at)}
                  </TD>
                  <TD>
                    <div className="font-medium">{entry.title}</div>
                    <CellNote>{entry.sku ?? "No SKU"}</CellNote>
                  </TD>
                  <TD numeric>
                    <PriceMove
                      fromCents={entry.before_price_cents}
                      toCents={entry.after_price_cents}
                      currency={entry.currency}
                    />
                  </TD>
                  <TD numeric>{formatPctDelta(changePct, 1)}</TD>
                  <TD>
                    <SourceBadge source={entry.source} actor={entry.actor} />
                  </TD>
                  <TD className="max-w-[18rem]">
                    <div className="text-ink-muted">{entry.reason ?? "—"}</div>
                    {entry.rollout_id ? (
                      <CellNote>
                        <TextLink href={`/rollouts/${entry.rollout_id}`}>
                          Open this change
                        </TextLink>
                      </CellNote>
                    ) : null}
                  </TD>
                </TR>
              );
            })
          )}
        </TBody>
      </Table>

      <div className="text-sm text-ink-muted">
        {filtersActive
          ? `${filtered.length} of ${countOf(entries.length, "change")}`
          : countOf(entries.length, "change")}
      </div>
    </PageSection>
  );
}

/** ISO cutoff `days` before the most recent entry — the demo store is not "now". */
function cutoffFor(entries: readonly JournalEntry[], days: number): string | null {
  const newest = entries[0]?.applied_at;
  if (!newest) return null;
  const date = new Date(newest);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}
