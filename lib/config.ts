/**
 * Environment. Read lazily through functions, never captured at module load —
 * Next.js evaluates modules at build time where the runtime env does not exist
 * yet, and a value frozen at build time is a confusing production bug.
 */

export type Mode = 'demo' | 'real';

/**
 * Admin GraphQL API version. Shopify ships quarterly (Jan/Apr/Jul/Oct) and
 * supports each version for 12 months. Pinned, never "unstable" — an
 * unpinned version means the schema can change under a running rollout.
 */
export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

/**
 * Scopes requested during OAuth.
 *
 * The invite-only beta uses Partner custom distribution, so `read_all_orders`
 * is mandatory. Shopify must approve that scope before a beta store is invited;
 * without it the Admin API silently caps history at 60 days and a 180-day
 * forecast would be misleading. Admin-created static-token apps remain a local
 * development path only and do not use this OAuth scope list.
 */
export const DEFAULT_SHOPIFY_SCOPES =
  'read_products,write_products,read_orders,read_all_orders';

export function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function requireEnv(name: string, hint?: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}.${hint ? ` ${hint}` : ''}`);
  }
  return value;
}

export function getMode(): Mode {
  const raw = (env('PRICEFLAG_MODE') ?? '').toLowerCase();
  if (raw === 'demo' || raw === 'real') return raw;
  // Default by capability, not by guesswork: with no Supabase configured the
  // only thing that can work is the demo store.
  return hasSupabaseConfig() ? 'real' : 'demo';
}

export function isDemoMode(): boolean {
  return getMode() === 'demo';
}

export function hasSupabaseConfig(): boolean {
  return env('SUPABASE_URL') !== undefined && env('SUPABASE_SERVICE_ROLE_KEY') !== undefined;
}

/** Path B: OAuth credentials for a Partner-Dashboard app. */
export function hasShopifyConfig(): boolean {
  return env('SHOPIFY_API_KEY') !== undefined && env('SHOPIFY_API_SECRET') !== undefined;
}

/** Path A: a static Admin API token from an admin-created custom app. */
export function hasStaticShopifyToken(): boolean {
  return env('SHOPIFY_ADMIN_ACCESS_TOKEN') !== undefined && env('SHOPIFY_SHOP_DOMAIN') !== undefined;
}

export function getStaticShopDomain(): string | undefined {
  return env('SHOPIFY_SHOP_DOMAIN')?.trim().toLowerCase();
}

export function getShopifyApiVersion(): string {
  return env('SHOPIFY_API_VERSION') ?? DEFAULT_SHOPIFY_API_VERSION;
}

export function getShopifyScopes(): string[] {
  return (env('SHOPIFY_SCOPES') ?? DEFAULT_SHOPIFY_SCOPES)
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/** Public origin, no trailing slash. */
export function getAppUrl(): string {
  const raw = env('APP_URL') ?? env('VERCEL_PROJECT_PRODUCTION_URL') ?? 'http://localhost:3000';
  const withScheme = raw.startsWith('http') ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

export function getDemoStatePath(): string {
  return env('PRICEFLAG_DEMO_STATE') ?? '.priceflag/demo-state.json';
}

/** Which config is present. Powers `GET /api/health` and the smoke test's skips. */
export function describeEnvironment(): {
  mode: Mode;
  supabase: boolean;
  shopify: boolean;
  shopifyStaticToken: boolean;
  encryption: boolean;
  resend: boolean;
  cronSecret: boolean;
  shopifyApiVersion: string;
} {
  return {
    mode: getMode(),
    supabase: hasSupabaseConfig(),
    shopify: hasShopifyConfig(),
    shopifyStaticToken: hasStaticShopifyToken(),
    encryption: env('ENCRYPTION_KEY') !== undefined,
    resend: env('RESEND_API_KEY') !== undefined,
    cronSecret: env('CRON_SECRET') !== undefined,
    shopifyApiVersion: getShopifyApiVersion(),
  };
}
