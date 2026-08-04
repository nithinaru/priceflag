import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { MerchantApiError, merchantErrorResponse, readJson, resolveAuthenticatedShop } from '@/lib/api/merchant';
import { parseProposal, prepareForecast } from '@/lib/api/proposals';
import { DEFAULT_HORIZON_DAYS } from '@/lib/contracts';
import { normalizeStages, planRolloutVariants } from '@/lib/engine/rollout';
import { buildRolloutView } from '@/lib/api/rollout-view';
import { exclusionReasonFor, type RolloutCreate, type RolloutStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES: readonly RolloutStatus[] = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'rolled_back',
  'cancelled',
];

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const requested = new URL(request.url).searchParams.getAll('status');
    const invalid = requested.find((value) => !STATUSES.includes(value as RolloutStatus));
    if (invalid !== undefined) {
      throw new MerchantApiError('invalid_rollout_status', `“${invalid}” is not a rollout status.`, 400);
    }
    const rollouts = await adapter.listRollouts(
      shop.id,
      requested.length === 0 ? undefined : (requested as RolloutStatus[]),
    );
    const items = await Promise.all(rollouts.map((rollout) => buildRolloutView(adapter, rollout)));
    return NextResponse.json(
      { items, total: items.length },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    if (shop.kill_switch_engaged_at !== null) {
      throw new MerchantApiError(
        'kill_switch_engaged',
        'Finish the store-wide undo and explicitly re-enable price changes before creating another rollout.',
        409,
      );
    }
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

    // Forecasting can take long enough for a store-wide stop to be engaged
    // after authentication. Re-read immediately before committing the draft so
    // the UI cannot queue new work behind an emergency stop.
    const currentShop = await adapter.getShop(shop.id);
    if (currentShop === null || currentShop.uninstalled_at !== null) {
      throw new MerchantApiError(
        'shop_not_connected',
        'This store is no longer connected to Priceflag.',
        409,
      );
    }
    if (currentShop.kill_switch_engaged_at !== null) {
      throw new MerchantApiError(
        'kill_switch_engaged',
        'Finish the store-wide undo and explicitly re-enable price changes before creating another rollout.',
        409,
      );
    }

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
