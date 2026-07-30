import type { Metadata } from "next";
import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CellNote,
  Notice,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableEmptyRow,
  TextLink,
} from "@/components/ui";
import { ActorBadge, PriceMove } from "@/components/domain/journal";
import { countOf, formatDateTime, formatPercentDelta } from "@/components/format";
import { getJournal, getRollout } from "@/components/mock/engine";

export const metadata: Metadata = {
  title: "Price journal",
};

/**
 * Shopify keeps no price audit trail; this is it. Includes changes made outside
 * Priceflag, because a change the merchant does not remember making is exactly
 * the one they will come here to find (PRD R18).
 *
 * Filters and CSV export are Sprint A6.
 */
export default function JournalPage() {
  const entries = getJournal();
  const externalCount = entries.filter((entry) => entry.kind === "external").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Price journal"
        description="Every price change on your store, including ones made in Shopify without Priceflag. Nothing is ever removed from this list."
      />

      {externalCount > 0 ? (
        <Notice
          tone="info"
          title={`${countOf(externalCount, "change")} came from outside Priceflag`}
        >
          Someone edited these prices in the Shopify admin. We record them so the history stays
          complete, and we pause any price change that touches the same product rather than blame
          our own change for the difference.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="All price changes"
          description="Newest first. Times are in your store's time."
        />
        <CardBody flush>
          <Table layout="intrinsic" caption="Every recorded price change, newest first">
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
              {entries.length === 0 ? (
                <TableEmptyRow colSpan={6}>
                  No price changes recorded yet. The first time a price moves — by Priceflag or by
                  you — it appears here.
                </TableEmptyRow>
              ) : (
                entries.map((entry) => {
                  const rollout = entry.rolloutId ? getRollout(entry.rolloutId) : undefined;
                  const change =
                    entry.fromCents > 0 ? (entry.toCents - entry.fromCents) / entry.fromCents : 0;
                  return (
                    <TR key={entry.id}>
                      <TD className="whitespace-nowrap text-ink-muted">
                        {formatDateTime(entry.at)}
                      </TD>
                      <TD>
                        <div className="font-medium">{entry.productTitle}</div>
                        <CellNote>{entry.sku}</CellNote>
                      </TD>
                      <TD numeric>
                        <PriceMove fromCents={entry.fromCents} toCents={entry.toCents} />
                      </TD>
                      <TD numeric>{formatPercentDelta(change, { digits: 1 })}</TD>
                      <TD>
                        <ActorBadge actor={entry.actor} kind={entry.kind} />
                      </TD>
                      <TD className="max-w-[18rem]">
                        <div className="text-ink-muted">{entry.reason}</div>
                        {rollout ? (
                          <CellNote>
                            <TextLink href={`/rollouts/${rollout.id}`}>Open this change</TextLink>
                          </CellNote>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })
              )}
            </TBody>
          </Table>
        </CardBody>
        <CardFooter>
          <span>{countOf(entries.length, "change")} recorded.</span>
          <span>Every price Priceflag sets can be traced back to the change that set it.</span>
        </CardFooter>
      </Card>
    </div>
  );
}
