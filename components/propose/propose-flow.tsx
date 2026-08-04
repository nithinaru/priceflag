"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  DetailList,
  DetailRow,
  EmptyState,
  Field,
  Input,
  Notice,
  SkeletonCard,
  TextLink,
} from "@/components/ui";
import { cn } from "@/components/cn";
import { IconArrowRight, IconTag } from "@/components/ui/icons";
import { readSelection } from "@/components/catalog/selection";
import { ForecastCard } from "@/components/propose/forecast-card";
import {
  DEFAULT_GUARDRAIL_DRAFT,
  GuardrailBuilder,
  guardrailSentence,
  toGuardrails,
  type GuardrailDraft,
} from "@/components/propose/guardrail-builder";
import { useToast } from "@/components/ui/toast";
import { merchantJson } from "@/components/lib/merchant-api";
import { countOf, formatMoney, formatPct, parseMoneyToCents } from "@/components/format";
import type { ForecastRequest, ForecastReply } from "@/app/propose/actions";
import { normalizeStages } from "@/lib/engine/rollout";
import { CONTRACT_VERSION, type ForecastResult } from "@/lib/contracts";

/**
 * The propose flow (A3).
 *
 * Four questions in the order a merchant actually asks them: which products,
 * what change, what would happen, and when should we stop. The forecast reruns
 * as the change is edited — `POST /api/forecast` writes nothing, so it is safe to
 * call on every keystroke once debounced.
 *
 * One primary action on the screen, at the end: creating a draft. A separate
 * review screen owns the explicit confirmation required before any write.
 */
