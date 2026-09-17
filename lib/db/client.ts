/**
 * Supabase client. Server-only.
 *
 * The service role key bypasses RLS, which is the whole design (see
 * `supabase/migrations/*_rls.sql`): every read and write goes through a route
 * handler that has already resolved the shop. That also means this module must
 * never be reachable from a client component — if a bundle ever includes it, the
 * key is in the browser and every store's data is public.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireEnv } from '../config';

let cached: SupabaseClient | null = null;

export function createServiceClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL', 'Find it in Supabase → Project Settings → API.');
  const key = requireEnv(
    'SUPABASE_SERVICE_ROLE_KEY',
    'Supabase → Project Settings → API → service_role. Server only — never expose it to the browser.',
  );

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    global: { headers: { 'x-priceflag-client': 'server' } },
  });
}

/** One client per process. Cheap, and it keeps the connection pool sane. */
export function getServiceClient(): SupabaseClient {
  if (cached === null) cached = createServiceClient();
  return cached;
}

export interface PostgrestLikeError {
  message: string;
  details?: string | null;
  hint?: string | null;
  code?: string;
}

/**
 * Unwrap a PostgREST result, turning an error into a thrown one with enough
 * context to debug. A silently-ignored database error in a price writer is how
 * you end up believing a price was written when it was not.
 */
export function unwrap<T>(
  result: { data: T | null; error: PostgrestLikeError | null },
  context: string,
): T {
  if (result.error) {
    const parts = [result.error.message, result.error.details, result.error.hint].filter(Boolean);
    throw new Error(`${context}: ${parts.join(' — ')}${result.error.code ? ` [${result.error.code}]` : ''}`);
  }
  if (result.data === null) {
    throw new Error(`${context}: no data returned`);
  }
  return result.data;
}

/** Same, but a missing row is a legitimate `null` rather than an error. */
export function unwrapMaybe<T>(
  result: { data: T | null; error: PostgrestLikeError | null },
  context: string,
): T | null {
  if (result.error) {
    // PGRST116 = "no rows returned" from .single(); that is a null, not a failure.
    if (result.error.code === 'PGRST116') return null;
    const parts = [result.error.message, result.error.details, result.error.hint].filter(Boolean);
    throw new Error(`${context}: ${parts.join(' — ')}`);
  }
  return result.data;
}
