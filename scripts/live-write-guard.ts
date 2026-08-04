const FORBIDDEN_HOSTS = new Set([
  'priceflag.vercel.app',
  'priceflagv1.vercel.app',
  'priceflag-app.vercel.app',
]);

const PRICEFLAG_VERCEL_PROJECT_ID = 'prj_RU8NlBDoR7t89BNqn5BagOpmpnmm';
const PRICEFLAG_VERCEL_TEAM_ID = 'team_AqaBD6YaOf9DIJ7NzbytTZTW';

export interface LiveWriteTarget {
  baseUrl: string;
  expectedShopDomain: string;
  vercelBypassSecret: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RollbackOutcome {
  fully_applied: boolean;
  failed: number;
  external_changes: readonly unknown[];
}

interface RollbackVerification {
  mismatched: readonly unknown[];
}

export function isVerifiedRollback(
  outcome: RollbackOutcome,
  verification: RollbackVerification,
): boolean {
  return (
    outcome.fully_applied &&
    outcome.failed === 0 &&
    outcome.external_changes.length === 0 &&
    verification.mismatched.length === 0
  );
}

type Environment = Readonly<Record<string, string | undefined>>;

function requireValue(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Fail-closed boundary for operator scripts that intentionally write a price.
 * The test must target an explicitly named shop and a non-production artifact.
 */
export function requireLiveWriteTarget(env: Environment): LiveWriteTarget {
  const rawUrl = requireValue(env, 'PRICEFLAG_URL');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('PRICEFLAG_URL must be an absolute URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PRICEFLAG_URL must be a clean HTTPS origin');
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname.endsWith('.vercel.app')) {
    throw new Error('PRICEFLAG_URL must be a Vercel deployment owned by the pinned Priceflag project');
  }
  if (FORBIDDEN_HOSTS.has(hostname)) {
    throw new Error(`Refusing live-write test against production or legacy host ${hostname}`);
  }

  const expectedShopDomain = requireValue(env, 'PRICEFLAG_CP4_SHOP_DOMAIN').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(expectedShopDomain)) {
    throw new Error('PRICEFLAG_CP4_SHOP_DOMAIN must be an exact *.myshopify.com domain');
  }
  const expectedConfirmation = `WRITE_TEST_PRICES:${expectedShopDomain}`;
  if (env.PRICEFLAG_CP4_CONFIRM !== expectedConfirmation) {
    throw new Error(`Set PRICEFLAG_CP4_CONFIRM=${expectedConfirmation} to acknowledge temporary test-store writes`);
  }

  return {
    baseUrl: url.origin,
    expectedShopDomain,
    vercelBypassSecret: requireValue(env, 'VERCEL_AUTOMATION_BYPASS_SECRET'),
  };
}

/**
 * Ask Vercel—not DNS or the operator—to prove the target belongs to Priceflag.
 * This must complete before any application, bypass, or ingest secret is sent.
 */
export async function attestLiveWriteTarget(
  env: Environment,
  fetcher: Fetch = fetch,
): Promise<LiveWriteTarget> {
  const target = requireLiveWriteTarget(env);
  const vercelToken = requireValue(env, 'VERCEL_TOKEN');
  const hostname = new URL(target.baseUrl).hostname;
  const endpoint =
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(hostname)}` +
    `?teamId=${encodeURIComponent(PRICEFLAG_VERCEL_TEAM_ID)}`;
  const response = await fetcher(endpoint, {
    method: 'GET',
    headers: { authorization: `Bearer ${vercelToken}` },
  });
  if (!response.ok) {
    throw new Error(`Vercel deployment attestation failed with HTTP ${response.status}`);
  }
  const deployment = (await response.json()) as {
    projectId?: unknown;
    project?: { id?: unknown };
    url?: unknown;
    readyState?: unknown;
    target?: unknown;
  };
  const projectId = deployment.projectId ?? deployment.project?.id;
  if (projectId !== PRICEFLAG_VERCEL_PROJECT_ID) {
    throw new Error('Refusing deployment outside the pinned Priceflag Vercel project');
  }
  if (deployment.url !== hostname) {
    throw new Error('Vercel attestation returned a different deployment URL');
  }
  if (deployment.readyState !== 'READY') {
    throw new Error('Vercel deployment is not READY');
  }
  if (deployment.target === 'production') {
    throw new Error('Refusing live-write test against a production-target deployment');
  }
  return target;
}
