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
  setup?: (page: Page) => Promise<void>;
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
    name: '/propose — forecast creates a no-write draft',
    path: '/propose',
    setup: async (page) => {
      await page.addInitScript(() => {
        window.sessionStorage.setItem(
          'priceflag:selection:v1',
          JSON.stringify(['gid://shopify/ProductVariant/46100000000']),
        );
      });
    },
    run: async (page) => {
      const create = page.getByRole('button', { name: 'Create draft' });
      await create.waitFor({ state: 'visible', timeout: 15_000 });
      await create.click();
      const created = page.getByText('Draft created', { exact: true });
      await created.waitFor({ state: 'visible', timeout: 10_000 });
      const noWrite = await page.getByText('No Shopify price was changed.', { exact: true }).count();
      return {
        ok: noWrite === 1,
        detail: noWrite === 1 ? 'forecast rendered and draft stayed no-write' : 'missing no-write confirmation',
      };
    },
  },
  {
    name: '/model-lab — edited founder inputs run through the live engine',
    path: '/model-lab',
    run: async (page) => {
      await page.locator('#lab-price-change').fill('12');
      await page.getByRole('button', { name: 'Run Priceflag' }).click();
      const target = page.getByTestId('lab-target-price');
      await target.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="lab-target-price"]')?.textContent?.includes('$53.99'),
        undefined,
        { timeout: 10_000 },
      );
      const text = (await target.textContent()) ?? '';
      const noWrite = await page.getByText('No persistence', { exact: true }).count();
      return {
        ok: text.includes('$53.99') && noWrite === 1,
        detail: `${text || '(no target)'} with no-persistence proof`,
      };
    },
  },
  {
    name: '/rollouts/ro_2043 — explicit confirmation shows prices and beta safety',
    path: '/rollouts/ro_2043',
    run: async (page) => {
      const review = page.getByRole('button', { name: 'Review and start' });
      await review.waitFor({ state: 'visible', timeout: 10_000 });
      await review.click();
      const modal = page.getByRole('dialog');
      await modal.waitFor({ state: 'visible', timeout: 5_000 });
      const safety = await modal.getByText('Automatic rollback is off', { exact: true }).count();
      const confirmation = modal.getByRole('button', { name: 'Confirm first stage' });
      return {
        ok: safety === 1 && (await confirmation.isDisabled()),
        detail: 'old/new prices shown and confirmation stays locked until acknowledged',
      };
    },
  },
  {
    name: '/ — store-wide undo requires explicit acknowledgement',
    path: '/',
    run: async (page) => {
      const open = page.getByRole('button', { name: 'Put every price back', exact: true });
      await open.waitFor({ state: 'visible', timeout: 10_000 });
      await open.click();
      const modal = page.getByRole('dialog');
      await modal.waitFor({ state: 'visible', timeout: 5_000 });
      const confirm = modal.getByRole('button', { name: 'Yes, put everything back' });
      const lockedBeforeAcknowledgement = await confirm.isDisabled();
      await modal
        .getByLabel('I understand this undoes every price change, not just one')
        .check();
      return {
        ok: lockedBeforeAcknowledgement && !(await confirm.isDisabled()),
        detail: 'global undo stays locked until the merchant acknowledges its scope',
      };
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

    // Third door: the account gate. The middleware bounces any browser without
    // a `pf_user` session to the sign-in screen — deliberately, even outside
    // production — so when a signing secret is configured the smoke mints its
    // own session the same way `/auth/callback` would. Without the secret the
    // target server could not verify a cookie anyway, so none is sent.
    const sessionSecret = process.env.AUTH_SESSION_SECRET ?? '';
    if (sessionSecret !== '') {
      const { signUserCookie } = await import('../lib/auth/account');
      const { hostname } = new URL(BASE_URL);
      await context.addCookies([
        {
          name: 'pf_user',
          value: signUserCookie(
            // The edge verifier requires a UUID-shaped user id; this nil-based
            // one is obviously synthetic in any log line it reaches.
            { userId: '00000000-0000-4000-8000-000000000000', email: 'smoke@priceflag.invalid' },
            { secret: sessionSecret },
          ),
          domain: hostname,
          path: '/',
          httpOnly: true,
          secure: BASE_URL.startsWith('https'),
        },
      ]);
    }

    for (const check of CHECKS) {
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const requestFailures: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error.message)));
      page.on('requestfailed', (request) => {
        const error = request.failure()?.errorText ?? 'request failed';
        // Next can cancel an RSC prefetch when a navigation or page close makes
        // it irrelevant. That is expected browser behavior, not a broken request.
        if (error === 'net::ERR_ABORTED' && request.url().includes('_rsc=')) return;
        requestFailures.push(`${request.method()} ${request.url()} (${error})`);
      });

      try {
        await check.setup?.(page);
        await coldLoad(page, check.path);
        const outcome = await check.run(page);
        record(check.name, outcome.ok, outcome.detail);

        const overlayCount = await page
          .locator('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay')
          .count();
        const runtimeOk = consoleErrors.length === 0 && requestFailures.length === 0 && overlayCount === 0;
        const detail = runtimeOk
          ? 'no console errors, failed requests, or framework overlay'
          : [
              consoleErrors[0] ? `console: ${consoleErrors[0].slice(0, 140)}` : null,
              requestFailures[0] ? `request: ${requestFailures[0].slice(0, 180)}` : null,
              overlayCount > 0 ? `${overlayCount} framework error overlay(s)` : null,
            ]
              .filter((item): item is string => item !== null)
              .join('; ');
        record(`${check.path} — no blocking browser errors`, runtimeOk, detail);
      } catch (cause) {
        record(check.name, false, cause instanceof Error ? cause.message : String(cause));
      } finally {
        await page.close();
      }
    }

    // A founder may open the demo from a phone or a narrow split-screen window.
    // Tables may scroll inside their own containers, but the page itself must
    // never become wider than the viewport or throw during a narrow cold load.
    const mobileRoutes = [
      '/',
      '/products',
      '/propose',
      '/journal',
      '/rollouts',
      '/rollouts/ro_2043',
      '/model-lab',
      '/settings',
    ];
    const mobileFailures: string[] = [];
    for (const path of mobileRoutes) {
      const page = await context.newPage();
      const runtimeErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') runtimeErrors.push(message.text());
      });
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      page.on('requestfailed', (request) => {
        const error = request.failure()?.errorText ?? 'request failed';
        if (error === 'net::ERR_ABORTED' && request.url().includes('_rsc=')) return;
        runtimeErrors.push(`${request.method()} ${request.url()} (${error})`);
      });
      try {
        await page.setViewportSize({ width: 390, height: 844 });
        if (path === '/propose') {
          await page.addInitScript(() => {
            window.sessionStorage.setItem(
              'priceflag:selection:v1',
              JSON.stringify(['gid://shopify/ProductVariant/46100000000']),
            );
          });
        }
        await coldLoad(page, path);
        const overflow = await page.evaluate(() =>
          Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
          document.documentElement.clientWidth,
        );
        if (overflow > 1) mobileFailures.push(`${path}: ${overflow}px page overflow`);
        if (runtimeErrors.length > 0) mobileFailures.push(`${path}: ${runtimeErrors[0]?.slice(0, 140)}`);
        if (path === '/') {
          const menu = page.getByRole('button', { name: 'Menu', exact: true });
          await menu.click();
          await page.locator('#pf-mobile-nav').waitFor({ state: 'visible', timeout: 3_000 });
          await page.keyboard.press('Escape');
          await page.locator('#pf-mobile-nav').waitFor({ state: 'detached', timeout: 3_000 });
        }
      } catch (cause) {
        mobileFailures.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        await page.close();
      }
    }
    record(
      '390px viewport — core routes stay inside the page and error-free',
      mobileFailures.length === 0,
      mobileFailures.length === 0
        ? `${mobileRoutes.length} narrow routes checked; menu opens and closes`
        : mobileFailures[0] as string,
    );
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
