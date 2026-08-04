import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, MerchantApiError, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { healthSentence, readingSentence, rolloutHealth, verdictForReading } from '@/lib/engine/readings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const { id } = await context.params;
    const rollout = await adapter.getRollout(id);

    // A rollout belonging to another shop is deliberately indistinguishable
    // from an unknown id. Never load its child rows before this ownership check.
    if (rollout === null || rollout.shop_id !== shop.id) {
      throw new MerchantApiError('rollout_not_found', 'That rollout was not found.', 404);
    }

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

    return NextResponse.json(
      {
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
          // Do not gate undo on applied_at. Shopify may have accepted a write
          // whose acknowledgement never reached us, so every live/finished
          // rollout keeps the safe undo action available.
          rollback: ['running', 'paused', 'completed'].includes(rollout.status),
          pause: rollout.status === 'running' || rollout.status === 'scheduled',
          cancel: rollout.status === 'draft' || rollout.status === 'scheduled',
          // No beta resume endpoint exists: a paused rollout needs an explicit
          // rollback or a newly confirmed draft, never an implied action.
          resume: false,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
