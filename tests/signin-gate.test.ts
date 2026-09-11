/**
 * Pins the sign-in door.
 *
 * There is one way in now — install the Shopify app — so what this file guards
 * is that nothing quietly grows a second one: no shared preview secret, no HTTP
 * Basic prompt, no emailed link, and no route that mints a session without a
 * Shopify signature behind it.
 *
 * Reads `middleware.ts` as text (same idea as `tests/deployment-safety.test.ts`)
 * rather than importing it, because importing pulls in `next/server`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  allowedSessionHosts,
  canonicalSessionUrl,
  oauthCallbackUrl,
  sessionOrigin,
} from '../lib/auth/session-host';
import { allowedOrigin, signInScreenUrl } from '../lib/auth/signin-origin';
import { defaultRedirectUri } from '../lib/shopify/oauth';
import { normalizeStoreAddress } from '../lib/shopify/store-address';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const middleware = read('middleware.ts');
const exemptBlock = middleware.match(/const EXEMPT_EXACT = new Set\(\[([\s\S]*?)\]\)/);
assert(exemptBlock !== null, 'EXEMPT_EXACT is missing');
const exempt = exemptBlock[1] as string;
const middlewareBody = middleware.slice(middleware.indexOf('export async function middleware'));

// ---------------------------------------------------------------------------
// The door itself
// ---------------------------------------------------------------------------

test('/signin is reachable without a session', () => {
  assert(/['"]\/signin['"]/.test(exempt), '/signin missing from EXEMPT_EXACT');
});

test('the OAuth round-trip is reachable without a session', () => {
  assert(/['"]\/api\/auth['"]/.test(exempt), '/api/auth missing from EXEMPT_EXACT');
  assert(/['"]\/api\/auth\/callback['"]/.test(exempt), '/api/auth/callback missing from EXEMPT_EXACT');
});

test('nothing else has been added to the exempt list', () => {
  const paths = [...exempt.matchAll(/['"](\/[^'"]*)['"]/g)].map((match) => match[1] as string);
  const allowed = new Set([
    '/api/health',
    '/api/cron/evaluate',
    '/api/ml/ingest',
    '/api/ml/export',
    '/api/auth',
    '/api/auth/callback',
    '/api/auth/demo',
    '/signin',
  ]);
  for (const path of paths) {
    assert(allowed.has(path), `${path} was added to EXEMPT_EXACT without review`);
  }
});

// ---------------------------------------------------------------------------
// The doors that were removed, and must stay removed
// ---------------------------------------------------------------------------

test('the shared preview secret is gone', () => {
  assert(!middleware.includes('APP_ACCESS_SECRET'), 'APP_ACCESS_SECRET is back in middleware');
  assert(!middleware.includes('pf_access'), 'the pf_access cookie is back');
  assert(
    !/searchParams\.get\(\s*['"]access['"]\s*\)/.test(middleware),
    'the ?access= cookie-minting query parameter is back',
  );
});

test('no HTTP Basic prompt on any response', () => {
  assert(
    !/www-authenticate/i.test(middleware),
    'middleware must never send WWW-Authenticate — it produces a browser password dialog',
  );
  assert(!middleware.includes('DEMO_PASSWORD'), 'the demo Basic-auth login is back');
});

test('the magic-link flow is gone', () => {
  assert(!middleware.includes('magic-link'), 'a magic-link route is exempt again');
  for (const path of [
    'app/api/auth/magic-link/route.ts',
    'app/auth/callback/route.ts',
    'lib/auth/supabase-auth.ts',
    'lib/auth/link-binding.ts',
  ]) {
    let exists = true;
    try {
      read(path);
    } catch {
      exists = false;
    }
    assert(!exists, `${path} is back — the magic-link flow was replaced, not restored`);
  }
});

test('sign-in bounces carry no ?next= redirect sink', () => {
  assert(
    !/searchParams\.set\(\s*['"]next['"]/.test(middleware),
    'signInRequired must not echo a destination back into the sign-in URL',
  );
});

// ---------------------------------------------------------------------------
// Order of admission
// ---------------------------------------------------------------------------

test('a Shopify signature is checked before our own cookie', () => {
  const shopify = middlewareBody.indexOf('isShopifyAuthenticated(request)');
  const account = middlewareBody.indexOf('hasAccountSession(request)');
  assert(shopify !== -1, 'Shopify admission is missing');
  assert(account !== -1, 'pf_user admission is missing');
  assert(shopify < account, 'Shopify-signed traffic must be admitted first');
});

test('alias hosts bounce before any cookie is read', () => {
  const bounce = middlewareBody.indexOf('canonicalSessionUrl');
  const exemptCheck = middlewareBody.indexOf('isExempt(pathname)');
  assert(bounce !== -1 && exemptCheck !== -1, 'host canonicalisation is missing');
  assert(bounce < exemptCheck, 'host bounce must run before exemptions');
});

test('anything unrecognised ends at the sign-in screen', () => {
  const fn = middlewareBody.slice(0, middlewareBody.indexOf('\nexport const config'));
  assert(
    fn.trimEnd().endsWith('return signInRequired(request);\n}'),
    'the fall-through must be signInRequired, not an open NextResponse.next()',
  );
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

test('sign-in is one Shopify action and nothing else', () => {
  const form = read('app/signin/sign-in-form.tsx');
  assert(form.includes('Continue with Shopify'), 'primary action must be Shopify');
  assert(form.includes('${appUrl}/api/auth?shop='), 'OAuth start must be absolute on the app host');
  assert(!/Email me a link/.test(form), 'the email door is back on the sign-in screen');
  assert(!/<details/.test(form), 'a disclosure means a second door has reappeared');
  assert(
    form.includes('type="password"') === false,
    'Priceflag has no password to collect',
  );
});

test('the demo session route exists only in demo mode', () => {
  const route = read('app/api/auth/demo/route.ts');
  assert(route.includes('isDemoMode()'), 'demo route must gate on demo mode');
  assert(route.includes('404'), 'a real deployment must 404, not 403');
  assert(!/export async function GET/.test(route), 'minting a session on GET is prefetchable');
});

test('store addresses are accepted in the shapes merchants actually type', () => {
  assert(normalizeStoreAddress('my-store') === 'my-store.myshopify.com', 'bare handle');
  assert(normalizeStoreAddress('  My-Store.myshopify.com ') === 'my-store.myshopify.com', 'case and space');
  assert(normalizeStoreAddress('https://my-store.myshopify.com/admin') === 'my-store.myshopify.com', 'full URL');
  assert(
    normalizeStoreAddress('https://admin.shopify.com/store/my-store/products') === 'my-store.myshopify.com',
    'pasted Shopify admin URL',
  );
  assert(normalizeStoreAddress('') === null, 'empty input');
  assert(normalizeStoreAddress('not a domain') === null, 'spaces inside a handle');
  assert(normalizeStoreAddress('-leading-hyphen') === null, 'handles cannot start with a hyphen');
});

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('signInScreenUrl defaults to this app /signin', () => {
  withEnv(
    {
      APP_URL: 'https://pilot.priceflag.org',
      SIGNIN_URL: undefined,
      SIGNIN_ORIGINS: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    },
    () => {
      assert(signInScreenUrl() === 'https://pilot.priceflag.org/signin', signInScreenUrl());
      assert(
        signInScreenUrl({ error: 'sign_in_required' }) ===
          'https://pilot.priceflag.org/signin?error=sign_in_required',
        'query params must land on /signin',
      );
      assert(
        allowedOrigin('https://signin.priceflag.org') === 'https://signin.priceflag.org',
        'marketing origin',
      );
      assert(allowedOrigin('https://evil.example') === null, 'unknown origin refused');
    },
  );
});

test('the OAuth callback stays on the session host', () => {
  withEnv(
    {
      APP_URL: 'https://dashboard.priceflag.org',
      VERCEL_ENV: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert(sessionOrigin() === 'https://dashboard.priceflag.org', sessionOrigin());
      assert(
        oauthCallbackUrl() === 'https://dashboard.priceflag.org/api/auth/callback',
        oauthCallbackUrl(),
      );
      assert(
        defaultRedirectUri() === 'https://dashboard.priceflag.org/api/auth/callback',
        defaultRedirectUri(),
      );
      assert(
        allowedSessionHosts().includes('dashboard.priceflag.org'),
        'dashboard must be an allowed session host',
      );
      assert(
        canonicalSessionUrl('signin.priceflag.org', '/api/auth/callback', '?code=abc') ===
          'https://dashboard.priceflag.org/api/auth/callback?code=abc',
        'branded door must preserve the OAuth query on the session host',
      );
      assert(
        canonicalSessionUrl('signin.priceflag.org', '/') === 'https://dashboard.priceflag.org/signin',
        'signin host root must land on dashboard /signin',
      );
      assert(
        canonicalSessionUrl('product.priceflag.org', '/') === 'https://dashboard.priceflag.org/signin',
        'product host is an app door, not a second cookie host',
      );
      assert(
        canonicalSessionUrl('dashboard.priceflag.org', '/signin') === null,
        'session host must not bounce to itself',
      );
      assert(canonicalSessionUrl('priceflag.org', '/') === null, 'marketing apex stays on priceflagv1');
    },
  );
});

test('production never sends a localhost or vercel.app callback to Shopify', () => {
  withEnv(
    {
      VERCEL_ENV: 'production',
      APP_URL: 'http://localhost:3000',
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_URL: undefined,
    },
    () => {
      assert(sessionOrigin() === 'https://dashboard.priceflag.org', sessionOrigin());
      assert(
        oauthCallbackUrl() === 'https://dashboard.priceflag.org/api/auth/callback',
        oauthCallbackUrl(),
      );
    },
  );
});

test('SIGNIN_URL still overrides the screen for a non-marketing origin', () => {
  withEnv(
    { SIGNIN_URL: 'https://pilot.priceflag.org/signin', APP_URL: 'https://pilot.priceflag.org' },
    () => {
      assert(
        signInScreenUrl({ error: 'sign_in_required' }).startsWith('https://pilot.priceflag.org/signin'),
        'SIGNIN_URL override ignored',
      );
    },
  );
});

test('SIGNIN_URL on the branded door is ignored', () => {
  withEnv(
    {
      SIGNIN_URL: 'https://signin.priceflag.org/',
      APP_URL: 'https://dashboard.priceflag.org',
      VERCEL_ENV: 'production',
    },
    () => {
      assert(
        signInScreenUrl({ error: 'sign_in_required' }).startsWith(
          'https://dashboard.priceflag.org/signin',
        ),
        'branded SIGNIN_URL must not steal the session host',
      );
    },
  );
});

test('next.config 308s alias hosts onto the dashboard', () => {
  const config = read('next.config.ts');
  assert(config.includes("'signin.priceflag.org'"), 'signin host redirect missing');
  assert(config.includes("'product.priceflag.org'"), 'product host redirect missing');
  assert(config.includes('https://dashboard.priceflag.org'), 'dashboard origin missing from redirects');
  assert(config.includes('/signin'), 'dashboard sign-in destination missing');
  assert(config.includes('permanent: true'), 'redirects must be 308');
});

// ---------------------------------------------------------------------------
// Scopes — the one consent screen is the whole permission conversation
// ---------------------------------------------------------------------------

test('OAuth asks for read and write on prices, and nothing it cannot use', () => {
  const config = read('lib/config.ts');
  const block = config.slice(config.indexOf('DEFAULT_SHOPIFY_SCOPES'));
  for (const scope of [
    'read_products',
    'write_products',
    'read_orders',
    'read_all_orders',
    'read_inventory',
    'write_inventory',
    'read_price_rules',
    'write_price_rules',
  ]) {
    assert(block.includes(scope), `${scope} missing from the OAuth scope list`);
  }
  for (const scope of ['read_customers', 'write_customers', 'read_users']) {
    assert(!block.includes(scope), `${scope} is requested but nothing in the app reads it`);
  }
});

test('health reports the scopes the deployment would actually request', () => {
  const health = read('app/api/health/route.ts');
  assert(health.includes('shopify_scopes: getShopifyScopes()'), 'health must report resolved scopes');
  // A stale SHOPIFY_SCOPES override silently wins over the code default and
  // cannot be read back from Vercel, so this field is the only way to see it.
  assert(!/SHOPIFY_API_SECRET|SERVICE_ROLE|ENCRYPTION_KEY/.test(health), 'health must not echo secrets');
});

test('an account resolves to its store without depending on the link row', () => {
  const source = read('lib/auth/account-shops.ts');
  const fn = source.slice(source.indexOf('export async function getShopDomainForAccount'));
  const direct = fn.indexOf('SHOPS_TABLE');
  const link = fn.indexOf('LINKS_TABLE');
  assert(direct !== -1, 'the shop row must be consulted directly');
  assert(link !== -1, 'the legacy link fallback must remain for pre-store-keyed accounts');
  assert(direct < link, 'the authoritative shop row must be read before the link record');
});

process.stdout.write(`${passed}/${passed} sign-in gate tests passed\n`);
