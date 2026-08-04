import type { StoreAdapter } from '../adapters/types';
import { healthSentence, readingSentence, rolloutHealth, verdictForReading } from '../engine/readings';
import type { Rollout } from '../types';

/** Build the one authoritative rollout view used by detail, list, and live APIs. */
export async function buildRolloutView(adapter: StoreAdapter, rollout: Rollout) {
  const [variants, readings, events] = await Promise.all([
    adapter.getRolloutVariants(rollout.id),
    adapter.listRolloutReadings(rollout.id),
    adapter.listRolloutEvents(rollout.id),
  ]);
  const included = variants.filter((variant) => !variant.excluded);
  const liveCount = included.filter(
    (variant) => variant.applied_at !== null && variant.reverted_at === null,
  ).length;
  const latest = readings[readings.length - 1];
  const health = rolloutHealth(rollout.status, readings);

  return {
    rollout,
    live: {
      stage_index: rollout.current_stage,
      variants_live: liveCount,
      variants_total: included.length,
      fraction: included.length === 0 ? 0 : Number((liveCount / included.length).toFixed(4)),
    },
    variants,
    readings: readings.map((reading) => ({
      ...reading,
      verdict: verdictForReading(reading),
      sentence: readingSentence(reading),
    })),
    events,
    health,
    health_sentence: healthSentence(
      health,
      latest?.decision ?? 'none',
      latest?.breach_streak ?? 0,
    ),
    can: {
      confirm: rollout.status === 'draft',
      // Keep undo available after an acknowledgement-loss window or completion.
      rollback: ['running', 'paused', 'completed'].includes(rollout.status),
      pause: rollout.status === 'running' || rollout.status === 'scheduled',
      cancel: rollout.status === 'draft' || rollout.status === 'scheduled',
      // Beta resume is intentionally absent: external edits require a new plan
      // or a merchant-confirmed rollback, never an implicit overwrite.
      resume: false,
    },
  };
}

export type RolloutView = Awaited<ReturnType<typeof buildRolloutView>>;
