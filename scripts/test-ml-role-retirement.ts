/**
 * Destructive, isolated-Postgres regression for the multi-transaction retirement
 * of priceflag_ml_readonly. Never run this against hosted Supabase.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from 'pg';

const rawDatabaseUrl = process.env.SUPABASE_DB_URL;
if (rawDatabaseUrl === undefined) throw new Error('SUPABASE_DB_URL is required');

const databaseUrl = new URL(rawDatabaseUrl);
if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)) {
  throw new Error('Refusing the destructive ML-role session test outside isolated localhost Postgres');
}

const lockoutSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804193400_commit_ml_role_login_lockout.sql'),
  'utf8',
);
const membershipSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804193500_verify_ml_role_memberships.sql'),
  'utf8',
);
const drainSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804193600_drain_and_attest_ml_role.sql'),
  'utf8',
);
const probeRole = 'priceflag_ml_retirement_probe';
const testPassword = 'test-only-local-retirement-password';

function roleUrl(role: string): string {
  const result = new URL(databaseUrl);
  result.username = role;
  result.password = testPassword;
  return result.toString();
}

async function rejected(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(operation, pattern);
}

async function main(): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl.toString() });
  let member: Client | null = null;
  let legacy: Client | null = null;
  let legacyPid: number | null = null;
  const legacyConnectionErrors: Error[] = [];
  await admin.connect();
  try {
    await admin.query(`drop role if exists ${probeRole}`);
    await admin.query(`create role ${probeRole} login noinherit password '${testPassword}'`);
    await admin.query(`grant priceflag_ml_readonly to ${probeRole}`);

    member = new Client({ connectionString: roleUrl(probeRole), connectionTimeoutMillis: 2_000 });
    await member.connect();
    await member.query('set role priceflag_ml_readonly');
    const memberIdentity = await member.query<{ session_user: string; current_user: string }>(
      'select session_user, current_user',
    );
    assert.deepEqual(memberIdentity.rows[0], {
      session_user: probeRole,
      current_user: 'priceflag_ml_readonly',
    });

    await admin.query(
      `comment on role priceflag_ml_readonly is 'Priceflag ML membership precheck v1 passed.'`,
    );
    await admin.query(lockoutSql);
    await rejected(admin.query(membershipSql), /restart to drain member sessions/);
    await admin.query(`revoke priceflag_ml_readonly from ${probeRole}`);
    await admin.query(membershipSql);
    await rejected(admin.query(drainSql), /restart the Supabase Postgres project after the committed lockout/);
    assert.equal(
      (await member.query<{ current_user: string }>('select current_user')).rows[0]?.current_user,
      'priceflag_ml_readonly',
      'the regression did not preserve the hidden SET ROLE session after membership removal',
    );
    await member.query('reset role');
    await member.end();
    member = null;
    await admin.query(`drop role ${probeRole}`);

    await admin.query(
      `comment on role priceflag_ml_readonly is 'Priceflag ML membership precheck v1 passed.'`,
    );
    // The applied retirement migration also leaves CONNECTION LIMIT 0 behind.
    // Re-open both boundaries in this localhost-only setup so the test can
    // establish a genuinely pre-lockout session before applying phase one.
    await admin.query(
      `alter role priceflag_ml_readonly login connection limit -1 password '${testPassword}'`,
    );
    legacy = new Client({
      connectionString: roleUrl('priceflag_ml_readonly'),
      connectionTimeoutMillis: 2_000,
    });
    // PostgreSQL reports an administrator-initiated backend termination through
    // the Client's asynchronous error event as well as through pending/future
    // queries. Capture it so the expected safety action cannot become an
    // unhandled process error in CI.
    legacy.on('error', (error: Error) => {
      legacyConnectionErrors.push(error);
    });
    await legacy.connect();
    const pidResult = await legacy.query<{ pid: number }>('select pg_backend_pid()::integer as pid');
    legacyPid = pidResult.rows[0]?.pid ?? null;
    assert.notEqual(legacyPid, null);

    // The first file commits NOLOGIN without touching the established session.
    await admin.query(lockoutSql);
    await admin.query(membershipSql);
    const reconnect = new Client({
      connectionString: roleUrl('priceflag_ml_readonly'),
      connectionTimeoutMillis: 2_000,
    });
    try {
      await rejected(reconnect.connect(), /not permitted to log in|authentication failed/i);
    } finally {
      await reconnect.end().catch(() => undefined);
    }
    assert.equal((await legacy.query('select 1')).rowCount, 1, 'phase one terminated the session too early');

    // The separately committed second file drains the old backend and attests
    // every role/grant/policy/session invariant before it can finish.
    await admin.query(drainSql);
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.ok(
      legacyConnectionErrors.some((error) =>
        /terminating connection due to administrator command/i.test(error.message),
      ),
      'phase two did not report the expected administrator-initiated session termination',
    );
    await rejected(legacy.query('select 1'), /terminating connection|connection terminated|not queryable/i);
    await admin.query('select priceflag_internal.pf_attest_ml_database_role_retired()');
    legacy = null;
    legacyPid = null;
  } finally {
    if (member !== null) await member.end().catch(() => undefined);
    if (legacy !== null) await legacy.end().catch(() => undefined);
    if (legacyPid !== null) {
      await admin.query('select pg_terminate_backend($1, 5000)', [legacyPid]).catch(() => undefined);
    }
    await admin.query(`revoke priceflag_ml_readonly from ${probeRole}`).catch(() => undefined);
    await admin.query(`drop role if exists ${probeRole}`).catch(() => undefined);
    await admin.query(
      'alter role priceflag_ml_readonly nologin noinherit connection limit 0 password null',
    ).catch(() => undefined);
    await admin.end();
  }
  console.log('ML role retirement: memberships fail closed; committed lockout blocks reconnect; drain evicts legacy session.');
}

void main();
