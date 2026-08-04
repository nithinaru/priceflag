import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  attestLiveWriteTarget,
  isVerifiedRollback,
  requireLiveWriteTarget,
} from '../scripts/live-write-guard';
import {
  assertStagingIdentity,
  requireStagingGateConfig,
} from '../scripts/supabase-staging-guard';

let passed = 0;

function rejects(env: Readonly<Record<string, string | undefined>>, pattern: RegExp): void {
  assert.throws(() => requireLiveWriteTarget(env), pattern);
  passed += 1;
}

const base = {
  PRICEFLAG_URL: 'https://priceflag-git-beta-owner.vercel.app',
  PRICEFLAG_CP4_SHOP_DOMAIN: 'priceflag-safety.myshopify.com',
  PRICEFLAG_CP4_CONFIRM: 'WRITE_TEST_PRICES:priceflag-safety.myshopify.com',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'test-only-bypass',
  VERCEL_TOKEN: 'test-only-vercel-token',
};

assert.deepEqual(requireLiveWriteTarget(base), {
  baseUrl: base.PRICEFLAG_URL,
  expectedShopDomain: base.PRICEFLAG_CP4_SHOP_DOMAIN,
  vercelBypassSecret: base.VERCEL_AUTOMATION_BYPASS_SECRET,
});
passed += 1;

for (const hostname of ['priceflag.vercel.app', 'priceflagv1.vercel.app', 'priceflag-app.vercel.app']) {
  rejects({ ...base, PRICEFLAG_URL: `https://${hostname}` }, /Refusing live-write test/);
}
rejects({ ...base, PRICEFLAG_URL: 'http://localhost:3000' }, /clean HTTPS origin/);
rejects({ ...base, PRICEFLAG_URL: 'https://attacker.example' }, /pinned Priceflag project/);
rejects({ ...base, PRICEFLAG_CP4_CONFIRM: 'yes' }, /PRICEFLAG_CP4_CONFIRM/);
rejects({ ...base, PRICEFLAG_CP4_SHOP_DOMAIN: 'another.example.com' }, /exact \*\.myshopify\.com/);
rejects({ ...base, VERCEL_AUTOMATION_BYPASS_SECRET: '' }, /VERCEL_AUTOMATION_BYPASS_SECRET is required/);

const cleanUndo = { fully_applied: true, failed: 0, external_changes: [] };
assert.equal(isVerifiedRollback(cleanUndo, { mismatched: [] }), true);
assert.equal(isVerifiedRollback({ ...cleanUndo, fully_applied: false }, { mismatched: [] }), false);
assert.equal(isVerifiedRollback({ ...cleanUndo, failed: 1 }, { mismatched: [] }), false);
assert.equal(isVerifiedRollback({ ...cleanUndo, external_changes: [{}] }, { mismatched: [] }), false);
assert.equal(isVerifiedRollback(cleanUndo, { mismatched: [{}] }), false);
passed += 5;

const setup = readFileSync(resolve(process.cwd(), 'scripts/vercel-setup.sh'), 'utf8');
assert.match(setup, /SHOPIFY_APP_HANDLE/);
assert.doesNotMatch(setup, /deploy --prod/);
assert.match(setup, /SHOPIFY_ADMIN_ACCESS_TOKEN SHOPIFY_SHOP_DOMAIN/);
assert.match(setup, /ENV_FILE="\.env\.preview\.local"/);
assert.doesNotMatch(setup, /for target in preview production/);
assert.match(setup, /PRICEFLAG_SHOP_ALLOWLIST/);
passed += 6;

const stage = readFileSync(resolve(process.cwd(), 'scripts/vercel-stage.sh'), 'utf8');
assert.match(stage, /deploy --prod --skip-domain --yes/);
assert.match(stage, /STAGE_PRODUCTION_ARTIFACT:/);
assert.doesNotMatch(stage, /"\$\{VC\[@\]\}" promote/);
assert.match(stage, /ENV_FILE="\.env\.production\.local"/);
assert.match(stage, /PRICEFLAG_SHOP_ALLOWLIST/);
passed += 5;

