# Lane B — Platform & Shopify

Mission: boring, safe, reversible. Real store connect, real price writes, real
telemetry, the evaluator, deploys.

| | |
|---|---|
| **Current sprint** | B1 complete → starting B2 (Shopify OAuth + install) |
| **`npm run build`** | green |
| **`npx tsx scripts/smoke.ts`** | green — 89 passed, 1 skipped (Supabase suite, no project yet) |
| **Blocked on** | Shopify custom-app credentials + a Supabase project (see [What I need](#what-i-need-from-nithin)) |

---

## Sprint B1 — Contracts + Supabase persistence ✅

The repo had no `package.json`, no `lib/`, no `CLAUDE.md` and no v0 code, so B1
built the v0 engine from scratch alongside the contracts and migrations it was
supposed to extend. Nothing outside Lane B's owned paths was touched.

### Contracts — `contracts/` (Lanes A and C: read-only)

Eight JSON Schemas, all draft 2020-12, all `additionalProperties: false` so a typo
in a producer fails loudly instead of arriving as a missing number in the UI. Every
one is validated against a fixture on each smoke run — where possible the fixture is
*real engine output*, not a hand-written blob, so schema drift breaks the test.

| File | Producer → consumer |
|---|---|
| `forecast_result.schema.json` | B → A (forecast card) |
| `elasticity_fit.schema.json` | **C → B** |
| `expected_band.schema.json` | **C → B** (and A draws the band) |
| `guardrails.schema.json` | **A → B** |
| `proposal_request.schema.json` | **A → B** |
| `sync_progress.schema.json` | B → A |
| `journal_entry.schema.json` | B → A |
| `rollout_report.schema.json` | **C → A** |

Three of those are not in the BUILD_BRIEF §3 list; I added them because they are
genuine cross-lane surfaces that would otherwise be guessed at:

- **`guardrails.schema.json`** — R10 is tagged [A,B]. Lane A builds the sentence,
  Lane B evaluates it; that needs a schema.
- **`proposal_request.schema.json`** — what A's propose flow POSTs to my API.
- **`rollout_report.schema.json`** — C6 refers to "contract: `rollout_report`
  rows"; now it exists.

Also new and worth reading before you write code against the database:

- **`contracts/README.md`** — the unit conventions table (cents vs percent, `null`
  vs absent, shop-timezone days) and the versioning policy. One read saves one bug.
- **`contracts/api.md`** — every planned endpoint with its request/response shape
  and which sprint lands it. **Lane A: mock against this.** Only `/api/health`
  exists today; everything else 404s.
- **`contracts/db/schema.md`** — table-by-table mirror of the migrations.

### Migrations — `supabase/migrations/`

```
20260729090000_extensions_and_helpers.sql   pgcrypto, pf_touch_updated_at, pf_shop_day
20260729090100_shops_and_products.sql       shops, products, sync_runs
20260729090200_order_days.sql               daily aggregates (no PII, ever)
20260729090300_rollouts.sql                 rollouts, rollout_variants, readings, events, lock RPCs
20260729090400_journal_and_webhooks.sql     journal_entries (append-only), webhook_events
20260729090500_ml.sql                       model_runs, elasticity_fits, expected_bands, rollout_reports
20260729090600_ml_views.sql                 ml_* views for Lane C
20260729090700_rls.sql                      RLS on everywhere, journal append-only trigger
```

Decisions the other lanes need to know about:

1. **`products` is variant-grained.** One row per Shopify *variant*, keyed
   `(shop_id, variant_gid)`. The contract name is `products`, but price, compare-at
   and unit cost all live on variants and variants are what we write. `product_gid`
   groups them.
2. **Three tables beyond the frozen list**, because the listed ones could not carry
   the requirements: `rollout_variants` (the captured baselines that make rollback
   correct — R12), `sync_runs` (backs the `sync_progress` contract), and
   `rollout_reports` (C6/R30).
3. **`order_days.list_price_cents` is the elasticity regressor**, not
   `realized_unit_price_cents`. Realized price moves with discounts; list price is
   what the shopper saw on the page. **Lane C: regress on `list_price_cents`.**
4. **`journal_entries` is append-only.** A trigger rejects UPDATE, and DELETE only
   inside `set local priceflag.purge = 'on'` (for the GDPR `shop/redact` topic).
   Uninstall clears the token and stamps `uninstalled_at`; it does not delete the
   shop, so a reinstalling merchant keeps their price history.
5. **Evaluator locking is a row lease with a TTL, not `pg_advisory_lock`.** Supabase
   pools connections, so a session lock cannot be held across HTTP calls and a
   transaction lock dies at statement end. `pf_acquire_rollout_lock` /
   `pf_release_rollout_lock`.
6. **RLS is on for every table with no policies.** Only the service role reads or
   writes; shop scoping happens in the route handler, which is why every adapter
   method takes a `shop_id`. The merchant authenticates to Shopify, not Supabase, so
   there is no `auth.uid()` to write a policy against. B6 adds the read-only role
   and its SELECT policies for Lane C.

### For Lane C specifically

Four views are your read surface — treat their column names as contract:

| View | Grain |
|---|---|
| `ml_product_days` | variant × day: units, revenue, `list_price_cents`, `dow`, stockout/promo flags, COGS, `excluded_from_pricing` |
| `ml_products` | current catalog |
| `ml_price_history` | every applied price change, `day` in shop time |
| `ml_rollout_windows` | rollout treatment periods + affected variants (for C5) |

`lib/demo/generator.ts` is the golden-data generator to port/extend in C1. It
returns a `truth[]` array — the **known** elasticity per variant, the number of
distinct observed price levels, and the confidence tier an honest estimator should
be able to claim. Deliberately includes products with one price level only (no
honest fit is possible — the answer must be `assumption`), a zero-COGS product, a
0.6-units/day product, weekly seasonality, a slow trend, store-wide promo days, and
multi-day stockouts.

`npm run seed:demo` writes all of it to Supabase and prints the truth table.

### Engine — `lib/`

```
lib/money.ts              integer cents; exact decimal parsing; psychological rounding
lib/dates.ts              shop-timezone calendar days, DST-safe arithmetic
lib/contracts.ts          TS mirrors of the schemas + shared constants
lib/types.ts              domain rows, 1:1 with the migrations
lib/config.ts             lazy env access, capability probes
lib/crypto.ts             AES-256-GCM for tokens at rest, constant-time compare
lib/shopify/gid.ts        Shopify global ids
lib/engine/forecast.ts    breakeven arithmetic + the fitted range + fallback chain
lib/engine/guardrails.ts  breach evaluation, streaks, low-volume floor
lib/engine/rollout.ts     stage plans, cohorts, transitions, the daily decision
lib/engine/bands.ts       the bracket fallback band
lib/engine/journal.ts     idempotency keys, entry builders, CSV export
lib/adapters/*            StoreAdapter + DemoAdapter + SupabaseAdapter
lib/demo/generator.ts     the deterministic demo store (golden data)
```

Notes for Lane A:

- `lib/contracts.ts` and `lib/money.ts` are safe to import from components —
  they are pure and have no Node dependencies. **`lib/adapters/*`,
  `lib/db/*` and `lib/crypto.ts` are server-only**; importing them into a client
  component pulls `node:fs` and the service-role key into the browser bundle.
- Useful exports: `formatCents`, `formatPct`, `defaultGuardrails()`,
  `DEFAULT_STAGE_PLAN`, `worstConfidence`, `exclusionReasonFor`.
- The confidence tier is always one of `fitted | partial | assumption`, and every
  tier arrives with a `confidence_explanation` string written in plain language.
  Render the string, don't compose your own.

### Root configs

`package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
`vercel.json`, `.gitignore`, `.env.example`. Next 15.5.22 / React 19.2.8 /
TypeScript 5.9.3 / Tailwind v4.3.3, all pinned, `package-lock.json` committed.

**Lane A:** I pre-added `clsx`, `tailwind-merge`, `lucide-react` and `recharts` so
you are not blocked on a dependency request. Tailwind v4 does theming in CSS, so
design tokens belong in `app/globals.css` — yours, not mine. `postcss.config.mjs`
already wires `@tailwindcss/postcss`. Need another dependency? Append to
`contracts/requests-lane-a.md` and I will land it.

There is no `app/layout.tsx` or `app/page.tsx` — those are yours. The build is
green today because `app/api/health/route.ts` is enough of an `app/` directory for
Next; adding pages will need a root layout.

### Verification

`npx tsx scripts/smoke.ts` — 89 assertions, no test framework, runnable with zero
setup. Covers money/gid/crypto/date primitives, all eight schemas against real
engine output, the forecast (breakeven exactness, fitted range, missing-COGS
honesty, R13 compare-at, R22 exclusions, R32 staleness), guardrails (streaks, the
low-volume floor, profit skipping, breach probability precedence), the rollout state
machine, the fallback band, journal idempotency and CSV escaping, and then the
**same adapter suite against both adapters** plus a restart test proving demo state
survives a new process.

The Supabase half of the adapter suite skips itself with a clear message when
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are absent, and runs automatically
once they are set.

### Not verified yet — read this

**The migrations have never been executed against a real Postgres.** There is no
Docker, no `psql` and no Priceflag Supabase project on this machine, so
`supabase db push` has not run. The SQL is reviewed but unproven; the first
`npm run db:push` may need a fix. Nothing else depends on it yet — the demo adapter
carries the whole loop — but treat "migrations apply cleanly" as an open item, not a
completed one.

---

## What I need from Nithin

Two things, both free tier. Until they exist, Lane B keeps building against the
demo adapter, so this is not blocking B2's code — only its verification against a
real store.

### 1. Supabase project

1. Create a free project at [supabase.com/dashboard](https://supabase.com/dashboard/new)
   — name it `priceflag`, any region near you.
2. Project Settings → API. Paste into `.env.local` (`cp .env.example .env.local`):

   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<the service_role key, not anon>
   ```

3. Then:

   ```bash
   npx supabase db push
   npm run seed:demo
   npx tsx scripts/smoke.ts
   ```

   The smoke test will stop skipping the Supabase suite.

> The Supabase account currently reachable from this machine has one project,
> `AMA-supabase`, which is unrelated and paused. I did not touch it and would not
> without asking.

### 2. Shopify custom app on a development store (needed for B2)

1. [partners.shopify.com](https://partners.shopify.com) → Stores → Add store →
   Development store.
2. In that store: Settings → Apps and sales channels → Develop apps → Create an app.
3. Configuration → Admin API integration → grant exactly:
   `read_products`, `write_products`, `read_orders`, `read_all_orders`
   (`read_all_orders` is what unlocks more than 60 days of history; on a custom app
   it is self-granted, no review).
4. API credentials → paste into `.env.local`:

   ```
   SHOPIFY_API_KEY=<Client ID>
   SHOPIFY_API_SECRET=<Client secret>
   ```

5. Also generate these two:

   ```bash
   node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
   node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
   ```

6. OAuth needs a public callback URL. Either `npx cloudflared tunnel --url http://localhost:3000`
   or an ngrok tunnel, then set `APP_URL` to that origin (no trailing slash) and add
   `$APP_URL/api/auth/callback` to the app's allowed redirection URLs.

Resend (`RESEND_API_KEY`) is not needed until B5.

---

## Notes for the other lanes

- **`CLAUDE.md` and `PROMPTS.md` do not exist**, though README.md and BUILD_BRIEF.md
  both reference them. They are not in any lane's owned paths so I have not created
  them. The ground rules they would contain are in BUILD_BRIEF §2.7 and README
  "Principles". Flagging in case someone wants to claim ownership.
- **`ARCHITECTURE.md` does not exist either** (my kickoff prompt referred to it).
  `contracts/README.md` plus this file cover what it would have said about the
  seams: `StoreAdapter`, the JSON Schema contracts, and the fallback chain.
- **The fallback chain is live and tested.** If Lane C's fits or bands are missing,
  stale, or self-reported as `assumption`, the forecast serves transparent bracket
  math tagged `assumption` and the evaluator uses `lib/engine/bands.ts`. No lane can
  block another.

## Changelog

| Date | Sprint | What landed |
|---|---|---|
| 2026-07-29 | B1 | Contracts (8 schemas + api.md + db/schema.md), 8 migrations, the v0 engine in `lib/`, `StoreAdapter` with Demo + Supabase implementations, demo/golden-data generator, `scripts/smoke.ts` (89 assertions), `scripts/seed-demo.ts`, `GET /api/health`, root configs |
