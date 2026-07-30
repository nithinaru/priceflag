/**
 * `POST /api/cron/evaluate` — the evaluator tick.
 *
 * This endpoint can revert prices on a real store, so it authenticates before it
 * does anything else. `CRON_SECRET` is compared in constant time; an unauthorised
 * caller gets 401 and no side effects.
 *
 * Safe to call as often as you like. Every rollout is leased, and each
 * (rollout, day) is evaluated at most once — the 15-minute schedule exists so a
 * missed tick self-heals quickly, not because there is work every 15 minutes.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { env } from '@/lib/config';
import { safeEqual } from '@/lib/crypto';
import { evaluateAll } from '@/lib/evaluator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function authorised(request: NextRequest): boolean {
  const secret = env('CRON_SECRET');
  if (secret === undefined) return false;

  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && safeEqual(match[1] as string, secret)) return true;
  }

  // Vercel Cron sends its own header on scheduled invocations.
  const vercelSecret = request.headers.get('x-vercel-cron-secret');
  if (vercelSecret !== null && safeEqual(vercelSecret, secret)) return true;

  return false;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Missing or invalid cron secret.', retryable: false, details: null } },
      { status: 401 },
    );
  }

  const result = await evaluateAll(getAdapter());
  return NextResponse.json(result, { status: result.errors.length > 0 ? 207 : 200 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

/** Vercel Cron issues GET. Same authentication, same work. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
