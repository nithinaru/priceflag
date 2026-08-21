import assert from 'node:assert/strict';

import { SupabaseAdapter } from '../lib/adapters/supabase';

interface ProbeError {
  code: string;
  message: string;
}

function fakeClient(failures: Readonly<Record<string, ProbeError>> = {}): {
  client: unknown;
  probes: string[];
} {
  const probes: string[] = [];
  return {
    probes,
    client: {
      from(table: string) {
        return {
          select(columns: string) {
            probes.push(`${table}:${columns}`);
            return {
              async limit() {
                return { data: [], error: failures[table] ?? null };
              },
            };
          },
        };
      },
    },
  };
}

async function main(): Promise<void> {
  const healthyDb = fakeClient();
  const healthy = await new SupabaseAdapter(healthyDb.client as never).ping();
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthyDb.probes, [
    'shops:id',
    'rollouts:id,creation_sequence',
    'model_runs:id,recommendations_written',
    'recommendations:id',
  ]);

  const staleDb = fakeClient({
    recommendations: {
      code: 'PGRST205',
      message: "Could not find the table 'public.recommendations' in the schema cache",
    },
  });
  const stale = await new SupabaseAdapter(staleDb.client as never).ping();
  assert.equal(stale.ok, false);
  assert.match(stale.detail ?? '', /required schema migrations are missing/);

  const unavailableDb = fakeClient({ shops: { code: '08006', message: 'connection failure' } });
  const unavailable = await new SupabaseAdapter(unavailableDb.client as never).ping();
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.detail, 'connection failure');

  console.log('Supabase readiness: reachability and current-schema probes passed.');
}

void main();