const runbook = readFileSync(resolve(process.cwd(), 'PILOT_RUNBOOK.md'), 'utf8');
assert.doesNotMatch(runbook, /vercel deploy --prod --yes/);
assert.doesNotMatch(runbook, /^vercel env (?:rm|add)/m);
assert.match(runbook, /-d '\{"confirm":true,"reason":"Support request"\}'/);
assert.match(runbook, /-d '\{"confirm":true\}'/);
assert.match(runbook, /scripts\/vercel-demo-access\.sh revoke/);
assert.match(runbook, /never receives a PostgreSQL login/);
assert.match(runbook, /hosted staging gate calls[\s\S]*pf_attest_ml_database_role_retired\(\)/);
passed += 7;

const demoAccess = readFileSync(resolve(process.cwd(), 'scripts/vercel-demo-access.sh'), 'utf8');
assert.match(demoAccess, /PROJECT_ID="prj_RU8NlBDoR7t89BNqn5BagOpmpnmm"/);
assert.match(demoAccess, /TEAM_SCOPE="team_AqaBD6YaOf9DIJ7NzbytTZTW"/);
assert.match(demoAccess, /api\.vercel\.com\/v9\/projects/);
assert.match(demoAccess, /_DEMO_ACCESS:\$COMMIT/);
assert.doesNotMatch(demoAccess, /deploy --prod|alias set|"\$\{VC\[@\]\}" promote/);
assert.ok(demoAccess.indexOf('api.vercel.com/v9/projects') < demoAccess.indexOf('env rm'));
passed += 6;

const stagingEnv = {
  STAGING_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-key',
  SUPABASE_DB_URL: 'postgresql://postgres.test:password@staging.pooler.supabase.com:5432/postgres?sslmode=require',
  SUPABASE_STAGING_SENTINEL: 'test-only-staging-sentinel',
  SUPABASE_CONFIRM_ACTION: 'APPLY_STAGING_MIGRATIONS',
  SUPABASE_CONFIRM_COMMIT: 'a'.repeat(40),
  GITHUB_SHA: 'a'.repeat(40),
};
assert.deepEqual(requireStagingGateConfig(stagingEnv), {
  projectRef: stagingEnv.STAGING_SUPABASE_PROJECT_REF,
  supabaseUrl: stagingEnv.SUPABASE_URL,
  databaseUrl: stagingEnv.SUPABASE_DB_URL,
  sentinel: stagingEnv.SUPABASE_STAGING_SENTINEL,
});
assert.throws(
  () => requireStagingGateConfig({
    ...stagingEnv,
    STAGING_SUPABASE_PROJECT_REF: 'vnyqevrdvfjsfhdnbfsz',
    SUPABASE_URL: 'https://vnyqevrdvfjsfhdnbfsz.supabase.co',
  }),
  /production project/,
);
assert.throws(
  () => requireStagingGateConfig({ ...stagingEnv, SUPABASE_URL: 'https://other.supabase.co' }),
  /exact HTTPS API origin/,
);
assert.throws(
  () => requireStagingGateConfig({ ...stagingEnv, SUPABASE_CONFIRM_COMMIT: 'b'.repeat(40) }),
  /does not match GITHUB_SHA/,
);
assert.throws(
  () => requireStagingGateConfig({ ...stagingEnv, SUPABASE_DB_URL: '' }),
  /SUPABASE_DB_URL is required/,
);
assert.throws(
  () => requireStagingGateConfig({
    ...stagingEnv,
    SUPABASE_DB_URL: 'postgresql://postgres:vnyqevrdvfjsfhdnbfsz@db.example/postgres',
  }),
  /production project/,
);
const stagingConfig = requireStagingGateConfig(stagingEnv);
assert.doesNotThrow(() => assertStagingIdentity({
  environment: 'staging',
  projectRef: stagingConfig.projectRef,
  sentinel: stagingConfig.sentinel,
}, stagingConfig));
assert.throws(
  () => assertStagingIdentity({
    environment: 'production',
    projectRef: stagingConfig.projectRef,
    sentinel: stagingConfig.sentinel,
  }, stagingConfig),
  /not explicitly marked as staging/,
);
assert.throws(
  () => assertStagingIdentity({
    environment: 'staging',
    projectRef: stagingConfig.projectRef,
    sentinel: 'wrong',
  }, stagingConfig),
  /protected staging sentinel/,
);
passed += 9;

const stagingWorkflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/staging-launch-gates.yml'),
  'utf8',
);
assert.match(stagingWorkflow, /environment: priceflag-staging/);
assert.match(stagingWorkflow, /workflow_dispatch:/);
assert.doesNotMatch(stagingWorkflow, /pull_request:/);
assert.match(stagingWorkflow, /supabase-staging-gate\.ts attest/);
assert.match(stagingWorkflow, /db push --db-url "\$SUPABASE_DB_URL" --dry-run/);
assert.match(stagingWorkflow, /--type security[\s\S]*--fail-on warn --output-format json/);
assert.match(stagingWorkflow, /--type performance[\s\S]*--fail-on error --output-format json/);
assert.match(stagingWorkflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
assert.match(stagingWorkflow, /SUPABASE_STAGING_SENTINEL: \$\{\{ secrets\.SUPABASE_STAGING_SENTINEL \}\}/);
assert.match(stagingWorkflow, /SUPABASE_DB_URL: \$\{\{ secrets\.SUPABASE_DB_URL \}\}/);
assert.doesNotMatch(stagingWorkflow, /SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|supabase link|--linked/);
assert.doesNotMatch(stagingWorkflow, /ref: \$\{\{ inputs\.confirm_commit \}\}/);
assert.match(stagingWorkflow, /refs\/heads\/main\|refs\/heads\/codex\/prod-integration/);
assert.match(stagingWorkflow, /npm ci --ignore-scripts/);
assert.match(stagingWorkflow, /psql "\$SUPABASE_DB_URL"[\s\S]*pf_attest_ml_database_role_retired\(\)/);
assert.doesNotMatch(
  stagingWorkflow.slice(stagingWorkflow.indexOf('env:'), stagingWorkflow.indexOf('steps:')),
  /secrets\./,
);
passed += 16;

const workflowDirectory = resolve(process.cwd(), '.github/workflows');
for (const workflow of [
  'ml-ci.yml',
  'ml-nightly.yml',
  'ml-release-gate.yml',
  'production-gates.yml',
  'staging-launch-gates.yml',
]) {
  const source = readFileSync(resolve(workflowDirectory, workflow), 'utf8');
  const uses = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0, `${workflow} must contain at least one pinned action`);
  for (const action of uses) {
    assert.match(action ?? '', /@[0-9a-f]{40}$/, `${workflow} contains an unpinned action: ${action}`);
  }
}
passed += 5;