export function ProposeFlow({ demoMode = true }: { demoMode?: boolean }) {
  const [gids, setGids] = useState<string[] | null>(null);
  const [kind, setKind] = useState<"percent" | "absolute">("percent");
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [amount, setAmount] = useState("5");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<GuardrailDraft>(DEFAULT_GUARDRAIL_DRAFT);

  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ message: string; rolloutId: string | null } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    setGids(readSelection());
  }, []);

  const parsed = parseAmount(kind, direction, amount);
  const change = useMemo<ForecastRequest["change"] | null>(() => {
    if (parsed.error !== null || parsed.value === null) return null;
    return kind === "percent"
      ? { type: "percent", percent: parsed.value }
      : { type: "absolute", absolute_cents: parsed.value };
  }, [kind, parsed.error, parsed.value]);

  // Debounced, and last-write-wins so a slow reply cannot overwrite a fast one.
  const requestId = useRef(0);
  useEffect(() => {
    if (gids === null || gids.length === 0 || change === null) {
      setForecast(null);
      setLoading(false);
      return;
    }
    const id = requestId.current + 1;
    requestId.current = id;
    setLoading(true);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let next: ForecastResult;
          if (demoMode) {
            const response = await fetch("/api/demo/forecast", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variant_gids: gids, change }),
            });
            const reply = (await response.json()) as ForecastReply;
            if (!reply.ok) throw new Error(reply.message);
            next = reply.forecast;
          } else {
            next = await merchantJson<ForecastResult>("/api/forecast", {
              method: "POST",
              body: JSON.stringify({ contract_version: CONTRACT_VERSION, variant_gids: gids, change }),
            });
          }
          if (requestId.current !== id) return;
          setForecast(next);
          setError(null);
        } catch (cause) {
          if (requestId.current !== id) return;
          setForecast(null);
          setError(cause instanceof Error ? cause.message : "We could not forecast that change.");
        } finally {
          if (requestId.current === id) setLoading(false);
        }
      })();
    }, 350);

    return () => window.clearTimeout(timer);
  }, [gids, change, demoMode]);

  if (gids === null) return <SkeletonCard />;

  if (gids.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconTag size={19} />}
          title="Nothing is selected"
          description="Pick the products you want to reprice in your catalog and they will show up here with the arithmetic worked out. Selections are not kept once you close the tab."
          action={
            <ButtonLink href="/products" variant="primary" iconRight={<IconArrowRight size={15} />}>
              Go to your products
            </ButtonLink>
          }
        />
      </Card>
    );
  }

  const included = forecast?.products.filter((line) => !line.excluded) ?? [];
  const stages = included.length > 0 ? normalizeStages(undefined, included.length) : [];
  const defaultName = `${
    parsed.error === null ? describeChange(kind, direction, parsed.value ?? 0) : "Price change"
  } — ${countOf(included.length || gids.length, "product")}`;

  return (
    <div className="space-y-6">
      {/* 1. What is being changed. */}
      <Card>
        <CardHeader
          title="The change"
          description="Everything below updates as you edit this. Nothing here touches your storefront."
          action={
            <TextLink standalone href="/products">Change the selection</TextLink>
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <Segmented
              label="How to change it"
              value={kind}
              onChange={(value) => setKind(value as "percent" | "absolute")}
              options={[
                { value: "percent", label: "By a percentage" },
                { value: "absolute", label: "By an amount" },
              ]}
            />
            <Segmented
              label="Which way"
              value={direction}
              onChange={(value) => setDirection(value as "up" | "down")}
              options={[
                { value: "up", label: "Put prices up" },
                { value: "down", label: "Bring prices down" },
              ]}
            />
            <div className="w-32">
              <label htmlFor="change-amount" className="mb-1.5 block text-sm font-medium text-ink">
                {kind === "percent" ? "How much" : "How much each"}
              </label>
              <Input
                id="change-amount"
                inputMode="decimal"
                value={amount}
                invalid={parsed.error !== null}
                aria-describedby={parsed.error ? "change-amount-error" : undefined}
                onChange={(event) => setAmount(event.target.value)}
                prefix={kind === "absolute" ? "$" : undefined}
                suffix={kind === "percent" ? "%" : undefined}
              />
            </div>
          </div>

          {parsed.error ? (
            <p id="change-amount-error" className="text-sm text-breach">
              {parsed.error}
            </p>
          ) : (
            <p className="text-md font-medium text-ink">
              {countOf(gids.length, "product")} selected, each{" "}
              {describeChange(kind, direction, parsed.value ?? 0)}.
            </p>
          )}
        </CardBody>
      </Card>

      {/* 2. What would happen. */}
      {error ? (
        <Notice tone="breach" title="We cannot forecast that change">
          {error}{" "}
          <TextLink href="/products">Pick different products</TextLink> or change the amount.
        </Notice>
      ) : null}

      {forecast === null && !error ? (
        <SkeletonCard />
      ) : forecast !== null ? (
        <div className={cn(loading && "opacity-60 transition-opacity")} aria-busy={loading}>
          <ForecastCard forecast={forecast} />
        </div>
      ) : null}

      {/* 3. When should we stop. */}
      {forecast !== null ? (
        <GuardrailBuilder
          draft={draft}
          onChange={setDraft}
          baselineUnitsPerDay={forecast.baseline.units_per_day}
          hasCogs={forecast.baseline.has_cogs}
        />
      ) : null}

      {/* 4. Create the reviewable draft. This still performs no Shopify write. */}
      {forecast !== null && included.length > 0 ? (
        <Card tone={created ? "live" : "default"} edge={created !== null}>
          <CardHeader
            title={created ? "Draft created" : "Ready to create a draft"}
            description={
              created
                ? undefined
                : "Priceflag will freeze today's baselines and prepare a staged plan. You review it once more before anything changes."
            }
          />
          <CardBody className="space-y-5">
            {created ? (
              <p className="max-w-prose text-base text-ink">{created.message}</p>
            ) : (
              <>
                <Field
                  label="Name this change"
                  htmlFor="rollout-name"
                  hint="You will see this in your price journal and in every email about it."
                  optional
                >
                  <Input
                    id="rollout-name"
                    value={name}
                    placeholder={defaultName}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>

                <DetailList>
                  <DetailRow label="Products that will change">
                    {countOf(included.length, "product")}
                    {forecast.products.length !== included.length
                      ? ` (${forecast.products.length - included.length} left out)`
                      : ""}
                  </DetailRow>
                  <DetailRow label="New prices">
                    {describeChange(kind, direction, parsed.value ?? 0)}
                  </DetailRow>
                  <DetailRow label="Steps">
                    {stages.length === 1
                      ? "One step — a single product, so we watch time instead of cohorts"
                      : stages
                          .map((stage) => `${Math.round(stage.fraction * 100)}%`)
                          .join(" → ")}
                  </DetailRow>
                  <DetailRow label="Held between steps">
                    {stages[0] ? countOf(stages[0].hold_days, "day") : "—"}
                  </DetailRow>
                </DetailList>

                <div className="rounded-lg border border-border bg-surface-muted px-4 py-3">
                  <p className="text-sm font-medium text-ink">Your limit, as it will be recorded</p>
                  <p className="mt-1 max-w-prose text-base text-ink-muted">
                    {guardrailSentence(draft)}
                  </p>
                </div>
              </>
            )}
          </CardBody>
          <CardFooter>
            {created ? (
              <>
                <span>No Shopify price was changed.</span>
                <TextLink href={created.rolloutId ? `/rollouts/${created.rolloutId}` : "/rollouts"}>
                  {created.rolloutId ? "Review and confirm the draft" : "See the demo rollouts"}
                </TextLink>
              </>
            ) : (
              <>
                <span>
                  Creating this draft does not write to Shopify. Starting it requires a separate confirmation.
                </span>
                <Button
                  variant="primary"
                  loading={creating}
                  loadingLabel="Setting up your price change"
                  onClick={async () => {
                    setCreating(true);
                    const proposal = {
                      name: name.trim() || defaultName,
                      variant_gids: gids,
                      change: change!,
                      guardrails: toGuardrails(draft),
                    };
                    let reply:
                      | { ok: true; rollout_id: string | null; message: string }
                      | { ok: false; message: string };
                    try {
                      if (demoMode) {
                        // The public demo never persists a rollout. Keeping this
                        // acknowledgement local avoids a needless Server Action
                        // request after the forecast while preserving the
                        // important guarantee: no adapter or Shopify write runs.
                        reply = {
                          ok: true,
                          rollout_id: null,
                          message:
                            "This is the demo store, so no draft was stored and nothing was sent to Shopify. On a connected store, Priceflag would freeze today's prices in a draft and wait for a separate confirmation before writing anything.",
                        };
                      } else {
                        const body = await merchantJson<{ rollout: { id: string } }>("/api/rollouts", {
                          method: "POST",
                          body: JSON.stringify({ contract_version: CONTRACT_VERSION, ...proposal }),
                        });
                        reply = {
                          ok: true,
                          rollout_id: body.rollout.id,
                          message:
                            "The draft is saved with today's prices, forecast, rollout stages, and pause limits. Review it before confirming the first Shopify write.",
                        };
                      }
                    } catch (cause) {
                      reply = {
                        ok: false,
                        message: cause instanceof Error ? cause.message : "The draft was not created. Try again.",
                      };
                    }
                    setCreating(false);
                    toast({
                      tone: reply.ok ? "success" : "error",
                      title: reply.ok ? "Draft created — no prices changed" : "That did not go through",
                      description: reply.message,
                    });
                    if (reply.ok) {
                      setCreated({ message: reply.message, rolloutId: reply.rollout_id });
                    }
                  }}
                >
                  Create draft
                </Button>
              </>
            )}
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}

function Segmented({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      <div
        className="inline-flex rounded-md border border-border-strong p-0.5"
        role="group"
        aria-label={label}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "h-8 rounded-[0.3rem] px-3 text-base font-medium outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-focus",
                active ? "bg-accent text-accent-ink" : "text-ink-muted hover:bg-surface-muted",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type ParsedAmount = { value: number | null; error: string | null };

function parseAmount(
  kind: "percent" | "absolute",
  direction: "up" | "down",
  raw: string,
): ParsedAmount {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: "Enter how much to change prices by." };
  const sign = direction === "up" ? 1 : -1;

  if (kind === "percent") {
    const percent = Number(trimmed.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(percent) || percent <= 0) {
      return { value: null, error: "Enter a percentage above zero, like 5." };
    }
    // The contract caps change_pct at -90..400.
    if (direction === "down" && percent > 90) {
      return { value: null, error: "That would take prices to almost nothing. Try 90% or less." };
    }
    if (direction === "up" && percent > 400) {
      return { value: null, error: "That is more than five times the price." };
    }
    return { value: sign * percent, error: null };
  }

  const cents = parseMoneyToCents(trimmed);
  if (cents === null || cents <= 0) {
    return { value: null, error: "Enter an amount above zero, like 2.50." };
  }
  return { value: sign * cents, error: null };
}

function describeChange(
  kind: "percent" | "absolute",
  direction: "up" | "down",
  value: number,
): string {
  if (kind === "percent") {
    const points = Math.abs(value);
    return `${formatPct(points, Number.isInteger(points) ? 0 : 1)} ${direction === "up" ? "higher" : "lower"}`;
  }
  return `${formatMoney(Math.abs(value))} ${direction === "up" ? "more" : "less"}`;
}
