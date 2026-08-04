/** Durable rollout cleanup shared by uninstall delivery and OAuth reinstall. */

import type { StoreAdapter } from '../adapters/types';
import type { Shop } from '../types';

export const UNINSTALL_PAUSE_REASON =
  'Priceflag was uninstalled. Review and create a new rollout after reinstalling.';

export class UninstallCleanupBusyError extends Error {
  constructor(readonly rolloutId: string) {
    super(`rollout ${rolloutId} is busy during uninstall cleanup`);
    this.name = 'UninstallCleanupBusyError';
  }
}

/**
 * Make every row that could transition into a Shopify write inert.
 *
 * The caller must stamp `shop.uninstalled_at` first. That shop-level flag is
 * the defense while a lease is busy; this function then makes the stop durable
 * on each rollout. Safe to retry after a partial attempt.
 */
export async function stopRolloutsForUninstall(
  adapter: StoreAdapter,
  shop: Shop,
  stoppedAt: string,
): Promise<void> {
  for (const rollout of await adapter.listRollouts(shop.id, ['draft', 'running', 'scheduled'])) {
    const locked = await adapter.withRolloutLock(rollout.id, async () => {
      const fresh = await adapter.getRollout(rollout.id);
      if (fresh === null || fresh.shop_id !== shop.id) {
        throw new Error('rollout disappeared during uninstall cleanup');
      }
      if (fresh.status === 'draft') {
        await adapter.updateRollout(fresh.id, {
          status: 'cancelled',
          ended_at: stoppedAt,
          ended_reason: 'cancelled',
          paused_reason: null,
        });
        await adapter.appendRolloutEvent({
          rollout_id: fresh.id,
          shop_id: shop.id,
          type: 'cancelled',
          actor: 'system',
          message: 'Cancelled because Priceflag was uninstalled before this draft started.',
          data: { action: 'app_uninstalled', previous_status: 'draft' },
        });
        return;
      }
      if (fresh.status !== 'running' && fresh.status !== 'scheduled') return;
      await adapter.updateRollout(fresh.id, {
        status: 'paused',
        paused_reason: UNINSTALL_PAUSE_REASON,
      });
      await adapter.appendRolloutEvent({
        rollout_id: fresh.id,
        shop_id: shop.id,
        type: 'note',
        actor: 'system',
        message: 'Paused because Priceflag was uninstalled. Reinstalling will not resume this change.',
        data: { action: 'app_uninstalled', previous_status: fresh.status },
      });
    });
    if (!locked.acquired) throw new UninstallCleanupBusyError(rollout.id);
  }

  // If a prior attempt changed status but failed while appending the event,
  // retry repairs the audit trail before uninstall/reinstall can complete.
  for (const paused of await adapter.listRollouts(shop.id, ['paused'])) {
    if (paused.paused_reason !== UNINSTALL_PAUSE_REASON) continue;
    const events = await adapter.listRolloutEvents(paused.id);
    if (events.some((event) => event.type === 'note' && event.data.action === 'app_uninstalled')) continue;
    await adapter.appendRolloutEvent({
      rollout_id: paused.id,
      shop_id: shop.id,
      type: 'note',
      actor: 'system',
      message: 'Paused because Priceflag was uninstalled. Reinstalling will not resume this change.',
      data: { action: 'app_uninstalled', previous_status: 'unknown_after_retry' },
    });
  }
}
