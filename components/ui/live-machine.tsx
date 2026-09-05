import type { JSX } from "react";
import { cn } from "@/components/cn";
import type { RolloutStatus } from "@/lib/types";

const BEAD_COUNT = 6;
const RUNNING_LIME = "#d8f24b";
const INK_NAVY = "#0d2168";
const HOLD_AMBER = "#875600";

const RUNNING_BEADS = Array.from({ length: BEAD_COUNT }, (_, index) =>
  index % 2 === 0 ? INK_NAVY : RUNNING_LIME,
);

const PAUSED_BEADS = Array.from({ length: BEAD_COUNT }, () => HOLD_AMBER);

function beadColors(mode: LiveMachineProps["mode"]): readonly string[] {
  return mode === "paused" ? PAUSED_BEADS : RUNNING_BEADS;
}

function flowClass(mode: LiveMachineProps["mode"]): string | undefined {
  switch (mode) {
    case "running":
    case "sync":
      return "live-machine-flow";
    case "rollback":
      return "live-machine-flow live-machine-flow--reverse";
    case "paused":
      return "live-machine-flow live-machine-flow--paused";
    case "draft":
      return undefined;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export type LiveMachineMode = "running" | "paused" | "rollback" | "sync" | "draft";

type LiveMachineProps = {
  mode: LiveMachineMode;
  /** 0 | 1 | 2 for cohort stages 25/50/all when mode is running/paused/rollback */
  stage?: 0 | 1 | 2;
  className?: string;
};

export function liveMachineModeForRollout(status: RolloutStatus): LiveMachineMode {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "rolled_back":
      return "rollback";
    case "draft":
    case "scheduled":
    case "completed":
    case "cancelled":
      return "draft";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function liveMachineStage(stageIndex: number): 0 | 1 | 2 {
  const clamped = Math.min(2, Math.max(0, stageIndex));
  if (clamped === 0) return 0;
  if (clamped === 1) return 1;
  return 2;
}

function BeadStrip({ colors }: { colors: readonly string[] }) {
  return (
    <>
      {colors.map((color, index) => (
        <span
          key={`a-${index}`}
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      ))}
      {colors.map((color, index) => (
        <span
          key={`b-${index}`}
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      ))}
    </>
  );
}

export function LiveMachine({
  mode,
  stage = 0,
  className,
}: LiveMachineProps): JSX.Element {
  const animated = mode !== "draft";
  const showCohort = mode === "running" || mode === "paused" || mode === "rollback";

  return (
    <div className={cn("inline-flex w-[7.5rem] flex-col gap-1", className)}>
      <div
        className="relative h-6 overflow-hidden rounded-full bg-surface-inset"
        aria-hidden="true"
      >
        {animated ? (
          <div
            className={cn(
              "flex h-full w-[200%] items-center gap-1.5 px-1.5",
              flowClass(mode),
            )}
          >
            <BeadStrip colors={beadColors(mode)} />
          </div>
        ) : null}
      </div>

      {showCohort ? (
        <div className="flex h-1 gap-0.5" aria-hidden="true">
          {[0, 1, 2].map((tick) => (
            <span
              key={tick}
              className={cn(
                "flex-1 rounded-full",
                tick === stage ? "bg-[#d8f24b]" : "bg-border",
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
