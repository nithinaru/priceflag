import { cn } from "@/components/cn";
import { countOf, formatDay } from "@/components/format";
import { IconCheck, IconClock, IconPause } from "@/components/ui/icons";
import { stageScopeLabel } from "@/components/domain/status";
import type { Rollout, RolloutVariant } from "@/lib/types";

/**
 * The staged rollout, as a stepper.
 *
 * A step is a set of **products**, never a share of visitors — that is the
 * product's load-bearing constraint (PRD §3), so the copy says "products"
 * everywhere and the stage `fraction` is only ever rendered as a count.
 */
export function StageTimeline({
  rollout,
  variants,
}: {
  rollout: Rollout;
  variants: readonly RolloutVariant[];
}) {
  const included = variants.filter((variant) => !variant.excluded);
  const paused = rollout.status === "paused";
  const endedEarly = rollout.status === "rolled_back" || rollout.status === "cancelled";

  return (
    <ol className="space-y-0">
      {rollout.stages.map((stage, index) => {
        const isLast = index === rollout.stages.length - 1;
        const countAtStage = included.filter((variant) => variant.cohort_stage <= index).length;
        const state = stageState(index, rollout.current_stage, paused, endedEarly);
        const enteredOn = included.find(
          (variant) => variant.cohort_stage === index && variant.applied_at !== null,
        )?.applied_at;

        return (
          <li key={stage.index} className="flex gap-3">
            <div className="flex flex-col items-center">
              <StageMarker state={state} />
              {!isLast ? (
                <div
                  className={cn(
                    "w-px flex-1",
                    state === "done" ? "bg-live-border" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </div>
            <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-5")}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-base font-medium text-ink">
                  Step {index + 1} — {stageScopeLabel(countAtStage, included.length)}
                </span>
                <span className="text-sm text-ink-subtle">{stateLabel(state)}</span>
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">
                {stageSentence(state, stage.hold_days, enteredOn ?? null)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

type StageVisualState = "done" | "current" | "paused" | "pending" | "stopped";

function stageState(
  index: number,
  currentStage: number,
  paused: boolean,
  endedEarly: boolean,
): StageVisualState {
  if (index < currentStage) return "done";
  if (index === currentStage) {
    if (endedEarly) return "stopped";
    if (paused) return "paused";
    return "current";
  }
  return endedEarly ? "stopped" : "pending";
}

function stateLabel(state: StageVisualState): string {
  switch (state) {
    case "done":
      return "Done";
    case "current":
      return "Happening now";
    case "paused":
      return "Paused";
    case "stopped":
      return "Never happened";
    default:
      return "Not started";
  }
}

function stageSentence(
  state: StageVisualState,
  holdDays: number,
  enteredOn: string | null,
): string {
  const hold = countOf(holdDays, "day");
  switch (state) {
    case "done":
      return enteredOn
        ? `New prices went live on ${formatDay(enteredOn)} and held up for ${hold}.`
        : `New prices held up for ${hold}.`;
    case "current":
      return enteredOn
        ? `New prices went live on ${formatDay(enteredOn)}. We watch orders for ${hold} before the next step.`
        : `We watch orders for ${hold} before the next step.`;
    case "paused":
      return "Waiting for you. Nothing will move until this is sorted out.";
    case "stopped":
      return "This step never ran.";
    default:
      return `Starts once the step before it holds up, then watches for ${hold}.`;
  }
}

function StageMarker({ state }: { state: StageVisualState }) {
  const shared = "flex size-6 shrink-0 items-center justify-center rounded-full border";
  if (state === "done") {
    return (
      <span className={cn(shared, "border-live-border bg-live-tint text-live")} aria-hidden="true">
        <IconCheck size={13} />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className={cn(shared, "border-live bg-live text-white")} aria-hidden="true">
        <IconClock size={13} />
      </span>
    );
  }
  if (state === "paused") {
    return (
      <span className={cn(shared, "border-hold-border bg-hold-tint text-hold")} aria-hidden="true">
        <IconPause size={13} />
      </span>
    );
  }
  return (
    <span
      className={cn(shared, "border-border bg-surface-muted text-ink-subtle")}
      aria-hidden="true"
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}
