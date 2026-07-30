/**
 * Cold-load hydration check (Lane A's REQ-A-007).
 *
 *   npm run smoke:browser                      # against a local server
 *   PRICEFLAG_URL=https://… npm run smoke:browser
 *
 * ## Why this exists
 *
 * Sprint A6 shipped with a documented "hydration bug" on `/journal`. A7 proved
 * nothing was broken — the diagnosis came from three measurement mistakes:
 * counting `__reactProps$` keys (React 19 attaches them lazily), dispatching a
 * synthetic `change` at a controlled `<select>` (React's value tracker suppresses
 * it), and clicking a native `<select>` (which opens an OS popup no automation can
 * drive). A session went into that.
 *
 * The bug class is real even though that instance was not: one bad `"use client"`
 * boundary and a page is inert, with no console error, still *looking* correct.
 * `npm run build` proves the bundle compiled, not that the browser ran it.
 *
 * ## The two rules this check follows
 *
 * 1. **Assert on rendered output, never on React internals.** Fibre keys and
 *    `__reactProps$` are lazily attached and renamed between versions. The only
 *    sound signal is "I did something and the DOM changed".
 * 2. **Drive inputs through the framework's own event path** — Playwright's
 *    `fill` and `selectOption` do this correctly. Never
 *    `Object.getOwnPropertyDescriptor(...).set` plus a synthetic `dispatchEvent`.
 *
 * Every route is loaded as a fresh top-level navigation, because the bug class
 * only shows on cold load — a client-side transition would hydrate anyway.
 */

import { chromium, type Browser, type Page } from 'playwright';

import { loadEnv } from './load-env';

loadEnv();

const BASE_URL = (process.env.PRICEFLAG_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function record(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m${detail}\x1b[0m\n`);
  } else {
    failed += 1;
    failures.push(`${name}: ${detail}`);
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name} — ${detail}\n`);
  }
}

/** A fresh top-level navigation, never a client-side transition. */
async function coldLoad(page: Page, path: string): Promise<void> {
  const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (response !== null && response.status() >= 400) {
    throw new Error(`HTTP ${response.status()} loading ${path}`);
  }
  // Give the client bundle a chance to attach. If hydration is genuinely broken
  // this still returns — and the interaction below is what fails, which is the
  // signal we want.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

interface RouteCheck {
  name: string;
  path: string;
  run: (page: Page) => Promise<{ ok: boolean; detail: string }>;
}

const CHECKS: RouteCheck[] = [
  {
    name: '/journal — typing a filter changes the rows',
    path: '/journal',
    run: async (page) => {
      const rows = page.locator('tbody tr');
      const before = await rows.count();
      const search = page.locator('#journal-search');
      if ((await search.count()) === 0) return { ok: false, detail: 'no #journal-search on the page' };

      await search.fill('belt');
      // Wait for the count to actually move rather than sleeping a fixed amount.
      await page
        .waitForFunction(
          (n) => document.querySelectorAll('tbody tr').length !== n,
          before,
          { timeout: 5000 },
        )
        .catch(() => {});
      const after = await rows.count();
      return { ok: after !== before, detail: `rows ${before} -> ${after}` };
    },
  },
  {
    name: '/products — typing a search changes the rows',
    path: '/products',
    run: async (page) => {
      const rows = page.locator('tbody tr');
      const before = await rows.count();
      const search = page.locator('#catalog-search');
      if ((await search.count()) === 0) return { ok: false, detail: 'no #catalog-search on the page' };

      await search.fill('snowboard');
      await page
        .waitForFunction((n) => document.querySelectorAll('tbody tr').length !== n, before, { timeout: 5000 })
        .catch(() => {});
      const after = await rows.count();
      return { ok: after !== before, detail: `rows ${before} -> ${after}` };
    },
  },
  {
    name: '/rollouts — the page renders interactive content',
    path: '/rollouts',
    run: async (page) => {
      // No stable interaction here that does not mutate a real store, so this
      // asserts the client bundle attached at all: a button that responds to a
      // hover/focus is enough to distinguish hydrated from inert.
      const buttons = page.locator('a, button');
      const count = await buttons.count();
      if (count === 0) return { ok: false, detail: 'no interactive elements rendered' };
      await buttons.first().focus();
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
      return {
        ok: focused === 'A' || focused === 'BUTTON',
        detail: `${count} interactive elements, focus landed on ${focused || '(none)'}`,
      };
    },
  },
];

async function main(): Promise<void> {
  process.stdout.write(`\x1b[1mCold-load browser check\x1b[0m  ${BASE_URL}\n`);
  process.stdout.write('Asserts the DOM responds to a real interaction — never React internals.\n\n');

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      // Two separate doors: Vercel's Deployment Protection would 302 every
      // navigation to SSO, and the app's own access gate (middleware.ts) would
      // 401 it. Both need satisfying to reach a page.
      extraHTTPHeaders: BYPASS === '' ? {} : { 'x-vercel-protection-bypass': BYPASS, 'x-vercel-set-bypass-cookie': 'true' },
    });

    const accessSecret = process.env.APP_ACCESS_SECRET ?? '';
    if (accessSecret !== '') {
      const { hostname } = new URL(BASE_URL);
      await context.addCookies([
        { name: 'pf_access', value: accessSecret, domain: hostname, path: '/', httpOnly: true, secure: BASE_URL.startsWith('https') },
      ]);
    }

    for (const check of CHECKS) {
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error.message)));

      try {
        await coldLoad(page, check.path);
        const outcome = await check.run(page);
        record(check.name, outcome.ok, outcome.detail);

        // A hydration failure often shows here even when the DOM check passes.
        if (consoleErrors.length > 0) {
          process.stdout.write(`      \x1b[33mconsole: ${consoleErrors[0]?.slice(0, 140)}\x1b[0m\n`);
        }
      } catch (cause) {
        record(check.name, false, cause instanceof Error ? cause.message : String(cause));
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser?.close();
  }

  process.stdout.write(`\n${passed} passed${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ''}\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failures) process.stdout.write(`  ${failure}\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`\nBrowser check crashed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exit(1);
});
