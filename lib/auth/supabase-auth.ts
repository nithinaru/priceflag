/**
 * The Supabase Auth client — magic links only.
 *
 * Separate from `lib/db/client.ts` on purpose. That module holds the service
 * role key, which bypasses RLS and must never touch an unauthenticated code
 * path; this one uses the *publishable* (anon) key, which is the correct key for
 * "somebody who is not signed in yet is asking us to email them a link". Sending
 * an OTP with the service role key would work and would be a mistake: it would
 * mean an unauthenticated POST reaching a key that can read every store's data.
 *
 * Server-only either way — the routes below run on Node, and the browser never
 * talks to Supabase directly.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env, requireEnv } from '../config';

export function hasAuthConfig(): boolean {
  return env('SUPABASE_URL') !== undefined && anonKey() !== undefined;
}

/**
 * Supabase renamed the anon key to the publishable key (`sb_publishable_…`) but
 * kept the JWT-shaped `anon` key working. Accept either name so this does not
 * break on whichever one the dashboard hands over.
 */
function anonKey(): string | undefined {
  return env('SUPABASE_PUBLISHABLE_KEY') ?? env('SUPABASE_ANON_KEY');
}

export function createAuthClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL', 'Find it in Supabase → Project Settings → API.');
  const key = anonKey();
  if (key === undefined) {
    throw new Error(
      'Missing SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY). ' +
        'Supabase → Project Settings → API → Publishable key. Safe to expose; it is not the service role key.',
    );
  }

  return createClient(url, key, {
    auth: {
      // Every request here is a one-shot on behalf of a stranger. Persisting or
      // refreshing a session would leak one caller's session into the next
      // request on the same warm serverless instance.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/** Where Supabase should send someone after they click the link in the email. */
export function callbackUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/auth/callback`;
}
