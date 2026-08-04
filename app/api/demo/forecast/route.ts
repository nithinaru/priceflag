/** Read-only forecast endpoint for the visibly labelled public demo store. */

import { NextResponse } from 'next/server';

import { requestDemoForecast, type ForecastRequest } from '@/app/propose/actions';
import { isDemoMode } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  if (!isDemoMode()) {
    return NextResponse.json(
      { ok: false, code: 'not_found', message: 'The demo forecast is not available here.' },
      { status: 404 },
    );
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_json', message: 'Send a valid forecast request.' },
      { status: 400 },
    );
  }
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray((input as { variant_gids?: unknown }).variant_gids) ||
    (input as { variant_gids: unknown[] }).variant_gids.length > 100 ||
    typeof (input as { change?: unknown }).change !== 'object' ||
    (input as { change?: unknown }).change === null
  ) {
    return NextResponse.json(
      { ok: false, code: 'invalid_request', message: 'Choose valid products and a price change.' },
      { status: 400 },
    );
  }

  const reply = await requestDemoForecast(input as ForecastRequest);
  return NextResponse.json(reply, {
    status: reply.ok ? 200 : 422,
    headers: { 'Cache-Control': 'no-store' },
  });
}
