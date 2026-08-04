/**
 * `POST /api/kill-switch` — undo everything Priceflag ever changed (R21).
 *
 * One action, store-wide. It engages the switch first and reverts second, so that
 * even if the reverting half fails partway, nothing can write a new price in the
 * meantime.
 *
 * `DELETE` releases it. Releasing does not re-apply anything: rollouts stay ended,
 * because a merchant who pulled this cord wants the prices back, not the change
 * resumed behind their back.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { getMode, isProductionRuntime } from '@/lib/config';
import { rollbackRollout, verifyRollback } from '@/lib/pricing/writer';
import { AdminGraphqlClient } from '@/lib/shopify/client';
import { credentialsFromShop, staticShopDomain } from '@/lib/shopify/credentials';
import { notify } from '@/lib/notify';
import { resolveShopFromRequestOrCookie } from '@/lib/shopify/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Sentinel: the request is unidentified in production and must be refused. */
const UNAUTHENTICATED = Symbol('unauthenticated');

function unauthenticatedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'unauthenticated',
        message: 'Open Priceflag from your Shopify admin to use the kill switch.',
        retryable: false,
        details: null,
      },
    },
    { status: 401 },
  );
}

function resolveShopDomain(request: NextRequest): string | null | typeof UNAUTHENTICATED {
  try {
    return resolveShopFromRequestOrCookie(request).shopDomain;
  } catch {
    // This route writes prices, so in real-mode production an unidentified
    // request is refused outright. Demo mode and local dev keep the static-shop
    // fallback so the switch stays exercisable without an admin iframe.
    if (getMode() === 'real' && isProductionRuntime()) return UNAUTHENTICATED;
    return staticShopDomain();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const adapter = getAdapter();
  const shopDomain = resolveShopDomain(request);
  if (shopDomain === UNAUTHENTICATED) return unauthenticatedResponse();
  const shop = shopDomain === null ? null : await adapter.getShopByDomain(shopDomain);

  if (shop === null) {
    return NextResponse.json(
      { error: { code: 'shop_not_connected', message: 'No connected store.', retryable: false, details: null } },
      { status: 404 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { reason?: string };

  // Engage FIRST. If the revert below fails halfway, no writer can add to the
  // problem while a human works out what happened.
  const engaged = await adapter.updateShop(shop.id, {
    kill_switch_engaged_at: new Date().toISOString(),
    kill_switch_reason: body.reason ?? 'Store-wide undo requested by the merchant.',
  });

  const client = new AdminGraphqlClient(credentialsFromShop(engaged));
  const context = { adapter, client, shop: engaged };

  let restored = 0;
  let failed = 0;
  const mismatched: unknown[] = [];

  // Every rollout that ever put a price live, not only the running ones.
  for (const rollout of await adapter.listRollouts(shop.id)) {
    const undo = await rollbackRollout(context, rollout, {
      reason: 'Store-wide undo (kill switch).',
      source: 'kill_switch',
      actor: 'merchant',
    });
    restored += undo.applied;
    failed += undo.failed;

    if (undo.applied > 0 || undo.skipped_noop > 0) {
      const check = await verifyRollback(context, rollout);
      mismatched.push(...check.mismatched);

      if (rollout.status === 'running' || rollout.status === 'paused' || rollout.status === 'scheduled') {
        await adapter.updateRollout(rollout.id, {
          status: 'rolled_back',
          ended_at: new Date().toISOString(),
          ended_reason: 'kill_switch',
        });
      }
      await adapter.appendRolloutEvent({
        rollout_id: rollout.id,
        shop_id: shop.id,
        type: 'kill_switch',
        actor: 'merchant',
        message: 'Store-wide undo: every price this rollout changed has been put back.',
        data: { restored: undo.applied, failed: undo.failed },
      });
    }
  }

  await notify({ kind: 'kill_switch', shop: engaged, detail: restored });

  const ok = failed === 0 && mismatched.length === 0;
  return NextResponse.json(
    {
      ok,
      affected_skus: restored,
      message: ok
        ? `Every price Priceflag changed is back to what it was (${restored} product${restored === 1 ? '' : 's'}).`
        : `Restored ${restored} price${restored === 1 ? '' : 's'}, but ${failed + mismatched.length} could not be confirmed. Your price journal has the before-and-after for every one.`,
      restored,
      failed,
      unverified: mismatched.length,
      kill_switch_engaged_at: engaged.kill_switch_engaged_at,
    },
    { status: ok ? 200 : 207 },
  );
}

/** Release the switch. Deliberately does not resume anything. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const adapter = getAdapter();
  const shopDomain = resolveShopDomain(request);
  if (shopDomain === UNAUTHENTICATED) return unauthenticatedResponse();
  const shop = shopDomain === null ? null : await adapter.getShopByDomain(shopDomain);

  if (shop === null) {
    return NextResponse.json(
      { error: { code: 'shop_not_connected', message: 'No connected store.', retryable: false, details: null } },
      { status: 404 },
    );
  }

  await adapter.updateShop(shop.id, { kill_switch_engaged_at: null, kill_switch_reason: null });
  return NextResponse.json({
    ok: true,
    affected_skus: 0,
    message: 'Priceflag can change prices again. Nothing was resumed — start a new rollout when you are ready.',
  });
}
