import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import {
  MerchantApiError,
  merchantErrorResponse,
  readJson,
  resolveAuthenticatedShop,
} from '@/lib/api/merchant';
import { toPublicShop } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Return settings for the token tenant without ever exposing its Admin API token. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    return NextResponse.json(
      { shop: toPublicShop(shop) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

/** Update the beta settings that are safe for a merchant to edit directly. */
export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const adapter = getAdapter();
    const { shop } = await resolveAuthenticatedShop(request, adapter);
    const body = await readJson(request);
    if (!isRecord(body) || !Array.isArray(body.notify_emails)) {
      throw new MerchantApiError(
        'notification_emails_required',
        'Send the notification email addresses as a list.',
        400,
      );
    }
    if (Object.keys(body).some((key) => key !== 'notify_emails')) {
      throw new MerchantApiError(
        'unsupported_shop_update',
        'Only notification email addresses can be changed here.',
        400,
      );
    }

    const emails = normalizeEmails(body.notify_emails);
    const updated = await adapter.updateShop(shop.id, { notify_emails: emails });
    return NextResponse.json(
      { shop: toPublicShop(updated), message: 'Notification addresses were saved.' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return merchantErrorResponse(cause);
  }
}

function normalizeEmails(values: unknown[]): string[] {
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new MerchantApiError('invalid_notification_email', 'Every notification address must be an email.', 400);
    }
    const email = value.trim().toLowerCase();
    if (email === '') continue;
    if (!EMAIL_PATTERN.test(email)) {
      throw new MerchantApiError('invalid_notification_email', `“${value}” does not look like an email address.`, 400);
    }
    if (!seen.has(email)) {
      emails.push(email);
      seen.add(email);
    }
  }
  if (emails.length > 5) {
    throw new MerchantApiError(
      'too_many_notification_emails',
      'Five addresses is the most we can notify for one store.',
      400,
    );
  }
  return emails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
