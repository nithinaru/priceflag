import { cn } from "@/components/cn";
import { countOf, formatDay } from "@/components/format";
import { IconCheck, IconClock, IconPause } from "@/components/ui/icons";
import type { Rollout, RolloutStage } from "@/components/mock/engine";
import { stageScopeLabel } from "@/components/domain/status";

/**
 * The staged rollout, as a stepper. A step is a set of products — never a share
 * of visitors (PRD §3: every visitor sees the same price). The copy says
 * "products" everywhere for exactly that reason.
 */
export function StageTimeline({ rollout }: { rollout: Rollout }) {
  const totalSkus = rollout.productIds.length;
  const paused = rollout.status === "paused_external";

  return (
    <ol className="space-y-0">
      {rollout.stages.map((stage, index) => {
        const isLast = index === rollout.stages.length - 1;
        const state = stageState(stage, paused);
        return (
          <li key={index} className="flex gap-3">
            <div className="flex flex-col items-center">
              <StageMarker state={state} />
              {!isLast ? (
                <div
                  className={cn(
                    "w-px flex-1",
                    state === "completed" ? "bg-live-border" : "bg-border",
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </div>
            <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-5")}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-base font-medium text-ink">
                  Step {index + 1} — {stageScopeLabel(stage.skuCount, totalSkus)}
                </span>
                <span className="text-sm text-ink-subtle">{stateLabel(state)}</span>
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">{stageSentence(stage, state)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

type StageVisualState = "completed" | "active" | "paused" | "pending" | "skipped";

function stageState(stage: RolloutStage, rolloutPaused: boolean): StageVisualState {
  if (stage.status === "active" && rolloutPaused) return "paused";
  if (stage.status === "active") return "active";
  if (stage.status === "completed") return "completed";
  if (stage.status === "skipped") return "skipped";
  return "pending";
}

function stateLabel(state: StageVisualState): string {
  switch (state) {
    case "completed":
      return "Done";
    case "active":
      return "Happening now";
    case "paused":
      return "Paused";
    case "skipped":
      return "Skipped";
    default:
      return "Not started";
  }
}

function stageSentence(stage: RolloutStage, state: StageVisualState): string {
  const hold = countOf(stage.holdDays, "day");
  switch (state) {
    case "completed":
      return stage.startedOn && stage.completedOn
        ? `New prices were live from ${formatDay(stage.startedOn)} to ${formatDay(stage.completedOn)}.`
        : "New prices were live for this step.";
    case "active":
      return stage.startedOn
        ? `New prices went live on ${formatDay(stage.startedOn)}. We watch orders for ${hold} before the next step.`
        : `We watch orders for ${hold} before the next step.`;
    case "paused":
      return "Waiting for you. Nothing will move until this is sorted out.";
    case "skipped":
      return "Skipped.";
    default:
      return `Starts once the step before it finishes, then holds for ${hold}.`;
  }
}

function StageMarker({ state }: { state: StageVisualState }) {
  const shared = "flex size-6 shrink-0 items-center justify-center rounded-full border";
  if (state === "completed") {
    return (
      <span className={cn(shared, "border-live-border bg-live-tint text-live")} aria-hidden="true">
        <IconCheck size={13} />
      </span>
    );
  }
  if (state === "active") {
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
