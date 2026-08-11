import { NextResponse } from 'next/server';

import {
  FounderLabInputError,
  parseFounderLabInput,
  runFounderLab,
  type FounderLabApiResponse,
} from '@/lib/demo/founder-lab';
import { ForecastError } from '@/lib/engine/forecast';
import { isDemoMode } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse<FounderLabApiResponse>> {
  if (!isDemoMode()) {
    return NextResponse.json(
      { ok: false, message: 'The founder lab is only available in isolated demo mode.' },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, message: 'Send valid JSON for the founder lab.' },
      { status: 400 },
    );
  }

  try {
    const input = parseFounderLabInput(body);
    return NextResponse.json(
      { ok: true, result: runFounderLab(input) },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    if (cause instanceof FounderLabInputError) {
      return NextResponse.json(
        { ok: false, message: cause.message, issues: cause.issues },
        { status: 400 },
      );
    }
    if (cause instanceof ForecastError) {
      return NextResponse.json(
        { ok: false, message: cause.message },
        { status: 422 },
      );
    }
    throw cause;
  }
}
