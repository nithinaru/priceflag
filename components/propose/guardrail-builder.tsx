"use client";

import { cn } from "@/components/cn";
import { Card, CardBody, CardHeader, Notice } from "@/components/ui";
import { countOf, formatUnits } from "@/components/format";
import {
  CONTRACT_VERSION,
  DEFAULT_MIN_EXPECTED_UNITS,
  type GuardrailMetric,
  type Guardrails,
} from "@/lib/contracts";

/**
 * The guardrail builder (R10).
 *
 * It is one sentence with editable blanks, not a form, because that is the only
 * shape in which a merchant can read back what they have agreed to. The string
 * they read is the string that gets stored — `guardrails.rules[].sentence` is
 * persisted verbatim and never regenerated, so this component is the author of
 * the record, not a view of it.
 *
 * The live preview translates the percentage into units, which is the number a
 * merchant actually recognises: "a day below 25 units" means something,
 * "35% below expected" does not.
 */

export type GuardrailDraft = {
  metric: GuardrailMetric;
  thresholdPct: number;
  consecutiveDays: number;
};

export const DEFAULT_GUARDRAIL_DRAFT: GuardrailDraft = {
  metric: "units",
  thresholdPct: 35,
  consecutiveDays: 2,
};

const METRIC_WORDS: Record<GuardrailMetric, string> = {
  units: "units sold",
  revenue: "revenue",
  profit: "profit",
};

export function guardrailSentence(draft: GuardrailDraft): string {
  const days = draft.consecutiveDays === 1 ? "1 day" : `${draft.consecutiveDays} days`;
  return `If daily ${METRIC_WORDS[draft.metric]} fall more than ${draft.thresholdPct}% below what we expect for ${days} in a row, pause the change and email me.`;
}

/** The contract object, with the sentence exactly as it was on screen. */
export function toGuardrails(draft: GuardrailDraft): Guardrails {
  return {
    contract_version: CONTRACT_VERSION,
    auto_rollback: false,
    rules: [
      {
        id: `${draft.metric}-${draft.thresholdPct}-${draft.consecutiveDays}d`,
        metric: draft.metric,
        comparison: "below_expected_pct",
        threshold_pct: draft.thresholdPct,
        consecutive_days: draft.consecutiveDays,
        scope: "rollout",
        action: "pause",
        min_expected_units: DEFAULT_MIN_EXPECTED_UNITS,
        sentence: guardrailSentence(draft),
      },
    ],
  };
}

export function GuardrailBuilder({
  draft,
  onChange,
  baselineUnitsPerDay,
  hasCogs,
}: {
  draft: GuardrailDraft;
  onChange: (draft: GuardrailDraft) => void;
  baselineUnitsPerDay: number;
  /** Profit cannot be judged when any product has no cost saved (R3). */
  hasCogs: boolean;
}) {
  const trigger = baselineUnitsPerDay * (1 - draft.thresholdPct / 100);
  const tooQuiet = baselineUnitsPerDay < DEFAULT_MIN_EXPECTED_UNITS;

  return (
    <Card>
      <CardHeader
        title="When should we stop?"
        description="Write the limit now, while you are calm about it. We check every day and pause for your decision when it is crossed."
      />
      <CardBody className="space-y-5">
        <p className="max-w-2xl text-md leading-relaxed text-ink">
          If daily{" "}
          <InlineSelect
            label="what to watch"
            value={draft.metric}
            onChange={(value) => onChange({ ...draft, metric: value as GuardrailMetric })}
            options={[
              { value: "units", label: "units sold" },
              { value: "revenue", label: "revenue" },
              {
                value: "profit",
                label: hasCogs ? "profit" : "profit (needs costs)",
                disabled: !hasCogs,
              },
            ]}
          />{" "}
          fall more than{" "}
          <InlineNumber
            label="how far below expected, as a percentage"
            value={draft.thresholdPct}
            min={5}
            max={90}
            step={5}
            suffix="%"
            onChange={(value) => onChange({ ...draft, thresholdPct: value })}
          />{" "}
          below what we expect for{" "}
          <InlineSelect
            label="how many days in a row"
            value={String(draft.consecutiveDays)}
            onChange={(value) => onChange({ ...draft, consecutiveDays: Number(value) })}
            options={[1, 2, 3, 4, 5].map((days) => ({
              value: String(days),
              label: days === 1 ? "1 day" : `${days} days`,
            }))}
          />{" "}
          in a row, <strong className="font-medium">pause the change and email me</strong>.
        </p>

        <div className="rounded-lg border border-border bg-surface-muted px-4 py-3">
          <h3 className="text-base font-semibold text-ink">What that means in practice</h3>
          {draft.metric === "units" ? (
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              You sell about{" "}
              <span className="font-medium text-ink">
                {formatUnits(baselineUnitsPerDay, 1)} units a day
              </span>{" "}
              across these products. On that basis we would act on a day below roughly{" "}
              <span className="font-medium text-ink">{formatUnits(trigger, 1)} units</span> — and
              only if it was also outside the expected range and happened{" "}
              {countOf(draft.consecutiveDays, "day")} in a row.
            </p>
          ) : (
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              We compare each day&rsquo;s {METRIC_WORDS[draft.metric]} against the range we expected
              for that day, and act only after {countOf(draft.consecutiveDays, "day")} in a row more
              than {draft.thresholdPct}% below it.
            </p>
          )}
          <p className="mt-2 max-w-prose text-sm text-ink-subtle">
            A day too quiet to judge — fewer than {DEFAULT_MIN_EXPECTED_UNITS} expected units —
            never counts on its own. A random zero is not evidence.
          </p>
        </div>

        <Notice tone="hold" title="Public beta: pause and ask">
          We stop the rollout from advancing and alert you. Prices already live stay live until you
          review the results and choose whether to continue or roll them back.
        </Notice>

        {tooQuiet ? (
          <Notice tone="hold" title="These products sell too rarely for a daily limit to bite">
            At {formatUnits(baselineUnitsPerDay, 1)} units a day, most days will be too quiet to
            judge, so this limit may never fire. A longer run or a larger selection would give it
            something to measure.
          </Notice>
        ) : null}

        {draft.metric === "profit" && !hasCogs ? (
          <Notice tone="hold" title="Profit cannot be checked yet">
            Some of these products have no cost saved, so we would skip this limit rather than
            quietly treat it as passing. Add the missing costs, or watch units instead.
          </Notice>
        ) : null}
      </CardBody>
    </Card>
  );
}

function InlineSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <span className="relative inline-flex">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "cursor-pointer appearance-none rounded-md border border-dashed border-accent-border",
          "bg-accent-tint px-2 py-0.5 pr-6 text-md font-medium text-accent outline-none",
          "hover:border-accent focus-visible:ring-2 focus-visible:ring-focus",
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <span
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-accent"
        aria-hidden="true"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m6 9.5 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}

function InlineNumber({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <span className="inline-flex items-baseline rounded-md border border-dashed border-accent-border bg-accent-tint pr-1.5 focus-within:border-accent">
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
        className="w-12 appearance-none border-0 bg-transparent px-2 py-0.5 text-md font-medium text-accent outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix ? <span className="text-md font-medium text-accent">{suffix}</span> : null}
    </span>
  );
}
