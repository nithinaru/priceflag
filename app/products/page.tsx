import type { Metadata } from "next";
import {
  Badge,
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
import { CostSourceNote, ProductKindBadge } from "@/components/domain/status";
import {
  countOf,
  formatMoney,
  formatPercent,
  formatUnits,
  marginFraction,
} from "@/components/format";
import { getProducts, type Product } from "@/components/mock/engine";

export const metadata: Metadata = {
  title: "Products",
};

/**
 * The catalog at v0 depth, on the design system. Search, filter, sort,
 * multi-select and inline cost editing are Sprint A2 — this sprint is about the
 * table being legible and about the two states that matter most: a product with
 * no cost (profit unknown, never invented) and a product Priceflag will not
 * touch (subscriptions, gift cards).
 */
export default function ProductsPage() {
  const products = getProducts();
  const changeable = products.filter((product) => product.kind === "standard");
  const excluded = products.filter((product) => product.kind !== "standard");
  const missingCost = changeable.filter((product) => product.cogsCents === null);
  const liveCount = products.filter((product) => product.inLiveRollout).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="What each product sells for, what it costs you, and what you make on it. Costs come from Shopify where you've filled them in."
        meta={
          liveCount > 0 ? (
            <Badge tone="live" size="md" dot>
              {countOf(liveCount, "product")} on a new price
            </Badge>
          ) : null
        }
      />

      {missingCost.length > 0 ? (
        <Notice
          tone="hold"
          title={
            missingCost.length === 1
              ? "1 product has no cost yet"
              : `${missingCost.length} products have no cost yet`
          }
        >
          Without a cost we can show you revenue but not profit, and a profit forecast for these
          would be a guess. They are listed below with{" "}
          <span className="font-medium text-ink">Profit unknown</span> — Shopify's per-product cost
          field is the quickest way to fill them in.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Products Priceflag can change"
          description="Prices here are the prices on your storefront right now."
        />
        <CardBody flush>
          <Table
            layout="intrinsic"
            caption="Products, with price, cost, profit per sale and units sold in the last 30 days"
          >
            <THead>
              <TR>
                <TH>Product</TH>
                <TH numeric>Price</TH>
                <TH numeric>Cost</TH>
                <TH numeric>Profit per sale</TH>
                <TH numeric>Sold, last 30 days</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {changeable.length === 0 ? (
                <TableEmptyRow colSpan={6}>
                  No products yet. They appear here as soon as your store finishes syncing.
                </TableEmptyRow>
              ) : (
                changeable.map((product) => <ProductRow key={product.id} product={product} />)
              )}
            </TBody>
          </Table>
        </CardBody>
        <CardFooter>
          <span>
            {countOf(changeable.length, "product")}
            {missingCost.length > 0 ? `, ${missingCost.length} without a cost` : ""}.
          </span>
          <span>Prices shown in US dollars.</span>
        </CardFooter>
      </Card>

      {excluded.length > 0 ? (
        <Card>
          <CardHeader
            title="Products Priceflag leaves alone"
            description="Subscriptions and gift cards are never included in a price change. Changing a subscription price affects existing contracts, and a gift card's price is its value."
          />
          <CardBody flush>
            <Table caption="Products excluded from price changes">
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH numeric>Price</TH>
                  <TH>Why it's excluded</TH>
                </TR>
              </THead>
              <TBody>
                {excluded.map((product) => (
                  <TR key={product.id}>
                    <TD>
                      <div className="font-medium text-ink-muted">{product.title}</div>
                      <CellNote>{product.sku}</CellNote>
                    </TD>
                    <TD numeric className="text-ink-muted">
                      {formatMoney(product.priceCents)}
                    </TD>
                    <TD>
                      <ProductKindBadge kind={product.kind} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      ) : null}

      <p className="text-base text-ink-muted">
        Want to see what's already changing? <TextLink href="/rollouts">Your price changes</TextLink>{" "}
        shows everything going out, waiting, and finished.
      </p>
    </div>
  );
}

function ProductRow({ product }: { product: Product }) {
  const margin = marginFraction(product.priceCents, product.cogsCents);
  const profit =
    product.cogsCents === null ? null : product.priceCents - product.cogsCents;

  return (
    <TR interactive>
      <TD>
        <div className="font-medium">
          {product.title}
          {product.variantTitle ? (
            <span className="font-normal text-ink-muted"> · {product.variantTitle}</span>
          ) : null}
        </div>
        <CellNote>{product.sku}</CellNote>
      </TD>

      <TD numeric>
        <div className="font-medium">{formatMoney(product.priceCents)}</div>
        {product.compareAtCents !== null ? (
          <CellNote>
            <span className="line-through">{formatMoney(product.compareAtCents)}</span> crossed out
          </CellNote>
        ) : null}
      </TD>

      <TD numeric>
        {product.cogsCents === null ? (
          <span className="text-hold">Not set</span>
        ) : (
          <>
            <div>{formatMoney(product.cogsCents)}</div>
            <CellNote>
              <CostSourceNote source={product.cogsSource} />
            </CellNote>
          </>
        )}
      </TD>

      <TD numeric>
        {profit === null ? (
          <span className="text-ink-muted">Profit unknown</span>
        ) : (
          <>
            <div className="font-medium">{formatMoney(profit)}</div>
            <CellNote>{formatPercent(margin, { digits: 0 })} of the price</CellNote>
          </>
        )}
      </TD>

      <TD numeric className="text-ink-muted">
        {formatUnits(product.units30d)}
      </TD>

      <TD>
        {product.inLiveRollout ? (
          <Badge tone="live" size="sm" dot>
            New price live
          </Badge>
        ) : (
          <span className="text-sm text-ink-subtle">Unchanged</span>
        )}
      </TD>
    </TR>
  );
}
