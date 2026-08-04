import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  attestLiveWriteTarget,
  isVerifiedRollback,
  requireLiveWriteTarget,
} from '../scripts/live-write-guard';

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
passed += 5;

const demoAccess = readFileSync(resolve(process.cwd(), 'scripts/vercel-demo-access.sh'), 'utf8');
assert.match(demoAccess, /PROJECT_ID="prj_RU8NlBDoR7t89BNqn5BagOpmpnmm"/);
assert.match(demoAccess, /TEAM_SCOPE="team_AqaBD6YaOf9DIJ7NzbytTZTW"/);
assert.match(demoAccess, /api\.vercel\.com\/v9\/projects/);
assert.match(demoAccess, /_DEMO_ACCESS:\$COMMIT/);
assert.doesNotMatch(demoAccess, /deploy --prod|alias set|"\$\{VC\[@\]\}" promote/);
assert.ok(demoAccess.indexOf('api.vercel.com/v9/projects') < demoAccess.indexOf('env rm'));
passed += 6;

async function verifyAttestation(): Promise<void> {
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
