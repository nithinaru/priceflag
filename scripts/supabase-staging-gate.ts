import { Client } from 'pg';

import {
  assertStagingIdentity,
  requireStagingGateConfig,
  type StagingIdentity,
} from './supabase-staging-guard';

async function main(): Promise<void> {
  if (process.argv[2] !== 'attest') {
    throw new Error('usage: tsx scripts/supabase-staging-gate.ts attest');
  }

  const config = requireStagingGateConfig(process.env);
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const result = await client.query<StagingIdentity>(`
      select
        current_setting('app.priceflag_environment', true) as environment,
        current_setting('app.priceflag_project_ref', true) as "projectRef",
        current_setting('app.priceflag_staging_sentinel', true) as sentinel
    `);
    const identity = result.rows[0];
    if (result.rowCount !== 1 || !identity) {
      throw new Error('Staging identity query returned an invalid result');
    }
    assertStagingIdentity(identity, config);
  } finally {
    await client.end();
  }

  process.stdout.write(`staging database ${config.projectRef} positively attested\n`);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