const mlNightlyWorkflow = readFileSync(resolve(workflowDirectory, 'ml-nightly.yml'), 'utf8');
assert.match(mlNightlyWorkflow, /schedule:/);
assert.doesNotMatch(mlNightlyWorkflow, /workflow_dispatch:|pull_request:/);
assert.match(mlNightlyWorkflow, /permissions:[\s\S]*actions: read[\s\S]*contents: read/);
assert.doesNotMatch(mlNightlyWorkflow, /permissions:[\s\S]*\bwrite\b/);
assert.match(mlNightlyWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
assert.match(mlNightlyWorkflow, /environment: priceflag-ml-production/);
assert.match(mlNightlyWorkflow, /github-environment-guard\.mjs priceflag-ml-production main optional/);
assert.match(mlNightlyWorkflow, /REQUIRE_REAL_INGEST: "true"/);
assert.match(mlNightlyWorkflow, /verify_nightly_evidence\.py out\/real_ingest_evidence\.json/);
assert.doesNotMatch(mlNightlyWorkflow, /SUPABASE_ML_READONLY_KEY|SUPABASE_ML_SENTINEL/);
assert.match(mlNightlyWorkflow, /ML_INGEST_SECRET: \$\{\{ secrets\.ML_INGEST_SECRET \}\}/);
assert.match(mlNightlyWorkflow, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
assert.match(mlNightlyWorkflow, /PRICEFLAG_ML_EXPECTED_PROJECT_REF: vnyqevrdvfjsfhdnbfsz/);
assert.match(mlNightlyWorkflow, /path: ml\/out\/real_ingest_evidence\.json/);
assert.doesNotMatch(mlNightlyWorkflow, /path:\s*ml\/out\/\s*$/m);
assert.doesNotMatch(mlNightlyWorkflow, /SUPABASE_SERVICE_ROLE_KEY/);
passed += 15;

const mlReleaseWorkflow = readFileSync(resolve(workflowDirectory, 'ml-release-gate.yml'), 'utf8');
assert.match(mlReleaseWorkflow, /push:[\s\S]*- codex\/prod-integration/);
assert.doesNotMatch(mlReleaseWorkflow, /workflow_dispatch:|pull_request:|pull_request_target:/);
assert.match(mlReleaseWorkflow, /permissions:[\s\S]*actions: read[\s\S]*contents: read/);
assert.doesNotMatch(mlReleaseWorkflow, /permissions:[\s\S]*\bwrite\b/);
assert.match(
  mlReleaseWorkflow,
  /if: github\.repository == 'nithinaru\/priceflag' && github\.ref == 'refs\/heads\/codex\/prod-integration'/,
);
assert.match(mlReleaseWorkflow, /environment: priceflag-ml-release/);
assert.match(
  mlReleaseWorkflow,
  /github-environment-guard\.mjs priceflag-ml-release codex\/prod-integration required/,
);
assert.match(mlReleaseWorkflow, /test "\$GITHUB_REPOSITORY" = "nithinaru\/priceflag"/);
assert.match(mlReleaseWorkflow, /test "\$GITHUB_REF" = "refs\/heads\/codex\/prod-integration"/);
assert.match(mlReleaseWorkflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
assert.match(mlReleaseWorkflow, /REQUIRE_REAL_INGEST: "true"/);
assert.doesNotMatch(mlReleaseWorkflow, /SUPABASE_ML_READONLY_KEY|SUPABASE_ML_SENTINEL/);
assert.match(mlReleaseWorkflow, /ML_INGEST_SECRET: \$\{\{ secrets\.ML_INGEST_SECRET \}\}/);
assert.match(mlReleaseWorkflow, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
assert.match(mlReleaseWorkflow, /PRICEFLAG_ML_EXPECTED_PROJECT_REF: vnyqevrdvfjsfhdnbfsz/);
assert.match(mlReleaseWorkflow, /path: ml\/out\/real_ingest_evidence\.json/);
assert.doesNotMatch(mlReleaseWorkflow, /path:\s*ml\/out\/\s*$/m);
assert.doesNotMatch(mlReleaseWorkflow, /SUPABASE_SERVICE_ROLE_KEY/);
passed += 18;

const mlRoleHardening = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804180000_normalize_ml_readonly_privileges.sql'),
  'utf8',
);
assert.match(mlRoleHardening, /create role priceflag_ml_readonly nologin noinherit connection limit 0/);
assert.match(mlRoleHardening, /alter role priceflag_ml_readonly nologin noinherit[\s\S]*connection limit 0/);
assert.match(mlRoleHardening, /errcode = '42501'/);
assert.match(mlRoleHardening, /from pg_auth_members[\s\S]*member\.rolname = 'postgres'[\s\S]*drain member sessions and remove memberships/);
assert.doesNotMatch(mlRoleHardening, /revoke priceflag_ml_readonly from postgres/);
assert.match(mlRoleHardening, /Priceflag ML membership precheck v1 passed/);
assert.match(mlRoleHardening, /drop policy if exists ml_readonly_select/);
assert.match(mlRoleHardening, /revoke all privileges on all tables in schema public from priceflag_ml_readonly/);
assert.match(mlRoleHardening, /revoke all privileges on all routines in schema public from priceflag_ml_readonly/);
assert.match(mlRoleHardening, /revoke all privileges on schema public from priceflag_ml_readonly/);
assert.match(mlRoleHardening, /from information_schema\.column_privileges[\s\S]*revoke %s \(%I\)/);
assert.match(mlRoleHardening, /production design now reads through POST \/api\/ml\/export/);
assert.doesNotMatch(mlRoleHardening, /alter role priceflag_ml_readonly login|password\s+'/i);
assert.doesNotMatch(mlRoleHardening, /grant select .*priceflag_ml_readonly/i);
assert.doesNotMatch(mlRoleHardening, /grant .*schema net|grant .*net\./i);
passed += 14;

const mlRoleLockout = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804193400_commit_ml_role_login_lockout.sql'),
  'utf8',
);
const mlRoleMemberships = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804193500_verify_ml_role_memberships.sql'),
  'utf8',
);
const mlRoleDrain = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260804193600_drain_and_attest_ml_role.sql'),
  'utf8',
);
assert.match(mlRoleLockout, /alter role priceflag_ml_readonly[\s\S]*nologin[\s\S]*connection limit 0[\s\S]*password null/);
assert.match(mlRoleLockout, /shobj_description[\s\S]*Priceflag ML membership precheck v1 passed/);
assert.match(mlRoleLockout, /from pg_auth_members[\s\S]*memberships_exist/);
assert.match(mlRoleLockout, /not fresh_membership_precheck or memberships_exist/);
assert.match(mlRoleLockout, /member\.rolname = 'postgres'[\s\S]*gives the[\s\S]*retired identity no authority/);
assert.doesNotMatch(mlRoleLockout, /revoke priceflag_ml_readonly from postgres/);
assert.doesNotMatch(mlRoleLockout, /pg_terminate_backend/);
assert.match(mlRoleMemberships, /version = '20260804193400'/);
assert.match(mlRoleMemberships, /from pg_auth_members[\s\S]*restart to drain member sessions/);
assert.match(mlRoleMemberships, /string_agg[\s\S]*member\.rolname[\s\S]*parent\.rolname/);
assert.match(mlRoleMemberships, /parent\.rolname = 'priceflag_ml_readonly'[\s\S]*member\.rolname = 'postgres'/);
assert.doesNotMatch(mlRoleMemberships, /alter role priceflag_ml_readonly[\s\S]*login/);
assert.match(mlRoleDrain, /version = '20260804193500'/);
assert.match(mlRoleDrain, /requires_restart[\s\S]*pg_postmaster_start_time\(\) <= retirement_state\.lockout_recorded_at/);
assert.match(mlRoleDrain, /pg_terminate_backend\(session_row\.pid, 5000\)/);
assert.match(mlRoleDrain, /pg_terminate_backend[\s\S]*pg_stat_clear_snapshot\(\)[\s\S]*sessions remain after the committed lockout/);
assert.match(mlRoleDrain, /from pg_stat_activity[\s\S]*legacy ML database role still has active sessions/);
assert.match(mlRoleDrain, /pf_attest_ml_database_role_retired\(\)[\s\S]*security invoker[\s\S]*set search_path = ''/);
assert.match(mlRoleDrain, /role_state\.rolcanlogin[\s\S]*role_state\.rolinherit[\s\S]*role_state\.rolconnlimit <> 0/);
assert.match(mlRoleDrain, /from pg_auth_members[\s\S]*legacy ML database role retains role memberships/);
assert.match(mlRoleDrain, /parent\.rolname = 'priceflag_ml_readonly'[\s\S]*member\.rolname = 'postgres'/);
assert.match(mlRoleDrain, /from pg_policy[\s\S]*legacy ML database role remains referenced by an RLS policy/);
assert.match(mlRoleDrain, /from information_schema\.table_privileges[\s\S]*legacy ML database role retains direct privileges/);
assert.match(mlRoleDrain, /select priceflag_internal\.pf_attest_ml_database_role_retired\(\)/);
assert.ok(
  [
    '20260804193400_commit_ml_role_login_lockout.sql',
    '20260804193500_verify_ml_role_memberships.sql',
    '20260804193600_drain_and_attest_ml_role.sql',
  ].join('\n') === [
    '20260804193600_drain_and_attest_ml_role.sql',
    '20260804193400_commit_ml_role_login_lockout.sql',
    '20260804193500_verify_ml_role_memberships.sql',
  ].sort().join('\n'),
  'the committed lockout migration must sort before the drain migration',
);
passed += 21;

async function verifyAttestation(): Promise<void> {
  const sanitizerUrl = pathToFileURL(
    resolve(process.cwd(), 'scripts/sanitize-supabase-start-log.mjs'),
  ).href;
  const sanitizer = (await import(sanitizerUrl)) as {
    sanitizeSupabaseStartLog: (input: string) => string;
  };
  const sanitized = sanitizer.sanitizeSupabaseStartLog([
    'API URL: http://127.0.0.1:54321',
    'service_role key: eyJabcdefghijk.abcdefghijklmnop.qrstuvwxyz12345',
    'ERROR: safe database cause before the statement dump',
    'effect/sql/SqlError: Failed to execute statement',
    'ordinary SQL context that must survive',
    'ERROR: migration 20260804180000 failed: token=very-secret-token',
    'could not connect to postgresql://postgres:database-password@127.0.0.1:54322/postgres',
    `fatal container output ${'a'.repeat(100)}`,
  ].join('\n'));
  assert.match(sanitized, /migration 20260804180000 failed/);
  assert.match(sanitized, /safe database cause before the statement dump/);
  assert.match(sanitized, /ordinary SQL context that must survive/);
  assert.match(sanitized, /postgresql:\/\/\[REDACTED\]@127\.0\.0\.1/);
  assert.match(sanitized, /service_role key:\[REDACTED\]/);
  assert.doesNotMatch(sanitized, /very-secret-token|database-password|eyJabcdefghijk|a{80}/);

  const productionWorkflow = readFileSync(
    resolve(process.cwd(), '.github/workflows/production-gates.yml'),
    'utf8',
  );
  assert.match(productionWorkflow, /supabase start --debug/);
  assert.match(productionWorkflow, /sanitize-supabase-start-log\.mjs/);
  assert.doesNotMatch(productionWorkflow, /ml-privilege-diagnostics|PRICEFLAG_DIAGNOSTIC_ROOT/);
  assert.match(productionWorkflow, /exit 1/);
  assert.doesNotMatch(productionWorkflow, /cat \"\$RUNNER_TEMP\/supabase-start\.log\"/);
  passed += 11;

  const guardUrl = pathToFileURL(resolve(process.cwd(), 'scripts/github-environment-guard.mjs')).href;
  const guard = (await import(guardUrl)) as {
    assertEnvironmentConfiguration: (
      environment: Record<string, unknown>,
      branchPolicies: Record<string, unknown>,
      options: { environment: string; branches: string[]; requireReviewer: boolean },
    ) => void;
  };
  const protectedEnvironment = {
    name: 'priceflag-ml-release',
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [{
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User' }],
    }],
  };
  const exactBranch = { branch_policies: [{ name: 'codex/prod-integration' }] };
  assert.doesNotThrow(() => guard.assertEnvironmentConfiguration(
    protectedEnvironment,
    exactBranch,
    { environment: 'priceflag-ml-release', branches: ['codex/prod-integration'], requireReviewer: true },
  ));
  assert.throws(() => guard.assertEnvironmentConfiguration(
    { ...protectedEnvironment, can_admins_bypass: true },
    exactBranch,
    { environment: 'priceflag-ml-release', branches: ['codex/prod-integration'], requireReviewer: true },
  ), /administrator bypass/);
  assert.throws(() => guard.assertEnvironmentConfiguration(
    {
      ...protectedEnvironment,
      protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User' }] }],
    },
    exactBranch,
    { environment: 'priceflag-ml-release', branches: ['codex/prod-integration'], requireReviewer: true },
  ), /self-review prevention/);
  assert.throws(() => guard.assertEnvironmentConfiguration(
    protectedEnvironment,
    { branch_policies: [{ name: 'codex/prod-integration' }, { name: 'main' }] },
    { environment: 'priceflag-ml-release', branches: ['codex/prod-integration'], requireReviewer: true },
  ), /branch allowlist/);
  passed += 4;

  let requested = '';
  let authorization = '';
  const validFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requested = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(
      JSON.stringify({
        projectId: 'prj_RU8NlBDoR7t89BNqn5BagOpmpnmm',
        url: 'priceflag-git-beta-owner.vercel.app',
        readyState: 'READY',
        target: null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  assert.deepEqual(await attestLiveWriteTarget(base, validFetch), requireLiveWriteTarget(base));
  assert.match(requested, /^https:\/\/api\.vercel\.com\/v13\/deployments\/priceflag-git-beta-owner\.vercel\.app\?teamId=team_AqaBD6YaOf9DIJ7NzbytTZTW$/);
  assert.equal(authorization, 'Bearer test-only-vercel-token');
  passed += 3;

  const response = (body: Record<string, unknown>): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  await assert.rejects(
    attestLiveWriteTarget(base, () => response({
      projectId: 'prj_attacker',
      url: 'priceflag-git-beta-owner.vercel.app',
      readyState: 'READY',
      target: null,
    })),
    /outside the pinned Priceflag Vercel project/,
  );
  await assert.rejects(
    attestLiveWriteTarget(base, () => response({
      projectId: 'prj_RU8NlBDoR7t89BNqn5BagOpmpnmm',
      url: 'priceflag-git-beta-owner.vercel.app',
      readyState: 'READY',
      target: 'production',
    })),
    /production-target deployment/,
  );
  passed += 2;
}

void verifyAttestation()
  .then(() => process.stdout.write(`deployment safety: ${passed} passed\n`))
  .catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    process.exitCode = 1;
  });
