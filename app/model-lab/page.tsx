import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FounderLab } from "@/components/demo/founder-lab";
import { RolloutSimulator, type StoreBenchmark } from "@/components/demo/rollout-simulator";
import { Badge, PageHeader, PageSection } from "@/components/ui";
import { isDemoMode } from "@/lib/config";
import { DEFAULT_FOUNDER_LAB_INPUT, runFounderLab } from "@/lib/demo/founder-lab";
import { STORE_PRESETS } from "@/lib/demo/portfolio";
import PORTFOLIO_EVAL from "@/lib/demo/portfolio-eval.json";
import { DEFAULT_SIMULATION_INPUT, runRolloutSimulation } from "@/lib/demo/simulate";

export const metadata: Metadata = {
  title: "Founder Lab",
};

export const dynamic = "force-dynamic";

export default async function ModelLabPage() {
  if (!isDemoMode()) notFound();

  const initialInput = { ...DEFAULT_FOUNDER_LAB_INPUT };
  const initialResult = runFounderLab(initialInput);
  const initialSimulation = await runRolloutSimulation({ ...DEFAULT_SIMULATION_INPUT });
  const benchmarks = ((PORTFOLIO_EVAL as { stores?: Record<string, StoreBenchmark> }).stores ?? {}) as Record<
    string,
    StoreBenchmark
  >;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Founder Lab"
        meta={<Badge tone="live" dot>No Shopify writes</Badge>}
      />
      <PageSection title="Forecast a scenario">
        <p className="max-w-prose text-base text-ink-muted">
          Type in a pricing scenario and watch the real forecast and rollout planner work through it.
        </p>
        <FounderLab initialInput={initialInput} initialResult={initialResult} />
      </PageSection>
      <PageSection title="Run a whole rollout">
        <p className="max-w-prose text-base text-ink-muted">
          Six simulated stores with a hidden answer key. Tune the guardrail, break Shopify, shock
          demand, and see what the production evaluator does.
        </p>
        <RolloutSimulator presets={STORE_PRESETS} initialResult={initialSimulation} benchmarks={benchmarks} />
      </PageSection>
    </div>
  );
}
