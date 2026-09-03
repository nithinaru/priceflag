/**
 * Email notifications (R19).
 *
 * Plain language, one thing per email, and the subject line carries the news —
 * merchants read these on a phone and most will never open the body. An
 * rollback email in particular has to be immediately legible: something was
 * restored, and here is what it was.
 *
 * Sending is best-effort by design. A failed email must never fail an
 * auto-rollback: the prices are already restored, and throwing here would make
 * the evaluator look like it failed when it did exactly the right thing.
 */

import { listAccountEmailsForShop } from '../auth/account-shops';
import { env } from '../config';
import { formatCents, type Cents } from '../money';
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

/** One affected product, so an alert can say exactly what is live and what it was. */
export interface NotificationProduct {
  title: string;
  /** What Shopify is charging right now. */
  live_price_cents: Cents;
  /** The frozen pre-rollout price a rollback restores. */
  original_price_cents: Cents;
}

export interface Notification {
  kind: NotificationKind;
  shop: Shop;
  rollout?: Rollout;
  /** Count, stage number — whatever the sentence needs. */
  detail?: number;
  reason?: string;
  /** The products this alert is about, when the sentence should name them. */
  products?: NotificationProduct[];
  /** Deep link to the page where the merchant acts on it. */
  link?: string;
}

/** At most this many products are listed by name; the rest are counted. */
const MAX_LISTED_PRODUCTS = 10;

function productLines(notification: Notification, mode: 'live' | 'restored'): string {
  const products = notification.products ?? [];
  if (products.length === 0) return '';
  const currency = notification.shop.currency;
  const lines = products.slice(0, MAX_LISTED_PRODUCTS).map((product) =>
    mode === 'live'
      ? `  • ${product.title}: now ${formatCents(product.live_price_cents, currency)} (was ${formatCents(product.original_price_cents, currency)})`
      : `  • ${product.title}: back to ${formatCents(product.original_price_cents, currency)} (was ${formatCents(product.live_price_cents, currency)})`,
  );
  const more = products.length - lines.length;
  if (more > 0) lines.push(`  • …and ${more} more`);
  return `${lines.join('\n')}\n\n`;
}

function linkLine(notification: Notification): string {
  return notification.link === undefined ? '' : `Open the rollout: ${notification.link}\n`;
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
          `Nothing needs doing. We are still watching, and the rollout will pause and alert you if the numbers cross your limit.`,
      };

    case 'breach': {
      const count = notification.products?.length ?? 0;
      return {
        subject: `"${name}" is paused — results dropped`,
        body:
          `What happened: ${notification.reason ?? 'Sales came in below the range you set as acceptable.'}\n\n` +
          `What is affected: ${count > 0 ? `the ${count === 1 ? 'product' : `${count} products`} below ${count === 1 ? 'is' : 'are'} still on the new price. Nothing has been changed back yet.` : 'no further prices will change until you decide.'}\n` +
          productLines(notification, 'live') +
          `Our recommendation: roll back. Priceflag does not change any price on its own during the beta — ` +
          `it pauses, explains, and leaves the decision with you.\n\n` +
          `Your options, from the rollout page:\n` +
          `  1. Roll back (recommended) — restores every original price shown above, in one click.\n` +
          `  2. Resume — if you believe the dip was a one-off, the rollout carries on and keeps watching.\n` +
          `  3. Leave it paused — the new prices stay live on the products above, and no more products will change.\n` +
          linkLine(notification),
      };
    }

    case 'auto_rollback':
      return {
        // The single most important subject line in the product.
        subject: `"${name}" was reverted automatically`,
        body:
          `${notification.reason ?? 'Sales fell below the range you set as acceptable.'}\n\n` +
          `Every price this change touched — ${notification.detail ?? 0} of them — has been put back to what ` +
          `it was before, and we checked each one against your store to make sure.\n\n` +
          productLines(notification, 'restored') +
          `Nothing is left to do. The full before-and-after is in your price journal.\n` +
          linkLine(notification),
      };

    case 'manual_rollback':
      return {
        subject: `"${name}" was reverted`,
        body:
          `You reverted this change. All ${notification.detail ?? 0} prices are back to what they were.\n\n` +
          productLines(notification, 'restored') +
          linkLine(notification),
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
          `We stopped rather than overwrite it, because results would no longer mean what we predicted.\n\n` +
          productLines(notification, 'live') +
          `What to do next: open the rollout to resume or revert.\n` +
          linkLine(notification),
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
  // Override with RESEND_FROM. The default is a priceflag.org address so alerts
  // are not sent from Resend's shared onboarding domain.
  const from = env('RESEND_FROM') ?? 'Priceflag <kabir@priceflag.org>';
  if (apiKey === undefined) return;

  let to = recipients(notification);
  // Last resort: whoever signed in and connected this store. A guardrail alert
  // that goes to nobody is the one failure this module must not have.
  if (to.length === 0) to = await listAccountEmailsForShop(notification.shop.id).catch(() => []);
  if (to.length === 0) return;

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
