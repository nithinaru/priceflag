/**
 * Pins the sign-in gate: `/signin` and `/auth/callback` are reachable without
 * APP_ACCESS_SECRET, HTML failures redirect to `/signin` instead of prompting
 * HTTP Basic, and the in-app screen is the default sign-in URL.
 *
 * Reads `middleware.ts` as text (same idea as `tests/deployment-safety.test.ts`)
 * so a later edit cannot silently restore the password dialog on magic-link
 * landings. Does not import middleware — it pulls in `next/server`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { allowedOrigin, signInScreenUrl } from '../lib/auth/signin-origin';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function test(name: string, run: () => void): void {
  run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const middleware = readFileSync(resolve(process.cwd(), 'middleware.ts'), 'utf8');
const exemptBlock = middleware.match(/const EXEMPT_EXACT = new Set\(\[([\s\S]*?)\]\)/);
assert(exemptBlock !== null, 'EXEMPT_EXACT is missing');
const exempt = exemptBlock[1] as string;

function sliceFn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert(start !== -1, `middleware.ts is missing function ${name}`);
  const next = source.indexOf('\nfunction ', start + 1);
  const exported = source.indexOf('\nexport ', start + 1);
  let end = source.length;
  if (next !== -1) end = Math.min(end, next);
  if (exported !== -1) end = Math.min(end, exported);
  return source.slice(start, end);
}

test('/signin is preview-exempt', () => {
  assert(/['"]\/signin['"]/.test(exempt), '/signin missing from EXEMPT_EXACT');
});

test('/auth/callback is preview-exempt', () => {
  assert(/['"]\/auth\/callback['"]/.test(exempt), '/auth/callback missing from EXEMPT_EXACT');
});

test('/api/auth/magic-link stays preview-exempt', () => {
  assert(/['"]\/api\/auth\/magic-link['"]/.test(exempt), 'magic-link missing from EXEMPT_EXACT');
});

test('HTML preview failure redirects to /signin instead of only unauthorized()', () => {
  assert(middleware.includes('function previewDenied'), 'previewDenied helper is missing');
  assert(
    /target\.pathname = ['"]\/signin['"]/.test(middleware),
    'sign-in redirect does not set pathname /signin',
  );
  assert(
    middleware.includes('return previewDenied(request)'),
    'preview-gate failure must call previewDenied, not only unauthorized()',
  );
  const denied = sliceFn(middleware, 'previewDenied');
  const required = sliceFn(middleware, 'signInRequired');
  assert(denied.includes('signInRequired'), 'previewDenied must redirect pages via signInRequired');
  assert(
    !/headers\.set\([^)]*www-authenticate/i.test(denied) &&
      !/headers\.set\([^)]*www-authenticate/i.test(required),
    'HTML sign-in redirect must not send WWW-Authenticate',
  );
});

test('WWW-Authenticate Basic realm is not sent on every 401', () => {
  const unauth = sliceFn(middleware, 'unauthorized');
  assert(/DEMO_USERNAME/.test(unauth), 'Basic prompt must be gated on DEMO_USERNAME');
  const afterAccount = middleware.slice(middleware.indexOf('export async function middleware'));
  assert(
    !/headers\.set\(\s*['"]www-authenticate['"]/.test(afterAccount),
    'middleware() itself must not set WWW-Authenticate',
  );
});

test('a valid pf_user is admitted before APP_ACCESS_SECRET', () => {
  const body = middleware.slice(middleware.indexOf('export async function middleware'));
  const session = body.indexOf('hasAccountSession(request)) return NextResponse.next()');
  const secret = body.indexOf('process.env.APP_ACCESS_SECRET');
  assert(session !== -1, 'hasAccountSession early admit is missing');
  assert(secret !== -1, 'APP_ACCESS_SECRET check is missing');
  assert(session < secret, 'pf_user must be admitted before the preview secret');
});

test('signInScreenUrl defaults to this app /signin', () => {
  const previous = {
    APP_URL: process.env.APP_URL,
    SIGNIN_URL: process.env.SIGNIN_URL,
    SIGNIN_ORIGINS: process.env.SIGNIN_ORIGINS,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  };
  process.env.APP_URL = 'https://pilot.priceflag.org';
  delete process.env.SIGNIN_URL;
  delete process.env.SIGNIN_ORIGINS;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  process.env.NODE_ENV = 'test';
  try {
    assert(
      signInScreenUrl() === 'https://pilot.priceflag.org/signin',
      `default was ${signInScreenUrl()}`,
    );
    assert(
      signInScreenUrl({ error: 'link_expired' }) ===
        'https://pilot.priceflag.org/signin?error=link_expired',
      'query params must land on /signin',
    );
    assert(allowedOrigin('https://signin.priceflag.org') === 'https://signin.priceflag.org', 'marketing origin');
    assert(allowedOrigin('https://pilot.priceflag.org') === 'https://pilot.priceflag.org', 'APP_URL origin');
    assert(allowedOrigin('https://evil.example') === null, 'unknown origin refused');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('sign-in UI is Shopify-first, email is a return path', () => {
  const form = readFileSync(resolve(process.cwd(), 'app/signin/sign-in-form.tsx'), 'utf8');
  assert(form.includes('Continue with Shopify'), 'primary action must be Shopify');
  assert(form.includes('<details'), 'email must be behind a disclosure, not a second equal door');
  const shopIndex = form.indexOf('Continue with Shopify');
  const emailIndex = form.indexOf('Email me a link');
  assert(shopIndex !== -1 && emailIndex !== -1 && shopIndex < emailIndex, 'Shopify must precede email');
});

test('SIGNIN_URL still overrides the screen location', () => {
  const previous = process.env.SIGNIN_URL;
  process.env.SIGNIN_URL = 'https://signin.priceflag.org/';
  process.env.APP_URL = process.env.APP_URL ?? 'https://pilot.priceflag.org';
  try {
    assert(
      signInScreenUrl({ error: 'sign_in_required' }).startsWith('https://signin.priceflag.org/'),
      'SIGNIN_URL override ignored',
    );
  } finally {
    if (previous === undefined) delete process.env.SIGNIN_URL;
    else process.env.SIGNIN_URL = previous;
  }
});

process.stdout.write(`${passed}/${passed} sign-in gate tests passed\n`);
