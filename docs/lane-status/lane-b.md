# Lane B — Platform & Shopify

Mission: boring, safe, reversible. Real store connect, real price writes, real
telemetry, the evaluator, deploys.

| | |
|---|---|
| **Current sprint** | B1 complete. B2 in progress — auth core landed, install flow needs credentials to verify |
| **`npm run build`** | green — with Lane A's A1 pages and Lane C's ml/ on `main` |
| **`npx tsx scripts/smoke.ts`** | green — 114 passed, 1 skipped (Supabase suite, no project yet) |
| **`npm audit`** | 0 vulnerabilities |
| **Contract requests** | REQ-A-001/002/003 and Lane C's 1–4 all answered → [below](#contract-requests-serviced) |
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

## Sprint B2 — Shopify OAuth + install (in progress)

Everything that can be verified without a store is landed and tested. Everything
that remains *is* the part that needs a store, so B2 stops here until credentials
exist.

Landed:

- `lib/shopify/hmac.ts` — OAuth callback HMAC (sorted query, **hex**) and webhook
  HMAC (raw body, **base64**). Two different schemes; mixing them up would be a
  security hole rather than a bug, so they are separate functions with separate
  tests. Only `hmac` is excluded from the OAuth digest — an older generation of
  Shopify's docs also excluded `signature`, and doing that today rejects valid
  requests. Verified against shopify.dev for 2026-07.
- `lib/shopify/oauth.ts` — authorize URL (**`grant_options[]` omitted, so the token
  is offline**), single-use nonce, token exchange, scope verification, shop-domain
  validation. Two decisions worth stating:
  - **Offline token, deliberately.** The evaluator has to restore a price at 3am
    with nobody logged in. An online token expires and auto-rollback would
    silently stop working — the one failure this product cannot have.
  - **The shop-domain regex is anchored at both ends.** Shopify's published
    pattern is not, which accepts `evil.myshopify.com.attacker.test`. That value
    ends up in a URL we POST the client secret to, so it gets the stricter check.
- `lib/shopify/session.ts` — App Bridge session-token verification with the
  algorithm **pinned to HS256** (accepting the token's own `alg` is the classic JWT
  hole), plus `exp`/`nbf` with 5s leeway, `aud` = our client id, and `iss`/`dest`
  agreement. `resolveShopFromRequest` prefers the signed token over `?shop=`, and
  **refuses the `?shop=` fallback in production** — a shop taken from a query
  parameter is an authorisation hole, not a convenience.
- `GET /api/auth` and `GET /api/auth/callback`. The callback verifies HMAC, then
  the nonce, and only then exchanges the code — exchanging an unauthenticated code
  would let an attacker drive our client secret at a shop of their choosing. The
  token is encrypted before storage and is returned by no route.
- A missing `read_all_orders` **fails the install** rather than warning. Without it
  the Admin API silently caps order history at 60 days, and every elasticity fit
  would be built on two months of data while the UI claimed 180.
- 18 new smoke assertions covering all of the above, including the cross-shop
  token attack, `alg: none`, parameter tampering, and the raw-body requirement.

Still to do in B2, all of it requiring a dev store:

- `app/uninstalled` handling (clear the token, stamp `uninstalled_at`, keep the
  journal) — needs the webhook registration path, which lands with B4's sink.
- Webhook registration on install.
- The acceptance criterion itself: install / uninstall / reinstall on a real dev
  store, all clean.

## Contract requests serviced

All eight open requests from `contracts/requests-lane-a.md` and
`contracts/requests-lane-c.md`, answered. Those files belong to Lanes A and C, so
I have not edited them — this section is the reply.

### REQ-A-001 — root scaffold — **landed**, with three deliberate differences

