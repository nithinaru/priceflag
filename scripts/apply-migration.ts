/**
 * Apply one migration to a remote Supabase database, and record it.
 *
 *   npm run db:apply -- supabase/migrations/20260910120000_store_identity_accounts.sql
 *
 * `supabase db push` is the normal path and should be preferred wherever it
 * works. It does not work against this project from every machine: the direct
 * database host is IPv6-only and the tenant is not on a shared pooler, so the
 * CLI fails with `LegacyDbConnectError` while an ordinary `pg` connection over
 * `SUPABASE_DB_URL` connects fine. This script is that fallback, and nothing
 * more — it deliberately applies a single named file rather than reconciling a
 * directory, because a fallback that silently replays history is worse than no
 * fallback at all.
 *
 * The migration and its history row commit in one transaction: a migration that
 * applied without being recorded would be re-run by the next `db push`, and for
 * anything non-idempotent that is a second, unreviewed change to production.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { Client } from 'pg';

function usage(message: string): never {
  process.stderr.write(`${message}\n\nusage: npm run db:apply -- <path-to-migration.sql>\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) usage('No migration file given.');

  const connectionString = process.env.SUPABASE_DB_URL;
  if (connectionString === undefined || connectionString === '') {
    usage('SUPABASE_DB_URL is not set. Source the environment file that holds it first.');
  }

  const name = basename(file);
  const version = name.split('_')[0] ?? '';
  if (!/^\d{14}$/.test(version)) {
    usage(`${name} does not start with a 14-digit migration version.`);
  }

  const sql = readFileSync(file, 'utf8');

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const already = await client.query(
      'select 1 from supabase_migrations.schema_migrations where version = $1',
      [version],
    );
    if (already.rowCount !== null && already.rowCount > 0) {
      process.stdout.write(`${version} is already recorded as applied. Nothing to do.\n`);
      return;
    }

    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)',
        [version, name],
      );
      await client.query('commit');
    } catch (cause) {
      await client.query('rollback').catch(() => undefined);
      throw cause;
    }

    process.stdout.write(`applied and recorded ${name}\n`);
  } finally {
    await client.end();
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `migration failed and was rolled back: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
});
