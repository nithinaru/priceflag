const PRODUCTION_PROJECT_REF = 'vnyqevrdvfjsfhdnbfsz';

type Environment = Readonly<Record<string, string | undefined>>;

export interface StagingGateConfig {
  projectRef: string;
  supabaseUrl: string;
  databaseUrl: string;
  sentinel: string;
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function requireStagingGateConfig(env: Environment): StagingGateConfig {
  const projectRef = required(env, 'STAGING_SUPABASE_PROJECT_REF');
  if (!/^[a-z]{20}$/.test(projectRef)) {
    throw new Error('STAGING_SUPABASE_PROJECT_REF must be a 20-letter project ref');
  }
  if (projectRef === PRODUCTION_PROJECT_REF) {
    throw new Error('Refusing to run a staging mutation against the Priceflag production project');
  }

  const rawUrl = required(env, 'SUPABASE_URL');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL must be an absolute URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== `${projectRef}.supabase.co` ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('SUPABASE_URL must be the exact HTTPS API origin for the pinned staging project');
  }

  const rawDatabaseUrl = required(env, 'SUPABASE_DB_URL');
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
  } catch {
    throw new Error('SUPABASE_DB_URL must be an absolute PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) {
    throw new Error('SUPABASE_DB_URL must be an absolute PostgreSQL URL');
  }
  if (rawDatabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error('Refusing a database URL that references the Priceflag production project');
  }

  const expectedCommit = required(env, 'GITHUB_SHA');
  if (required(env, 'SUPABASE_CONFIRM_COMMIT') !== expectedCommit) {
    throw new Error('The acknowledged staging commit does not match GITHUB_SHA');
  }
  if (required(env, 'SUPABASE_CONFIRM_ACTION') !== 'APPLY_STAGING_MIGRATIONS') {
    throw new Error('SUPABASE_CONFIRM_ACTION must be APPLY_STAGING_MIGRATIONS');
  }
  required(env, 'SUPABASE_SERVICE_ROLE_KEY');

  return {
    projectRef,
    supabaseUrl: url.origin,
    databaseUrl: rawDatabaseUrl,
    sentinel: required(env, 'SUPABASE_STAGING_SENTINEL'),
  };
}

export interface StagingIdentity {
  environment: unknown;
  projectRef: unknown;
  sentinel: unknown;
}

export function assertStagingIdentity(
  identity: StagingIdentity,
  config: StagingGateConfig,
): void {
  if (identity.environment !== 'staging') {
    throw new Error('Connected database is not explicitly marked as staging');
  }
  if (identity.projectRef !== config.projectRef) {
    throw new Error('Connected database project ref does not match the protected staging ref');
  }
  if (identity.sentinel !== config.sentinel) {
    throw new Error('Connected database does not contain the protected staging sentinel');
  }
}
