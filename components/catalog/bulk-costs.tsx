"use client";

import { useMemo, useRef, useState } from "react";
import { cn } from "@/components/cn";
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  Notice,
} from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { IconArrowRight, IconCheck, IconTag } from "@/components/ui/icons";
import { countOf, formatMoney, formatPct, marginPct, parseMoneyToCents } from "@/components/format";
import { merchantJson } from "@/components/lib/merchant-api";
import type { Product } from "@/lib/types";
import type { Cents } from "@/lib/money";

/**
 * Adding costs, one after another.
 *
 * The catalog can already edit a cost in place, but that is the wrong shape for
 * the state Lane B's real store is actually in — **not one of 26 variants has a
 * cost** — because it makes the merchant hunt down 17 separate cells. This is the
 * same edit, laid out as a list you can go down with the keyboard: type, press
 * Enter, land on the next one.
 *
 * The reward is immediate and it is the whole reason this screen exists: the
 * moment a cost lands, that row shows the profit and margin it just unlocked. A
 * store with no orders still gets something real out of this — margin arithmetic
 * needs costs, not history.
 */
export function BulkCosts({
  products,
  currency,
  demoMode = true,
}: {
  products: Product[];
  currency: string;
  demoMode?: boolean;
}) {
  const [values, setValues] = useState<Record<string, Cents | null>>(() =>
    Object.fromEntries(products.map((product) => [product.variant_gid, product.cogs_cents])),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const { toast } = useToast();

  const remaining = useMemo(
    () => products.filter((product) => values[product.variant_gid] === null).length,
    [products, values],
  );
  const done = products.length - remaining;

  async function commit(product: Product, index: number, moveOn: boolean) {
    const raw = (drafts[product.variant_gid] ?? "").trim();
    if (raw === "") {
      if (moveOn) focusNext(index);
      return;
    }

    const cents = parseMoneyToCents(raw);
    if (cents === null || cents < 0) {
      setErrors((current) => ({
        ...current,
        [product.variant_gid]: "Enter a number, like 12.50.",
      }));
      return;
    }

    setErrors((current) => {
      const next = { ...current };
      delete next[product.variant_gid];
      return next;
    });
    setSaving(product.variant_gid);
    let result: { ok: true; cogs_cents: Cents; persisted: boolean } | { ok: false; message: string };
    if (demoMode) {
      result = { ok: true, cogs_cents: cents, persisted: false };
    } else {
      try {
        const reply = await merchantJson<{ product: { cogs_cents: Cents } }>(
          `/api/products/${encodeURIComponent(product.variant_gid)}/cogs`,
          { method: "PATCH", body: JSON.stringify({ cogs_cents: cents }) },
        );
        result = { ok: true, cogs_cents: reply.product.cogs_cents, persisted: true };
      } catch (cause) {
        result = {
          ok: false,
          message: cause instanceof Error ? cause.message : "That cost did not save. Try again.",
        };
      }
    }
    setSaving(null);

    if (!result.ok) {
      setErrors((current) => ({ ...current, [product.variant_gid]: result.message }));
      return;
    }

    toast({
      tone: "success",
      title: result.persisted ? "Cost saved" : "Cost updated on this screen",
      description: result.persisted
        ? `${product.title} now has a saved unit cost.`
        : "This is the demo store, so nothing was stored or sent to Shopify.",
    });

    setValues((current) => ({ ...current, [product.variant_gid]: result.cogs_cents }));
    setDrafts((current) => {
      const next = { ...current };
      delete next[product.variant_gid];
      return next;
    });

    if (cents > product.price_cents) {
      toast({
        tone: "warning",
        title: "That cost is above the price",
        description: `${product.title} would lose ${formatMoney(cents - product.price_cents, {
          currency,
        })} on every sale. Saved anyway — change it if that was a typo.`,
      });
    }

    if (moveOn) focusNext(index);
  }

  function focusNext(index: number) {
    for (let i = index + 1; i < products.length; i += 1) {
      const input = inputs.current[i];
      if (input) {
        input.focus();
        input.select();
        return;
      }
    }
    inputs.current[index]?.blur();
  }

  if (products.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconCheck size={19} />}
          title="Every product has a cost"
          description="Nothing left to add. Every profit figure in Priceflag is worked out from a real cost, not an assumption."
          action={
            <ButtonLink href="/products" variant="primary" iconRight={<IconArrowRight size={15} />}>
              Back to your products
            </ButtonLink>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Notice tone="info" title="Where to find these">
        In Shopify, a product&rsquo;s cost is the <strong className="font-medium text-ink">Cost
        per item</strong> field, under Pricing. Anything you save here stays in Priceflag — we do not
        write back to Shopify.
      </Notice>

      <Card>
        <CardHeader
          title="Add what each product costs you"
          description="Type a cost and press Enter to drop to the next one. Each one saves on its own, so you can stop whenever you like."
        />
        <CardBody flush>
          <ul className="divide-y divide-border border-t border-border">
            {products.map((product, index) => {
              const saved = values[product.variant_gid] ?? null;
              const draft = drafts[product.variant_gid] ?? "";
              const error = errors[product.variant_gid];
              const pending = parseMoneyToCents(draft);
              const preview = saved ?? (draft.trim() !== "" ? pending : null);
              const profit = preview === null ? null : product.price_cents - preview;
              const margin = preview === null ? null : marginPct(product.price_cents, preview);

              return (
                <li
                  key={product.variant_gid}
                  className={cn(
                    "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5",
                    saved !== null && "bg-live-tint/40",
                  )}
                >
                  <div className="min-w-[10rem] flex-1">
                    <div className="font-medium text-ink">
                      {product.title}
                      {product.variant_title ? (
                        <span className="font-normal text-ink-muted"> · {product.variant_title}</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-ink-subtle">
                      {product.sku ?? "No SKU"} · sells for{" "}
                      {formatMoney(product.price_cents, { currency })}
                    </div>
                  </div>

                  <div className="w-32">
                    <label htmlFor={`cost-${index}`} className="sr-only">
                      Cost for {product.title}, in dollars
                    </label>
                    <div className="relative">
                      <span
                        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-ink-subtle"
                        aria-hidden="true"
                      >
                        $
                      </span>
                      <input
                        id={`cost-${index}`}
                        ref={(node) => {
                          inputs.current[index] = node;
                        }}
                        inputMode="decimal"
                        value={draft !== "" ? draft : saved !== null ? (saved / 100).toFixed(2) : ""}
                        disabled={saving === product.variant_gid}
                        aria-invalid={error ? true : undefined}
                        placeholder="0.00"
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [product.variant_gid]: event.target.value,
                          }))
                        }
                        onBlur={() => void commit(product, index, false)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commit(product, index, true);
                          }
                        }}
                        className={cn(
                          "h-9 w-full rounded-md border bg-surface pl-6 pr-2.5 text-right text-md " +
                            "outline-none focus-visible:border-accent focus-visible:ring-2 " +
                            "focus-visible:ring-focus/35 disabled:text-ink-subtle",
                          error ? "border-breach" : "border-border-strong",
                        )}
                      />
                    </div>
                  </div>

                  <div className="w-40 text-right text-sm">
                    {error ? (
                      <span className="text-breach">{error}</span>
                    ) : profit === null ? (
                      <span className="text-ink-subtle">Profit unknown</span>
                    ) : (
                      <>
                        <div
                          className={cn(
                            "font-medium tabular-nums",
                            profit < 0 ? "text-breach" : "text-ink",
                          )}
                        >
                          {formatMoney(profit, { currency })} a sale
                        </div>
                        <div className="text-xs text-ink-muted">
                          {profit < 0 ? "below cost" : `${formatPct(margin, 0)} of the price`}
                        </div>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardBody>
        <CardFooter>
          <span>
            {done === 0
              ? `${countOf(products.length, "product")} to go.`
              : remaining === 0
                ? "Every one done."
                : `${done} of ${products.length} done — ${remaining} to go.`}
          </span>
          {remaining === 0 ? (
            <ButtonLink href="/products" variant="primary" size="sm" iconRight={<IconArrowRight size={15} />}>
              See your products
            </ButtonLink>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => focusNext(-1)}>
              Jump to the first one
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
