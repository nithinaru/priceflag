/**
 * `POST /api/demo/rollout-sim` — run one simulated rollout through the real
 * engine for the founder lab. Demo mode only; stores nothing; never constructs a
 * Shopify client (the writer talks to an in-memory fake).
 */

import { NextResponse } from 'next/server';

import { MerchantApiError } from '@/lib/api/merchant';
import { isDemoMode } from '@/lib/config';
import { ForecastError } from '@/lib/engine/forecast';
import { RolloutError } from '@/lib/engine/rollout';
import {
  SimulationInputError,
  runRolloutSimulation,
  type SimulationResult,
} from '@/lib/demo/simulate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export type RolloutSimApiResponse =
  | { ok: true; result: SimulationResult }
  | { ok: false; message: string; issues?: string[] };

export async function POST(request: Request): Promise<NextResponse<RolloutSimApiResponse>> {
  if (!isDemoMode()) {
    return NextResponse.json(
      { ok: false, message: 'The rollout simulator is only available in isolated demo mode.' },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Send valid JSON for the simulator.' }, { status: 400 });
  }

  try {
    const result = await runRolloutSimulation(body as Parameters<typeof runRolloutSimulation>[0]);
    return NextResponse.json({ ok: true, result }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof SimulationInputError) {
      return NextResponse.json({ ok: false, message: cause.message, issues: cause.issues }, { status: 400 });
    }
    if (cause instanceof ForecastError || cause instanceof RolloutError || cause instanceof MerchantApiError) {
      return NextResponse.json({ ok: false, message: cause.message }, { status: 422 });
    }
    throw cause;
  }
}
