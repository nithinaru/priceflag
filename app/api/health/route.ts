/**
 * `GET /api/health` — what is configured, and can we reach it.
 *
 * Reports capability, never secrets: booleans for which env vars are present, and
 * a reachability probe for whichever adapter is active. Useful on Vercel to answer
 * "is this deployment actually wired to the database" without opening a shell.
 */

import { NextResponse } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { describeEnvironment, getMode } from '@/lib/config';
import { CONTRACT_VERSION } from '@/lib/contracts';

// Never prerender: this exists to report the state of the running process.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function publicAdapterDetail(ok: boolean, detail?: string): string {
  if (ok) return 'reachable';
  if (detail !== undefined && /schema|migration/i.test(detail)) return 'reachable, but database migrations are missing';
  return 'unreachable';
}

export async function GET(): Promise<NextResponse> {
  const environment = describeEnvironment();

  let adapter: { kind: string; ok: boolean; detail?: string };
  try {
    const store = getAdapter();
    const ping = await store.ping();
    adapter = { kind: store.kind, ok: ping.ok, detail: publicAdapterDetail(ping.ok, ping.detail) };
  } catch {
    adapter = {
      kind: getMode() === 'demo' ? 'demo' : 'supabase',
      ok: false,
      // This route is deliberately public. Raw client/transport errors can
      // contain internal hosts or paths, so never echo them to this response.
      detail: publicAdapterDetail(false),
    };
  }

  return NextResponse.json(
    {
      ok: adapter.ok,
      mode: environment.mode,
      adapter,
      contract_version: CONTRACT_VERSION,
      shopify_api_version: environment.shopifyApiVersion,
      configured: {
        supabase: environment.supabase,
        shopify: environment.shopify,
        encryption_key: environment.encryption,
        resend: environment.resend,
        cron_secret: environment.cronSecret,
      },
      time: new Date().toISOString(),
    },
    { status: adapter.ok ? 200 : 503 },
  );
}