Landed `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
plus `.gitignore`, `.env.example`, `vercel.json`. Your `@/*` → repo-root alias is
kept, there is no `src/` layout, and there is **no `tailwind.config.js`** — token
ownership stays entirely in your `app/globals.css`. Versions match what you
build-verified against (Next 15.5.22, React 19.2.8, TypeScript 5.9.3, Tailwind
4.3.3), pinned exactly, with `package-lock.json` committed.

Three differences, all of them relevant to you:

1. **I initially added `clsx`, `tailwind-merge`, `lucide-react` and `recharts`
   before reading your request. They are removed.** Your zero-runtime-dependency
   stance is better than my guess, and `components/cn.ts` plus inline SVG icons
   are the right call. Runtime deps are now `next`, `react`, `react-dom`,
   `@supabase/supabase-js` — the last is server-only. When A4 needs a chart,
   file a request and I will land it; if you would rather hand-roll the SVG, that
   also avoids a 100 kB dependency on a page merchants open on phones.
2. **No `"lint": "next lint"` script.** `next lint` is deprecated in 15 and gone
   in 16, so it would be a script that breaks on the next major. If you want
   linting, ask for a flat-config ESLint setup and I will land it properly.
3. **`noUncheckedIndexedAccess` is not in the shared `tsconfig.json`.** I had it
   on, and it broke your `components/mock/engine.ts:1122` — `main` went red on
   my flag, not your logic. Yours is not my file to edit, so the flag came out of
   the shared config and Lane B keeps the guarantee for its own paths via
   `tsconfig.strict.json`. `npm run typecheck` runs both passes;
   `npm run build` uses the shared one, so it stays green for you. If you ever
   want it on for `components/**`, the fix at that line is
   `const latest = readings.at(-1) ?? null`.

Also: `npm audit` was reporting 3 high-severity advisories from Next's own
transitive `sharp` (libvips CVEs) and `postcss`. npm's suggested fix downgrades
Next to 9.3.3. Instead `package.json` now has `overrides` pinning
`sharp ^0.35.3` and `postcss ^8.5.25` — the patched lines, same APIs. `npm audit`
is clean and the build is unaffected. Worth knowing if you see the overrides
block and wonder why.

### REQ-A-002 — `CLAUDE.md` / `PROMPTS.md` — **not mine to create, escalating**

Both of you flagged this. Neither file is in any lane's owned paths — the
BUILD_BRIEF lists my root configs explicitly as `package.json`, `vercel.json`,
`.env.example` — so creating them would be me writing ground rules for all three
lanes, which is not my call. **Nithin: these are yours.** The four rules restated
in BUILD_BRIEF §2.7 are the ones I built against, and they match what you
inferred, so I do not think anything has been missed.

### REQ-A-003 — engine surface — **landed; here is the mapping**

`lib/` and `contracts/` now exist, so `components/mock/engine.ts` can be deleted
when you are ready. Your guesses were close. Real names, since almost all of the
differences are naming rather than shape:

| Your mock | Real | Note |
|---|---|---|
| `Cents = number` | `Cents` in `lib/money.ts` | Exactly as you had it. `formatCents`/`formatPct` are there if you want them |
| `Product.id` | `Product.variant_gid` | Everything is keyed by full Shopify variant gid, not an opaque id |
| `priceCents`, `cogsCents` | `price_cents`, `cogs_cents` | **snake_case throughout** — the contracts are JSON-first and the DB columns match, so camelCase would need a translation layer that could disagree with itself |
| `cogsSource: … \| null` | `cogs_source: 'shopify' \| 'manual' \| 'none'` | `'none'` rather than `null`, and a DB CHECK guarantees `cogs_cents IS NULL` ⇔ `'none'` |
| `kind: 'standard' \| 'subscription' \| 'gift_card'` | `is_gift_card`, `requires_selling_plan`, `has_selling_plan` booleans | Shopify exposes three independent flags; collapsing them would lose the reason. **Use `exclusionReasonFor(product)` from `lib/types.ts`** — it returns `'gift_card' \| 'subscription' \| 'not_active' \| 'zero_price' \| null` and is the single implementation of R22, shared with the price writer |
| `units30d` | not on the product row | Derive from `order_days`, or use `ForecastProductLine.baseline_units_per_day`. `listProducts({sort:'units_desc'})` sorts for you |
| `inLiveRollout` | `GET /api/live` | See below |
| `Rollout.status` `'live' \| 'holding'` | `'running'` covers both; `'paused'` + `paused_reason` covers your `'paused_external'` | Your `'holding'` is a *stage* property, not a rollout one — the stage's remaining hold days come from `decideNext`. Full set: `draft \| scheduled \| running \| paused \| completed \| rolled_back \| cancelled` |
| `RolloutStage.sharePct` | `stages[].fraction` (0.25, not 25) | Fractions, per the contract's percent convention. `hold_days` matches |
| `Guardrail {unitsDropPct, forDays, action}` | `guardrails.schema.json` | **Kept as structured fields, exactly as you asked** — `threshold_pct`, `consecutive_days`, `action`, plus `metric`, `scope`, `min_expected_units`, and a `sentence` string. The sentence is stored **verbatim as the merchant read it** and is never regenerated, so your builder's wording is the record of what they agreed to |
| `RolloutReading.verdict` | **added — you were right** | See below |
| `RolloutEvent.message` | `rollout_events.message` | Plain language, written to be rendered verbatim. Types are an enum on the row |
| `JournalEntry.actor` `'you'` | `actor: 'priceflag' \| 'merchant' \| 'shopify_admin' \| 'system'` | `shopify_admin` is specifically "changed outside Priceflag, we only observed it" |
| `ConfidenceTier` | same three values | `confidence_explanation` ships with every forecast. Prefer mine when present, as you offered — it is written per-case (thin history vs no price variation vs stale model are different sentences) |

Your two behavioural requests, both granted:

1. **Store-wide "what is live right now"** → `GET /api/live`, specified in
   `contracts/api.md`. Returns `anything_live`, `skus_holding_priceflag_price`,
   per-rollout stage/fraction/`variants_live`, `kill_switch_engaged`,
   `paused_for_external_change`, `products_missing_cost`, and per rollout a
   `health` (`healthy | watching | breaching | too_early | not_live`) with a
   `health_sentence` to render verbatim. Lands in B4.
2. **Rollback and kill switch return `{ok, affected_skus, message}`** — added to
   both response shapes in `contracts/api.md`, so your confirm dialog and toast
   can be wired now. Both are idempotent: calling twice restores once.

**On the verdict — you were right and it is now server-side.** `lib/engine/readings.ts`
exports `readingVerdict`, `readingSentence`, `rolloutHealth`, `healthSentence`, and
the same functions back the evaluator, so the UI cannot show a verdict the machine
did not act on. Two things worth knowing:

- A day is `'below'` only when it falls **outside the interval**, not merely
  beneath the point estimate. Half of all healthy days sit beneath the point
  estimate; treating those as "below" would make a perfectly healthy rollout look
  alarming.
- `band_floored: true` means volume was too low for the day to mean anything, and
  `readingSentence` says so instead of claiming "within expected". Please render
  that state distinctly — it is the difference between "we checked and it's fine"
  and "there isn't enough data to check".

I also added `watching` between healthy and breaching, because a rollout with one
bad day has not tripped anything, but calling it "healthy" is a half-truth the
merchant would be annoyed to discover later.

### Lane C — 1. v0 source — **it never existed; here is what replaces it**

Nothing to point you at: `main` had no `lib/` at all, so B1 wrote the engine from
scratch. Two corrections that matter for your harness, because your stand-in
constants assume something the real incumbent does not do:

- **The golden generator is `lib/demo/generator.ts`.** It returns a `truth[]`
  array: `{variant_gid, title, true_elasticity, price_levels, expected_confidence}`.
  Deliberately includes products with **one price level only**, where no honest
  fit is possible and `assumption` is the correct answer; a zero-COGS product; a
  0.6 units/day product; weekly seasonality (Thu–Sat peak); a ~17%/180d trend;
  store-wide promo days at ~7% with a 15% discount and a 1.55× lift; and
  multi-day stockouts. Poisson noise, not negative binomial — if you think NB is
  the better generator, say so and I will change it, since you own the eval
  harness and this is your fixture.
- **`lib/engine/forecast.ts` does *not* assume an elasticity.** Your
  `baselines.py` stand-ins (point −1.2, range [−2.2, −0.6]) do not correspond to
  anything in the real bracket math, so please drop them rather than reconcile
  them. The bracket path has **no elasticity at all**: it computes exact breakeven
  margin arithmetic (`margin_before / margin_after − 1`) and a scenario grid at
  unit changes `[0, ∓5, ∓10, ∓20, ∓30]` plus the breakeven point, in the direction
  demand would move. When there is no usable fit, `fitted` is `null` and
  `confidence` is `assumption` — the honest incumbent for *elasticity* is "no
  estimate", so **C2's bar is beating `assumption` coverage, not beating −1.2**.
  For *bands*, the incumbent is `lib/engine/bands.ts`: a day-of-week-adjusted
  trailing 28-day mean with an overdispersed-Poisson 80% interval
  (`sd = sqrt(max(sample_var, mean))`), low edge floored to 0 below 3 expected
  units. That is the thing C3 must beat, and it is worth porting into your harness
  as a scorable baseline.

### Lane C — 2. `order_days` columns — **landed, all three requests granted**

`contracts/db/schema.md` is the full reference. Against your assumptions:

| You assumed | Actual | Note |
|---|---|---|
| `sku` | `variant_gid` | Full Shopify variant gid. `sku` exists on `products` but is merchant-editable and not unique — do not key on it |
| `date` | `day` | **Calendar date in the shop's timezone**, not UTC |
| `revenue_cents` | `net_revenue_cents` | Also `gross_revenue_cents`, `discount_cents`, `refund_units`, `refund_cents` |
| `price_cents` | **`list_price_cents`** ← use this | Granted, and there are two: `list_price_cents` is the price on the product page that day, reconstructed from the journal. `realized_unit_price_cents` is `net/units` and moves with discounts. **Regress on `list_price_cents`** and use `on_promo` as the control — regressing on the realized price would absorb the promo effect into the price coefficient and bias elasticity toward zero |
| `promo` | `on_promo` | Granted. Store-wide promo days, so it is a real control rather than something you infer |
| `stockout` | `had_stockout` | Granted. Inventory-derived, so you do not need the heuristic or the confidence penalty |

Read through the views, not the tables — they are the stable surface and they
absorb column moves: **`ml_product_days`** (adds a precomputed `dow` matching
Postgres `isodow`, joins COGS and `excluded_from_pricing`), `ml_products`,
`ml_price_history` (every applied price change with `day` in shop time — this is
how `list_price_cents` is reconstructed), `ml_rollout_windows` (treatment periods
+ affected variants, for C5). `npm run seed:demo` populates a real Supabase
project from the golden generator and prints the truth table.

### Lane C — 3. read-only credentials — **`.env.example` ready, role lands in B6**

`SUPABASE_ML_READONLY_KEY` is already in `.env.example`. The role and its SELECT
policies land in B6 as planned. Note the current posture: **RLS is on for every
table with no policies**, so the read-only role will see zero rows until B6 grants
it explicitly — if you point `ml/data.py` at a real project before then, use the
service role key locally and expect that to change.

### Lane C — 4. output tables — **landed, and here is the extra I want**

All three exist with your BUILD_BRIEF §3 fields. Since you asked what else to
populate while the fitters are being written — all optional, all useful:

- **`elasticity_fits`**: `confidence_explanation` (one plain-language line; the UI
  renders yours in preference to mine, so this is your voice reaching the
  merchant), `shrinkage_weight` (0 = all portfolio prior, 1 = all own data — the
  forecast reports `source: 'portfolio_prior'` when it is below 0.5, which is a
  claim I would rather take from you than infer), `prior_elasticity`, `method`,
  `r2`, `window_start`/`window_end`.
- **`expected_bands`**: `is_floored` (was the low edge widened by your low-volume
  floor rather than coming from residual quantiles? the evaluator records it and
  the UI states it), `interval_nominal` (default 0.80 — set it explicitly if you
  ever ship a different width), `band_kind` (`baseline` now; `counterfactual` for
  C5, which requires `rollout_id` and is CHECK-enforced), and **`breach_probability`**
  — when present, the evaluator prefers it over raw threshold crossing (R29), so
  this field is how C5 actually replaces thresholds. It is already implemented and
  tested on my side: ≥0.8 fires, and a low probability *suppresses* a raw
  threshold crossing.
- **`model_runs`**: `gate_passed`, `incumbent_version`, `metrics` jsonb, and
  `status = 'rejected'` for a challenger that lost. R28 wants failed challengers
  recorded rather than discarded, so please write the losing runs too.

One constraint to know about: `expected_bands` uniqueness includes
`coalesce(rollout_id, '000…0')`, so raw-SQL upserts need the expression form in
the `ON CONFLICT` target. The exact statement is in `contracts/db/schema.md`.

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
| 2026-07-29 | B1 | Contracts (8 schemas + api.md + db/schema.md), 8 migrations, the v0 engine in `lib/`, `StoreAdapter` with Demo + Supabase implementations, demo/golden-data generator, `scripts/smoke.ts`, `scripts/seed-demo.ts`, `GET /api/health`, root configs |
| 2026-07-29 | B1 | Serviced REQ-A-001/002/003 and Lane C 1–4: removed the four runtime deps Lane A did not want, moved `noUncheckedIndexedAccess` out of the shared tsconfig into `tsconfig.strict.json` (it was breaking Lane A's file), added `lib/engine/readings.ts` with server-side reading verdicts and rollout health, specified `GET /api/live`, added `{ok, affected_skus, message}` to rollback and kill-switch responses, `overrides` for the `sharp`/`postcss` advisories. Smoke 89 → 96 |
