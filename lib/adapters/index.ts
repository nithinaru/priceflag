/**
 * Adapter selection. Server-only — importing this from a client component pulls
 * `node:fs` and the Supabase service key into the browser bundle.
 *
 * Demo mode is not a stub: it is the same engine over a simulated store, which is
 * why the smoke test runs the whole suite against both adapters. If a behaviour
 * differs between them, that is an adapter bug, and it is better found here than
 * on a merchant's store.
 */

import { getMode, hasSupabaseConfig } from '../config';
import { DemoAdapter } from './demo';
import { SupabaseAdapter } from './supabase';
import type { StoreAdapter } from './types';

export { DemoAdapter } from './demo';
export { SupabaseAdapter } from './supabase';
export type { AdapterKind, LockResult, Paged, StoreAdapter } from './types';

let cached: StoreAdapter | null = null;

export function createAdapter(): StoreAdapter {
  if (getMode() === 'demo') return new DemoAdapter();

  if (!hasSupabaseConfig()) {
    throw new Error(
      'PRICEFLAG_MODE=real needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
        'Set them in .env.local, or set PRICEFLAG_MODE=demo to run against the simulated store.',
    );
  }
  return new SupabaseAdapter();
}

/** One adapter per process. */
export function getAdapter(): StoreAdapter {
  if (cached === null) cached = createAdapter();
  return cached;
}

/** Tests only. */
export function setAdapter(adapter: StoreAdapter | null): void {
  cached = adapter;
}
