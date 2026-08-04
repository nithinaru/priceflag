import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { parseProposal, prepareForecast } from '@/lib/api/proposals';
import { DEFAULT_HORIZON_DAYS } from '@/lib/contracts';
import { normalizeStages, planRolloutVariants } from '@/lib/engine/rollout';
import { exclusionReasonFor, type RolloutCreate } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const proposal = parseProposal(await readJson(request));
    if (proposal.guardrails === undefined) {
      throw new MerchantApiError(
        'guardrails_required',
        'Choose the safety limits for this rollout before creating it.',
        400,
      );
    }
    if (proposal.guardrails.auto_rollback) {
      throw new MerchantApiError(
        'automatic_rollback_disabled',
        'Automatic rollback is disabled during the public beta. Use pause-and-alert guardrails instead.',
        422,
      );
    }

    const { forecast, products } = await prepareForecast(adapter, shop, proposal);
    const eligibleCount = products.filter((product) => exclusionReasonFor(product) === null).length;
    const stages = normalizeStages(proposal.stages, eligibleCount);
    const rolloutId = randomUUID();
    const baselineUnits = new Map(
      forecast.products.map((product) => [product.variant_gid, product.baseline_units_per_day]),
    );
    const variants = planRolloutVariants({
      rolloutId,
      shopId: shop.id,
      products,
      change: proposal.change,
      stages,
      baselineUnitsPerDay: baselineUnits,
    });

    const input: RolloutCreate & { id: string } = {
      id: rolloutId,
      shop_id: shop.id,
      name: proposal.name?.trim() || `Price change · ${new Date().toISOString().slice(0, 10)}`,
      status: 'draft',
      change_type: proposal.change.type,
      change_pct: proposal.change.type === 'percent' ? (proposal.change.percent ?? null) : null,
      change_absolute_cents:
        proposal.change.type === 'absolute' ? (proposal.change.absolute_cents ?? null) : null,
      rounding: proposal.change.rounding ?? 'none',
      horizon_days: proposal.horizon_days ?? DEFAULT_HORIZON_DAYS,
      stages,
      current_stage: -1,
      stage_entered_at: null,
      guardrails: proposal.guardrails,
      forecast,
      scheduled_start_at: proposal.scheduled_start_at ?? null,
      started_at: null,
      ended_at: null,
      ended_reason: null,
      paused_reason: null,
      notify_emails: proposal.notify_emails ?? shop.notify_emails,
      created_by: 'merchant',
    };

    const created = await adapter.createDraftRollout(input, variants);

    return NextResponse.json(
      {
        rollout: created.rollout,
        variants: {
          included: created.variants.filter((variant) => !variant.excluded).length,
          excluded: created.variants.filter((variant) => variant.excluded).length,
        },
        forecast,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}
