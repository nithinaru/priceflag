/**
 * Email notifications (R19).
 *
 * Plain language, one thing per email, and the subject line carries the news —
 * merchants read these on a phone and most will never open the body. An
 * auto-rollback email in particular has to be immediately legible: something was
 * undone, automatically, and here is what it was.
 *
 * Sending is best-effort by design. A failed email must never fail an
 * auto-rollback: the prices are already restored, and throwing here would make
 * the evaluator look like it failed when it did exactly the right thing.
 */

import { env } from '../config';
import { formatCents } from '../money';
import type { Rollout, Shop } from '../types';

export type NotificationKind =
  | 'started'
  | 'stage_advanced'
  | 'breach'
  | 'auto_rollback'
  | 'manual_rollback'
  | 'completed'
  | 'paused_external'
  | 'kill_switch';

export interface Notification {
  kind: NotificationKind;
  shop: Shop;
  rollout?: Rollout;
  /** Count, stage number — whatever the sentence needs. */
  detail?: number;
  reason?: string;
}

export type Notifier = (notification: Notification) => Promise<void>;

interface Composed {
  subject: string;
  body: string;
}

export function compose(notification: Notification): Composed {
  const name = notification.rollout?.name ?? 'your price change';
  const store = notification.shop.name ?? notification.shop.shop_domain;

  switch (notification.kind) {
    case 'started':
      return {
        subject: `"${name}" is live on ${notification.detail ?? 0} products`,
        body:
          `The first group of products now has the new price.\n\n` +
          `We will check the results every day and let you know before anything else changes. ` +
          `You can undo this at any time from the rollout page.`,
      };

    case 'stage_advanced':
      return {
        subject: `"${name}" moved to stage ${notification.detail ?? 2}`,
        body:
          `Results held up, so the new price is now live on more of the products you selected.\n\n` +
          `Nothing needs doing. We are still watching, and it still reverts automatically if the numbers drop.`,
      };

    case 'breach':
      return {
        subject: `"${name}" is paused — results dropped`,
        body:
          `${notification.reason ?? 'Sales came in below the range you set as acceptable.'}\n\n` +
          `Nothing has been changed back yet, because you asked to be told rather than have it undone ` +
          `automatically. Open the rollout to revert it or let it continue.`,
      };

    case 'auto_rollback':
      return {
        // The single most important subject line in the product.
        subject: `"${name}" was reverted automatically`,
        body:
          `${notification.reason ?? 'Sales fell below the range you set as acceptable.'}\n\n` +
          `Every price this change touched — ${notification.detail ?? 0} of them — has been put back to what ` +
          `it was before, and we checked each one against your store to make sure.\n\n` +
          `Nothing is left to do. The full before-and-after is in your price journal.`,
      };

    case 'manual_rollback':
      return {
        subject: `"${name}" was reverted`,
        body: `You reverted this change. All ${notification.detail ?? 0} prices are back to what they were.`,
      };

    case 'completed':
      return {
        subject: `"${name}" finished`,
        body:
          `The new prices are live on everything you selected, and results stayed inside the expected range ` +
          `the whole way.\n\nWe will send a summary of what actually happened once there is enough data to compare.`,
      };

    case 'paused_external':
      return {
        subject: `"${name}" is paused — a price changed outside Priceflag`,
        body:
          `${notification.detail ?? 1} price in this rollout was changed somewhere other than Priceflag.\n\n` +
          `We stopped rather than overwrite it, because results would no longer mean what we predicted. ` +
          `Open the rollout to resume or revert.`,
      };

    case 'kill_switch':
      return {
        subject: `Everything Priceflag changed on ${store} has been undone`,
        body: `All ${notification.detail ?? 0} prices are back to what they were before Priceflag changed them.`,
      };

    default:
      return { subject: `Update on ${name}`, body: 'There is an update on your price change.' };
  }
}

function recipients(notification: Notification): string[] {
  const list = notification.rollout?.notify_emails?.length
    ? notification.rollout.notify_emails
    : notification.shop.notify_emails;
  if (list.length > 0) return list;
  return notification.shop.email === null ? [] : [notification.shop.email];
}

/**
 * Send via Resend. A no-op when unconfigured, so demo mode and tests need no key.
 */
export const notify: Notifier = async (notification) => {
  const apiKey = env('RESEND_API_KEY');
  const from = env('RESEND_FROM') ?? 'Priceflag <onboarding@resend.dev>';
  const to = recipients(notification);

  if (apiKey === undefined || to.length === 0) return;

  const { subject, body } = compose(notification);

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text: body }),
    });
  } catch {
    // Best effort, deliberately. See the header comment: a failed email must
    // never make a successful auto-rollback look like a failure.
  }
};

/** Records instead of sending. Used by the simulator and the smoke suite. */
export function collectingNotifier(): { notifier: Notifier; sent: Notification[] } {
  const sent: Notification[] = [];
  return {
    sent,
    notifier: async (notification) => {
      sent.push(notification);
    },
  };
}

export { formatCents };
