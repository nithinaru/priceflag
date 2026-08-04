import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { merchantErrorResponse, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { buildRolloutView } from '@/lib/api/rollout-view';
import { addDays } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Store-wide operational view for the token tenant. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const [rollouts, missingCosts] = await Promise.all([
      adapter.listRollouts(shop.id, ['running', 'paused']),
      // We only need the exact count; asking for one row avoids both a large
      // payload and Supabase's response-row cap on stores with big catalogs.
      adapter.listProducts(shop.id, { only_repriceable: true, missing_cogs: true, limit: 1 }),
    ]);
    const views = await Promise.all(rollouts.map((rollout) => buildRolloutView(adapter, rollout)));

    return NextResponse.json(
      {
        anything_live: views.some((view) => view.live.variants_live > 0),
        kill_switch_engaged: shop.kill_switch_engaged_at !== null,
        skus_holding_priceflag_price: views.reduce(
          (total, view) => total + view.live.variants_live,
          0,
        ),
        rollouts: views.map((view) => {
          const latest = view.readings[view.readings.length - 1];
          return {
            id: view.rollout.id,
            name: view.rollout.name,
            status: view.rollout.status,
            stage_index: view.live.stage_index,
            stage_count: view.rollout.stages.length,
            fraction_live: view.live.fraction,
            variants_live: view.live.variants_live,
            variants_total: view.live.variants_total,
            health: view.health,
            health_sentence: view.health_sentence,
            next_decision_day: latest === undefined ? null : addDays(latest.day, 1),
            can: view.can,
          };
        }),
        paused_for_external_change: views
          .filter(
            (view) =>
              view.rollout.status === 'paused' &&
              view.events.some((event) => event.type === 'paused_external_change'),
          )
          .map((view) => view.rollout.id),
        products_missing_cost: missingCosts.total,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
