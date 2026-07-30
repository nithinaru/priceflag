# Lane B — Platform & Shopify

Mission: boring, safe, reversible. Real store connect, real price writes, real
telemetry, the evaluator, deploys.

| | |
|---|---|
| **Current sprint** | B3 — sync pipeline runs against the real dev store. **B2's OAuth install flow still deferred** (see below) |
| **`npm run build`** | green |
| **`npx tsx scripts/smoke.ts`** | green — **150 passed, 0 skipped** (Supabase suite live against real Postgres) |
| **`npm run smoke:browser`** | green — 3 routes cold-loaded against production |
| **CP4** | ✅ passed, 18 hops observed — the full three-lane chain has now run |
| **`npm audit`** | 0 vulnerabilities |
| **Migrations applied?** | ✅ **Yes** — all 8, clean on the first attempt. **CP1 is closed** |
| **Deployed to Vercel?** | ✅ **https://priceflag-app.vercel.app** (project `priceflag-app`) — `/api/health` 200, gate 401s everything else |
| **Evaluator schedule** | ✅ **GitHub Actions, hourly.** Deliberately NOT in `vercel.json` — see below |
| **Contract requests** | Lane A 1–3 + REQ-A-001/002/003, Lane C 1–9 → [answered below](#contract-requests-serviced) |

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

## ⚠️ B2 acceptance is DEFERRED, not passed

**"Install / uninstall / reinstall on a dev store, all clean" has not been
verified and is not claimed.** Reading this file later, do not treat B2 as done.

Why: the Shopify app on the dev store is an **admin-created custom app**, which
has no install flow at all — it authenticates with a static Admin API token. The
OAuth code path (`app/api/auth`, `app/api/auth/callback`) is written and unit
tested, but it cannot be exercised until a **Partner-Dashboard app with custom
distribution** exists, which is what pilots will actually install. That app also
has to request `read_all_orders` *and* protected-customer-data access, both of
which need approval.

So OAuth stays in the tree, untested end to end, and is flagged here rather than
quietly marked green.

### Two app types, two auth paths

`lib/shopify/credentials.ts` is now the single place either kind of token comes
from. Everything above it — sync, price writer, evaluator — asks it for
credentials and never reads env or the token column directly.

| | Path A (now) | Path B (pilots) |
|---|---|---|
| App type | Admin-created custom app | Partner Dashboard + custom distribution |
| Auth | Static `SHOPIFY_ADMIN_ACCESS_TOKEN` | OAuth offline token, encrypted at rest |
| `read_all_orders` | **Implicit** — full history without the scope | Must be requested and approved |
| Install flow | None | `/api/auth` → `/api/auth/callback` |
| Status | Landed | Written, unverified |

**`read_all_orders` is removed from `SHOPIFY_SCOPES`.** On an admin-created app
the scope is not in the admin's checkbox list, so *requesting* it in an OAuth call
fails outright — while the app already has the access. Put it back only when the
Partner app exists and the scope is approved. `.env.example` now documents both
paths separately.

The static path deliberately stores **no token in the database at all** — not even
encrypted. It reads from env per request, so it needs no `ENCRYPTION_KEY` and
cannot go stale. `ensureStaticShop()` creates the `shops` row that every other
table's foreign key needs, since there is no install to create it.

## Migrations are applied — CP1 closed

`supabase db push --db-url "$SUPABASE_DB_URL"` applied all eight migrations, and
**every one succeeded on the first attempt** — no SQL debugging was needed. The
schema now exists on `vnyqevrdvfjsfhdnbfsz`.

- **The direct connection on port 5432 worked** (`db.<ref>.supabase.co:5432`). No
  IPv6 fallback to the session pooler was needed from this machine.
- `--db-url` bypasses `supabase login` and `supabase link` entirely, so this runs
  headlessly. No project is linked and no GitHub auto-deploy integration is
  enabled, as instructed.
- `npm run seed:demo` then loaded the demo store: 14 variants, 2520 `order_days`
  rows, 10 journal entries.

The smoke suite now runs **135 assertions with nothing skipped**, including the
whole adapter suite twice — once against `DemoAdapter`, once against real Postgres.

### What real Postgres proved that the demo adapter could not

Four properties are claims about the *database*, and until now they were only
claims. They are now tested on every run when Supabase is configured:

- **The price journal genuinely rejects `UPDATE`** — even from the service role,
  with the guard trigger's own "append-only" message, and the value is verified
  unchanged afterwards. This is the recovery path for a botched rollout, so a
  merely-conventional append-only rule would not have been enough.
- **It rejects `DELETE`** outside an explicit `set local priceflag.purge = 'on'`.
- **The evaluator lease is enforced by Postgres.** `pf_acquire_rollout_lock`
  refuses a second holder while a lease is live, and `pf_release_rollout_lock`
  refuses to release on the wrong token — so a stale evaluator cannot unlock the
  one that took over from it.
- **Lane C's four `ml_*` views are selectable and correctly shaped**, with `dow` a
  real ISO weekday and `list_price_cents` populated.

Two things fixed along the way:

- The modern **`sb_secret_…` key works** with `@supabase/supabase-js` 2.111.0.
  Nothing in `lib/` parses the key or assumes JWT shape. Concern closed.
- `SupabaseAdapter.ping()` used a `head` request, which does **not** consult the
  schema cache and so reported healthy against a database with no tables, then
  failed on the first real query. It now does a real `select` and names a missing
  schema specifically. The smoke suite degrades to a labelled skip rather than
  crashing, so Lanes A and C can still run it with no database access.

## Vercel — deployed

**https://priceflag-app.vercel.app** — project `priceflag-app`
(`prj_RU8NlBDoR7t89BNqn5BagOpmpnmm`), git-linked to `nithinaru/priceflag@main`.

> **The old project is not ours any more.** `prj_gzNZ…` (now named `priceflagv1`)
> was repurposed as the company homepage: Git disconnected, an old static
> deployment promoted to production, and it still holds `priceflag.vercel.app`.
> Nothing in this lane touches it — not its domains, not its deployments, not its
> Git settings. Any earlier note here pointing at `priceflagv1.vercel.app` as *the
> app* is stale by definition and has been corrected.

- Deployment: `priceflag-1gcbs3p8i-nithin-arus-projects.vercel.app`, state READY.
- Linked to the **existing** project `prj_gzNZMOkkZTOSIwkQ6o6cwPIOW5bh` on
  `team_AqaBD6YaOf9DIJ7NzbytTZTW`. No second project was created — the link file
  is written directly from the pinned id, because `vercel link --project <name>`
  will offer to create a new project when the name does not resolve cleanly.
- Env vars pushed to **both** preview and production. `PRICEFLAG_MODE` is forced
  to `real` there, because the demo adapter persists to the local filesystem,
  which is read-only on Vercel.
- `/api/health` on the deployment returns:
  `{"ok":true,"mode":"real","adapter":{"kind":"supabase","ok":true,"detail":"supabase reachable, schema present"},...}`
  — so the deployed runtime is genuinely reaching the migrated database, not just
  building.

**Deployment Protection is enabled on the project**, so a plain `curl` gets a 302
to Vercel SSO. That is a security setting on your account and I did not change it;
open the URL in a browser signed in to Vercel, or turn protection off in Project
Settings → Deployment Protection if you want it publicly reachable.

Two things `scripts/vercel-setup.sh` deliberately does **not** do:

1. **It never touches `vercel.json`.** The evaluator cron is not there and will not
   be until B5 is written and verified — that cron writes real prices to a real
   store with a real token, and nothing should mutate the store unattended.
   When B5 lands I will add the cron and say so explicitly in this file.
2. It forces `PRICEFLAG_MODE=real` on Vercel. The demo adapter persists to the
   local filesystem, which is read-only on Vercel, so demo mode would fail there
   in a confusing way.

If the target domain turns out to be taken globally, the script says so and
leaves the deployment on its default URL rather than silently picking another
subdomain; the substitution would be recorded here.

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

## Sprint B3 — sync pipeline (runs against the real store)

`POST /api/sync` and `GET /api/sync/status` are live, and the pipeline has been
run end to end against `priceflag-test.myshopify.com` with the static token.

**What actually came back, and it matters for the other lanes:**

| | |
|---|---|
| Products / variants | 17 products → **26 variants** written |
| Repriceable | **17** — excluded: 4 gift cards, 3 subscription products, 2 not active |
| Variants with a cost | **0 of 26** |
| Orders in the last 180 days | **0** |

Two things are worth stating plainly rather than discovering later:

1. **The dev store has no order history at all** — not "orders without price
   variation", literally `ordersCount: 0`. So it is not merely that every product
   will honestly report `assumption` confidence; **baseline demand is zero**, and
   the forecast card will show a zero-unit baseline with breakeven arithmetic only.
   That is the designed behaviour of the fallback chain and it is correct, but it
   means **CP2 cannot be demonstrated on real data until the store has orders**.
   To fix it, place orders on the dev store (Shopify's admin can create draft
   orders, or the storefront with a bogus gateway). Until then the demo store
   remains the only place the fitted path can be exercised.
2. **No variant has `inventoryItem.unitCost` set**, so all 26 land with
   `cogs_cents = null` and `cogs_source = 'none'`. Every profit number on the real
   store will be the honest "profit unknown — add cost" state (R3). **Lane A: this
   is the state the real store will render for now**, so it is worth making sure
   that path looks deliberate rather than broken.

**Sync behaviour worth knowing:**

- Re-running is idempotent — verified: 26 variants before, 26 after, no
  duplicates. Every write is an upsert keyed the way the table is keyed.
- Days are the shop's calendar days, not UTC. A 02:00Z order books to the previous
  day for a New York store, and there is a test for exactly that: getting it wrong
  would feed the wrong day's demand to auto-rollback.
- **Test orders are excluded.** They are real rows with real line items, and
  counting them would inflate the baseline that guardrails compare against — a
  fake sale today makes a real shortfall tomorrow look worse.
- Refunds book on the day the refund happened, not the day of the sale, which is
  what makes a daily revenue series match the merchant's own reports.
- A line item whose variant has been deleted is dropped rather than attributed
  somewhere convenient.
- A cost of exactly `0.00` in Shopify is treated as **unknown**, not as a free
  product — it is almost always "never filled in", and believing it would produce
  a confident 100%-margin forecast.
- `list_price_cents` is filled from the current catalog price, because Shopify
  keeps no price history. This is precisely why `journal_entries` exists: from now
  on Priceflag records every change itself, so future syncs reconstruct it properly.
  **Lane C:** on the real store this column is currently constant, which is the
  mechanical reason a fit is impossible there.
- The catalog is marked ready before order history starts, so onboarding can say
  "you can start choosing products now" while history downloads (R24).

Covered by 11 new smoke assertions against a mocked Admin API, so none of this
needs network or credentials to stay green.

### One bug this shook out

`DemoAdapter.getLatestSyncRun` sorted by `started_at` and returned the first row.
Two syncs can start in the same millisecond, and a stable sort then returns the
*older* one — so a freshly-started sync would report the previous run's progress.
Now ties break on insertion order. Postgres was never affected (microsecond
timestamps), which is exactly the kind of divergence running the suite against
both adapters is meant to catch.

## Sprint B5 — the evaluator, verified end to end on the real store ✅

`npx tsx scripts/simulate-rollout.ts` drives the whole loop against
`priceflag-test.myshopify.com`. **It passed.** Output, both halves:

```
A. Healthy rollout
   2026-07-20  stage 0 -> hold      2026-07-25  stage 1 -> advance
   2026-07-21  stage 0 -> hold      2026-07-26  stage 2 -> hold
   2026-07-22  stage 0 -> advance   2026-07-28  stage 2 -> hold
   2026-07-23  stage 1 -> hold      2026-07-29  stage 2 -> complete
   ✓ completed, reached the final stage, never rolled back, 2 advance emails + completion

B. Starved rollout
   2026-07-27  units 0 -> hold (breach, streak 1)
   2026-07-28  units 0 -> rollback (breach, streak 2)
   ✓ auto-rolled back for guardrail_breach
   ✓ Shopify shows the original prices again
   ✓ verifyRollback found no mismatches
   ✓ the journal records the true before-and-after for every entry
```

### What is real, and what is not

**Real:** the products, **the price writes** (this genuinely changed prices on the
dev store and put them back), **the orders** — created via `draftOrderCreate` /
`draftOrderComplete`, so they are real Shopify orders — every database row, the
guardrail evaluation, the rollback, and the verification against Shopify.

**Simulated: the passage of time, and only that.** A rollout holds each stage for
days; waiting was not an option. The evaluator is called with an explicit
`asOfDay` and a matching `now`, and the pre-rollout baseline is seeded as
`order_days` rows marked `source: 'seed'`. **The multi-day progression has
therefore not been observed against a real 24-hour clock** — that is the one thing
in B5 which remains unproven, and only a multi-day soak can close it.

### Safety: the cron is now in `vercel.json`, and not before

It was deliberately withheld until the above passed. It is `*/15 * * * *` on
`/api/cron/evaluate`, guarded by `CRON_SECRET` compared in constant time, and it
accepts Vercel's own cron header. Every tick is leased per rollout and idempotent
per `(rollout, day)` — the 15-minute cadence exists so a missed tick self-heals,
not because there is work every 15 minutes.

> **Note for Nithin:** Vercel's Hobby plan runs cron jobs at most once per day
> regardless of the expression. On Hobby this becomes a daily tick, which still
> works — the loop is day-based — but a breach would be caught up to 24 hours
> later instead of within 15 minutes.

### Design points worth knowing

- **Reconcile before deciding.** Every evaluation repairs the current stage before
  judging it, otherwise we would be measuring a price change that only half
  happened.
- **The reading is written before the action.** `rollout_readings` is the
  idempotency record, so a crash mid-action cannot cause the same day to be
  evaluated twice.
- **A stage never advances while the current one is not fully applied** — the
  `fully_applied` gate from B4, which is what stops a partial failure compounding.
- **The band comes from Lane C when fresh, and degrades honestly otherwise.** A
  band older than `MAX_BAND_AGE_DAYS` is marked stale and the bracket fallback is
  used; it is never served as fresh (R32).
- **A shop with the kill switch engaged is not evaluated at all.** Nothing should
  advance while a merchant has pulled the cord.
- **Emails are best-effort by design.** A failed send must never fail an
  auto-rollback: the prices are already restored, and throwing would make the
  evaluator look like it failed when it did exactly the right thing.

## CP4 — the full three-lane chain, executed ✅

`npx tsx scripts/cp4-chain.ts` — **passed, 18 hops observed**. This is the first
time a real Lane C artifact has travelled the whole way. B5's acceptance ran on
bracket-math fallback because no band existed.

```
a. Lane C reads through the READ-ONLY role          219 product-days
   fit_store + CleanLevelBaseline                   6 fits, 126 band-days
b. POST /api/ml/ingest (production)
     bad secret                                     401
     gate_passed:false                              200 accepted=false rows=0, run RECORDED
     band violating low<=expected<=high             422
     valid payload                                  200 fits=6 bands=126
c. evaluator on a live rollout
     reading 2026-07-29: source=model  model=baseline-cleanlevel-1.0
                         expected=12 [6.89, 17.11]  decision=hold
d. reading persisted, expected_source exposed, merchant event written
```

### Observed vs inferred

**Observed** (I watched the value change or read it back): the read-only pull, both
Lane C artifacts, all four ingest responses, the rows readable from the database,
`expected_source='model'` on the persisted reading, its `model_version`, the
decision, and the merchant-facing event.

**Inferred, not observed:** that Lane A's rollout page *renders* this particular
reading. I verified the row and the field the UI reads, and that `/rollouts`
returns 200 and hydrates — but I did not drive the UI to this specific rollout and
read the band off the screen. The rollout is also rolled back and cleaned up by
the end of the script, so it would not be there to look at.

### Two real bugs CP4 found

1. **A malformed band returned HTTP 500, not 422.** JSON Schema cannot express
   `low <= expected_units <= high` — draft 2020-12 has no cross-field constraint —
   so an inverted band passed validation and was caught only by the database
   CHECK, surfacing as a write failure. That interval decides auto-rollback, and an
   inverted one would make every day look like a breach. Now checked explicitly in
   `lib/contracts/validate.ts` and refused with a useful message.
2. **A forecast starts after the history ends.** Obvious in hindsight: bands
   generated from history through *today* cover tomorrow onward, and the evaluator
   judges the last *closed* day, so nothing lines up. The nightly must run on
   history through yesterday. Not a code bug, but it is exactly the mistake a first
   production run would make, so it is written down here and in the runbook.

## Lane C request 9 — the ML write path ✅

`POST /api/ml/ingest`. The read-only role stays read-only; Lane C's nightly posts
contract rows to the app, which holds the service role and does the writing. One
place that authenticates, validates, and can refuse.

Three gates, in order:

| Gate | Failure |
|---|---|
| `ML_INGEST_SECRET`, constant-time | `401` |
| The JSON Schemas + the cross-field band invariant | `422`, run recorded `failed`, **nothing written** |
| The honesty gate — `gate_passed !== true` (R28) | `200 accepted=false`, run recorded `rejected`, **nothing written** |

Writes are all-or-nothing per request: a half-written band set is worse than none,
because the evaluator would read the half that landed and believe it complete.

A rejected challenger returns **200, not an error** — the nightly did its job
correctly by telling us the model lost. Failing the Action there would train
people to ignore it.

### How Lane C's GitHub Action authenticates

```yaml
- name: Publish fits and bands
  env:
    ML_INGEST_SECRET: ${{ secrets.ML_INGEST_SECRET }}
    BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
  run: |
    curl -sS -X POST "https://priceflag-app.vercel.app/api/ml/ingest" \
      -H "Authorization: Bearer $ML_INGEST_SECRET" \
      -H "x-vercel-protection-bypass: $BYPASS" \
      -H 'content-type: application/json' \
      --data @payload.json
```

`payload.json` is `{shop_domain, model_run: {kind, model_version, gate_passed,
incumbent_version, metrics}, fits: [...], bands: [...]}` where `fits` and `bands`
are exactly what `fits_contract_rows` and `bands_contract_rows` already emit.

**Both secrets are required** — the bypass alone gets a 401, the bearer alone a
302. `ML_INGEST_SECRET` is in `.env.local` and in Vercel (preview + production);
**it still needs adding as a GitHub repo secret** for Lane C's workflow, which I
have not done because `ml-*.yml` is Lane C's path and the secret is theirs to
wire. `VERCEL_AUTOMATION_BYPASS_SECRET` is already set as a repo secret.

**Timing note for Lane C:** run the nightly on history through *yesterday*, so the
forecast covers today and the evaluator finds a band for the day it judges.

## Production claim sweep (after the project move)

The stale-alias episode showed that a production claim is only as good as the
deployment it was measured against — and the app has since moved to a new Vercel
project entirely. Every production assertion in this file was re-run against
**https://priceflag-app.vercel.app** on the current build.

**Re-verified, still true:**

| Claim | Result |
|---|---|
| `/api/health` reaches the migrated database | `ok:true`, `adapter.detail: "supabase reachable, schema present"` |
| `/api/sync/status` returns a valid `sync_progress` payload | 200, `stage:done`, 26 products |
| The access gate 401s everything unauthenticated | `/` `/api/journal` `/api/kill-switch` all 401 |
| `?access=` and Basic both work | 307 + cookie; 200 |
| `/api/cron/evaluate` needs its bearer | 401 without, 200 with |
| The ML ingest honesty gate rejects and records | bad secret 401; `gate_passed:false` → 200 `accepted:false`, `rows_written:0`, run recorded |
| The GitHub Actions evaluator reaches the app | run 30580363463, `HTTP 200` against the new URL |

**Corrected, because they were false or stale:**

1. **"Deployed to Vercel: https://priceflagv1.vercel.app."** That host belongs to
   the repurposed project now. The app is `priceflag-app.vercel.app`.
2. **"Evaluator cron on Vercel: now in `vercel.json`."** Wrong twice over. It was
   removed (GitHub Actions is the only scheduler), and while it *was* there it
   made every deploy fail outright, because a Hobby account rejects any expression
   running more than daily. That is what left the alias serving a pre-B5 build.
3. **"Redeployed … now carries the cron."** It never did.

**A limit worth stating:** the 150 smoke assertions cover `lib/` and the engine.
**They do not execute the workflow shell** — the `curl`, the status-code branches
and the `python3` summary in `.github/workflows/evaluator.yml` are only ever
exercised by really running the workflow. The green run above is the only evidence
that file works, and a change to it needs another real run, not a green `npm run
smoke`.

## Contract requests — REQ-A-005 and REQ-A-007 ✅

**REQ-A-005 — two copy fixes.** Both done, both with a regression test.

- `ruleConditionHolds` no longer puts an ISO date in a merchant-facing sentence.
  New `formatDayShort` renders `On 25 Jul, …`. The test asserts no `\d{4}-\d{2}-\d{2}`
  survives in `assessment.reason`.
- `defaultGuardrails()` now says **"put every price back automatically"**, matching
  Lane A's builder. `describeRule` was changed to match, so the two can never drift
  again. The test fails if the word "revert" reappears.

**REQ-A-007 — cold-load browser check.** `scripts/smoke-browser.ts`, run with
`npm run smoke:browser`. Playwright, headless chromium.

It follows both rules the request asks for: **assert on rendered output, never on
React internals**, and drive inputs through the framework's own event path
(`fill`/`selectOption`, never a synthetic `dispatchEvent` at a controlled input).
Each route is a fresh top-level navigation, because the bug class only shows on
cold load.

**Run against production, it passes:**

```
✓ /journal   typing a filter changes the rows    rows 23 -> 1
✓ /products  typing a search changes the rows    rows 14 -> 1
✓ /rollouts  the page renders interactive content  15 elements, focus landed on A
```

`/journal` going 23 → 1 is exactly the number REQ-A-007 predicted — so the A6
"hydration bug" is now settled by measurement rather than by argument, and there
is a regression baseline so it cannot come back as a mystery.

Deliberately **not** wired into CI: it needs a deployment to point at, and the
useful moment is before a release. `npm run smoke:browser` with `PRICEFLAG_URL`
and `VERCEL_AUTOMATION_BYPASS_SECRET` set. Covers three routes, not the five in the
request — `/products/costs` and `/propose` need a seeded selection and a product
with a cost, which the dev store does not currently have.

## 🟠 Access gate shipped — INTERIM, and not R33

**The hole was live.** `priceflag.vercel.app` — the auto-assigned *production*
domain — was serving the whole dashboard and every mutating route to anyone who
typed the URL. Vercel's Standard Protection **exempts the production domain**, and
protecting all deployments is a paid feature. Confirmed before the fix: an
unauthenticated `GET /api/journal` returned a real merchant's price history, and
`POST /api/kill-switch` was reachable.

`middleware.ts` now gates the app on a shared secret (`APP_ACCESS_SECRET`),
accepted as an HttpOnly cookie, a `?access=…` parameter that mints the cookie and
then strips itself from the URL, or HTTP Basic. Everything else gets 401.

**Verified on `priceflag.vercel.app` after deploying:**

```
GATED    /  401     /rollouts 401     /api/journal 401
         POST /api/kill-switch 401    /api/ml/ingest 401    /api/sync 401
EXEMPT   /api/health 200
         POST /api/cron/evaluate   no bearer 401 · with bearer 200
         POST /api/webhooks/…      401 (its own HMAC, as it should)
WITH KEY /api/journal via Basic 200   ·   /?access=… 307 + cookie
```

And the GitHub Actions evaluator still works end to end — run 30572791290,
HTTP 200. The browser check still passes with the cookie set.

Exactly three exemptions, each because it already authenticates itself and each
would break if it needed a browser cookie: `/api/cron/evaluate` (CRON_SECRET
bearer), `/api/webhooks/*` (Shopify HMAC — Shopify cannot send a cookie), and
`/api/health` (capability booleans, no data). **`/api/ml/ingest` is deliberately
NOT exempt** despite having its own secret — defence in depth on the path that
writes the numbers driving auto-rollback.

The gate **fails closed in production** when `APP_ACCESS_SECRET` is unset, and
open locally. A misconfigured deploy taking the app offline is recoverable; a
misconfigured deploy quietly serving a price-writing tool to the internet is what
got us here.

### This is not authentication, and R33 still stands

It is one shared secret. It identifies nobody, scopes nothing to a shop, and
everyone who has it has all of it. It also cannot be given to a pilot merchant as
a login. Vercel Authentication could not have solved this either — it requires
*team membership*, so a merchant could never get in.

**R33 — App Bridge session-token verification — is still required before any
merchant is onboarded.** `lib/shopify/session.ts` already verifies those tokens:
HS256 pinned (so `alg: none` cannot pass), `exp`/`nbf` with leeway, `aud` equal to
our client id, and `iss`/`dest` agreement so a token for one shop cannot claim
another. `resolveShopFromRequest` already prefers it over `?shop=`. **What is
missing is that no route requires it** — they all fall back to the statically
configured shop. Closing R33 is: make that fallback opt-in per route, embed the
app so App Bridge issues tokens, and fail closed.

<details>
<summary>Original blocker note (kept for the record)</summary>

**Anyone who can reach the deployment can write prices to a real Shopify store.**

There is no login, no session, no authorization check on any route. `/api/rollouts`,
`/api/kill-switch` and the price writer are reachable by any HTTP client that can
reach the origin. Today the *only* thing preventing that is **Vercel Deployment
Protection**, which is a platform setting on one hosting account — not a property
of the product.

Two things make it sharper than it sounds:

- The project's `ssoProtection` is `all_except_custom_domains`. **The moment a real
  custom domain is attached, it is unprotected**, and a pilot is exactly when a
  custom domain gets attached.
- `resolveShopFromRequest` falls back to a `?shop=` query parameter outside
  production. That is refused in production, but it means the shop is currently
  identified by an unauthenticated parameter in every other environment.

**This belongs in the PRD as a MUST requirement, not a footnote.** I have not
edited `PRD.md` — it is not a Lane B owned path — so this needs Nithin to add it.
Suggested shape:

> **R33 (MUST) [B]** Every route that reads or writes shop data authenticates the
> request and resolves the shop from a verified credential — embedded App Bridge
> session token for merchant traffic, `CRON_SECRET` for the evaluator, HMAC for
> webhooks. No route derives the shop from an unauthenticated parameter. Hosting
> protection is defence in depth, never the control.

</details>

The pieces already exist: `lib/shopify/session.ts` verifies App Bridge session
tokens (HS256 pinned, `aud`/`iss`/`dest` checked) and is used by
`resolveShopFromRequest`. What is missing is that **no route requires it** — they
all fall back to the statically-configured shop. Closing this is roughly one
sprint: make the fallback opt-in per route, embed the app so App Bridge issues
tokens, and fail closed.

## Scheduling — GitHub Actions, not Vercel Cron ✅

**Vercel Cron cannot drive this evaluator.** Deployment Protection answers an
unauthenticated request with a 302, and Vercel Cron does not follow redirects, so
every scheduled invocation would have been swallowed and **no rollout would ever
have advanced or rolled back** — silently, with a green-looking deployment.

Protection stays on precisely because of the blocker above. So the schedule moved
to `.github/workflows/evaluator.yml`, and the cron was removed from `vercel.json`
so there is exactly one scheduler.

The workflow sends **both** secrets, doing different jobs:

| Secret | Job | Alone it gets |
|---|---|---|
| `VERCEL_AUTOMATION_BYPASS_SECRET` | past Deployment Protection | 401 |
| `CRON_SECRET` | proves to the app this is the evaluator | 302 |

Verified in production against the live deployment, all three cases:

```
no secrets       -> 302   (protection blocks it — what Vercel Cron would have hit)
bypass only      -> 401   {"code":"unauthorized","message":"Missing or invalid cron secret."}
bypass + bearer  -> 200   {"evaluated":0,...,"caught_up":0,"errors":[]}
```

And a real GitHub Actions run (`workflow_dispatch`, run 30570819766) returned
HTTP 200, with the invocation confirmed in **Vercel runtime logs**:

```
18:32:18  POST /api/cron/evaluate  200  [info/serverless]
```

The 302 attempt does **not** appear in the runtime logs at all — it never reached
the function. That absence is the evidence that Vercel Cron would have failed
silently rather than loudly.

**Hourly**, not every 15 minutes: the evaluator judges the last *closed*
shop-local day, so it must fire within an hour of each store's local midnight for
any UTC offset — including the `:30` and `:45` zones — rather than at midnight
itself.

**Catch-up matters more than the frequency.** The evaluator previously only ever
looked at yesterday, so any day the schedule missed was never judged and a breach
on that day would never have fired. Guardrails that silently skip a day are worse
than no guardrails, because the merchant believes they are covered.
`evaluateRolloutWithCatchUp` walks every closed, unevaluated day oldest-first so
`breach_streak` accumulates in the right order, stops as soon as the rollout stops
running, and is capped at 14 days so one invocation cannot grind through months.

Repo secrets `CRON_SECRET` and `VERCEL_AUTOMATION_BYPASS_SECRET` and the variable
`PRICEFLAG_URL` are set. `.github/workflows/evaluator.yml` is not an `ml-*.yml`
file, so it does not collide with Lane C's ownership of that directory.

### ⚠️ Correction: my B7 note was wrong

B7 said the redeploy "carries the cron, the journal, the kill switch and the
evaluator". **It did not.** Hobby accounts reject any cron expression running more
than once a day, so `*/15 * * * *` in `vercel.json` made **every deploy fail
outright** from B5 onward. The alias had been pointing at a pre-B5 build the whole
time, and `/api/journal`, `/api/kill-switch` and `/api/cron/evaluate` were simply
not deployed.

I verified `/api/sync/status`, which existed in the older build, and **assumed the
rest of the routes came with it**. That is exactly the kind of claim I have been
trying not to make. Removing the cron fixed the deploy; all routes are now
confirmed present individually:

```
/api/health 200   /api/sync/status 200   /api/journal 200
/api/kill-switch 405 (GET; POST/DELETE only)   /api/cron/evaluate 401 (needs bearer)
```

## Sprint B6 — ML role + demo fits ✅

**`SUPABASE_ML_READONLY_KEY` is a Postgres role, not a dashboard key.** A
publishable key authenticates PostgREST as `anon`, which RLS gives nothing to; the
service key is read-write over everything, which is exactly what the ML lane must
not hold. Lane C connects with psycopg, so a role is both correct and simpler.

Migration `20260730120000_ml_readonly_role.sql`. **Verified against the live
database rather than asserted** — nine checks:

```
CAN    read ml_product_days / ml_products / ml_price_history /
       ml_rollout_windows / elasticity_fits      (5266 rows visible)
CANNOT read shops.access_token_enc
CANNOT write to products / order_days / elasticity_fits
```

The token column is column-revoked deliberately: a read-only role that can read an
encrypted Shopify token is a read-only role that can exfiltrate a store. The
password is **not** in the migration (git keeps things forever) — it is set out of
band and the connection string is in `.env.local`.

**Lane C:** connect with `SUPABASE_ML_READONLY_KEY` as a libpq URL. You get SELECT
on the four `ml_*` views, their source tables, and your own outputs so a challenger
can be compared with the incumbent it must beat. You do **not** get write access —
your request 9 (a write path for fits/bands) is still open; the ingest endpoint is
the next thing I would add.

### REQ-A-006 — demo mode can now show a fitted range

`scripts/seed-demo-fits.ts` runs **Lane C's real `fit_store`** over the demo
store's *observable* columns only — units, list price, promo, stockout, exactly
what a real `order_days` contains — and commits the result as
`lib/demo/elasticity-fits.json`. `generateDemoStore().truth` is never read by that
script and the fitter has no access to it, so this is not the ground-truth leak
CLAUDE.md forbids.

The estimates are honestly wrong, which is the point:

```
variant …46100000000   fitted -1.54   true -1.80   partial
variant …46100000046   fitted -1.84   true -1.15   partial
variant …46100000276   fitted -1.20   true -0.20   assumption
```

**Lane A:** demo mode now reaches **`partial` with a real fitted range and band** —
not `fitted`. Lane C's fitter produced no `fitted`-tier estimates on this data (8
`partial`, 6 `assumption`); that is the honest ceiling for a 14-SKU store with two
or three price levels, and it is a property of the data, not a bug. Select
products that have a usable fit and the band renders. A selection that *mixes*
fitted and unfitted variants correctly falls to `assumption` with no range.

That mixed case exposed a genuine contract violation in B1's forecast: it produced
`confidence: 'assumption'` together with a **non-null** `fitted` block. The schema
says `fitted` is null at that tier, and it must be — a drawn range while the tier
says we cannot predict demand is two contradictory claims on one screen. Fixed.

## Sprint B7 — hardening and production ✅ (partly)

- **`GET /api/journal`** and `?format=csv` (R18). The CSV has no page size — a
  partial audit trail is worse than none — and escapes formula-leading characters
  so a spreadsheet is not handed something executable.
- **`PILOT_RUNBOOK.md`** — fastest-undo first, then triage, then the manual
  restore-from-journal SQL, then a "things that are working as intended" section
  so an on-call person does not "fix" the low-volume floor at 2am.
- **Redeployed** to https://priceflag-app.vercel.app, carrying the journal, the
  kill switch, the evaluator and the ML ingest path. (An earlier version of this
  line claimed the deploy "carries the cron" — it never did, and the cron does not
  belong there at all. See the sweep below.)

### Verified in production

**`GET /api/sync/status` returns 200 with a valid `sync_progress` payload reading
real Supabase data** — this is the check I declined to claim last session, and it
now passes:

```json
{"contract_version":"1.0.0","stage":"done","message":"Loaded 26 products.",
 "catalog":{"ready":true,"products_synced":26,"products_total":26},
 "history":{"ready":false,"days_synced":0,"days_target":180,"orders_processed":0}}
```

### Production claim sweep (re-run against the CURRENT build)

Everything in this file that asserts something about production was re-verified
against deployment `dpl_J8dBk36We59M4TohxQBos91TuYcY`, because the pre-B5 alias
incident means any earlier measurement could have been against a stale build.
**All 11 hold:**

```
GET  /api/health                200     GET  /api/journal?format=csv   200
GET  /api/sync/status           200     GET  /api/kill-switch          405 (POST/DELETE only)
GET  /api/journal               200     GET  /  and  /rollouts         200
POST /api/cron/evaluate  no secrets 302 | bypass only 401 | both 200
POST /api/ml/ingest      bad secret 401
health: {"ok":true,"mode":"real","adapter":{"kind":"supabase","ok":true,
         "detail":"supabase reachable, schema present"}}
```

No claim needed correcting this time. The one that did — the B7 "redeploy carries
the cron" — is corrected above and was caused by the Hobby cron rejection.

### What the test suites do and do not cover

- **`scripts/smoke.ts` (150 assertions) does NOT cover the GitHub Actions
  workflow.** That file is shell and YAML; nothing in the TypeScript suite parses,
  lints or executes it. Its only verification is the live runs recorded above
  (`workflow_dispatch` run 30570819766 → HTTP 200, confirmed in Vercel runtime
  logs). A syntax error or a renamed secret in `evaluator.yml` would be caught by
  the next scheduled run failing, not by `npm run smoke`.
- `scripts/smoke.ts` also does not cover the browser; `npm run smoke:browser` does,
  and is not run automatically.
- `scripts/simulate-rollout.ts` and `scripts/cp4-chain.ts` write to the real dev
  store and are run by hand.

### NOT verified — read before trusting production

1. **Whether Vercel Cron can actually reach `/api/cron/evaluate` past Deployment
   Protection.** Protection is enabled on the project, and an external request is
   302'd to SSO. Vercel's own cron invocations are generally exempt, but I could
   not confirm it from here and **I am not going to assert it**. If cron is being
   redirected, the evaluator never runs in production and nothing advances or rolls
   back. Check Vercel → project → Cron Jobs after the first scheduled firing, or
   force one with `curl -X POST .../api/cron/evaluate -H "Authorization: Bearer $CRON_SECRET"`
   from a context that can bypass protection.
2. **Cron secret rejection in production.** The logic is unit-tested, but remotely
   I cannot tell a 401 from Deployment Protection's 302.
3. **Webhook delivery**, unchanged from B4 — `APP_URL` is localhost and the
   deployment is protected, so Shopify cannot reach either.
4. **The multi-day evaluator progression against a real clock**, unchanged from B5.
5. **500-SKU sync and 10-concurrent-rollout load** (a B7 acceptance item). The dev
   store has 26 variants; I have not synthesised a 500-SKU store to test it.

## Contract requests serviced — round 2

### Lane C 7 — negative-binomial noise — **done**

`lib/demo/generator.ts` now draws daily units from a negative binomial via a
Gamma–Poisson mixture (`var = mu + mu²/k`), with per-SKU `k` drawn once from
**[4, 12]** to match your generator. You were right about why it matters: Poisson
data would make the monitoring bands look better calibrated than they will ever be
on a real store, and band calibration is a safety property here because it drives
auto-rollback.

`DemoTruth` now carries `dispersion_k` per SKU (and `DISPERSION_K_RANGE` is
exported) so the two fixtures can be reconciled exactly. A smoke test asserts
variance/mean > 1.15 on the busy SKUs, which a Poisson generator would fail.

Note this **changes the golden series** for a given seed. If your harness has
baselines recorded against the old Poisson fixture, re-record them.

### Lane C 8 — `elasticity_fits.low` / `high` — **done, not deferred**

You marked it low priority and said `se` was a good enough approximation. I landed
it anyway, because the thing it affects is the honesty of the range the merchant
sees, and "slightly misstates the served range" is the kind of small dishonesty
this product is supposed to not have.

Added to the migration and the schema: `low`, `high` (both nullable, CHECK
`low <= high`, send together or not at all) plus `interval_nominal` defaulting to
0.800. `lib/engine/forecast.ts` now prefers your bounds verbatim and only falls
back to `elasticity ± 1.96·se` per variant when they are absent — so a mixed
selection where some fits carry bounds and some do not still works. Two smoke tests
cover it, including that an asymmetric interval genuinely widens the served range.

### Lane C 4 — `explanation` column — **superseded, no column added**

Request 4 asked for `explanation`; request 6 says you now emit
`confidence_explanation`, which the schema has already. Adding a second
near-identical column would guarantee they drift apart. Keep using
`confidence_explanation` — Lane A renders it in preference to Lane B's wording.

### Lane C 9 — write path for fits/bands — **answered, lands in B6**

Both halves noted and neither is blocked on you:

- **Write access.** The plan is an ingest endpoint I own rather than a write-scoped
  key: `POST /api/ml/ingest` authenticated with a shared secret, validating every
  row against the JSON Schemas before it touches a table. That keeps the ML role
  read-only for everything (as you want), keeps a bad nightly run from writing
  malformed rows, and gives one place to enforce R28 — a run whose `gate_passed` is
  false writes `model_runs` and nothing else. Your nightly can POST the three
  artifact files as-is.
- **Shop enumeration.** B6 adds an `ml_shops` view (`shop_domain`, `timezone`,
  `currency`, `mode`, catalog counts) with a SELECT policy for the read-only role.
  Deliberately no token column and no email.

Until B6, keep uploading artifacts — that path stays supported as a fallback.

### Lane A 1 — inline COGS editing — **already correct, confirmed**

All three of your points already hold in `setCogs`: it sets
`cogs_source = 'manual'`, and it does **not** reject a cost above the price (loss
leaders are real — warn and save, as you do). Clearing a cost sets `cogs_cents`
to null and `cogs_source` back to `'none'`, which a DB CHECK enforces, so
"Added by you" / "From Shopify" / unknown are always distinguishable. `PATCH
/api/products/[variantId]/cogs` returns a plain-language `message` on failure.

### Lane A 2 — `productType` naming — **it is `product_type`**

Shopify's product type is the source, and the column and contract field are both
`product_type` (snake_case, like everything else). `Product` also carries `vendor`
and `tags`, if the catalog filter wants more axes later.

### Lane A 3 — server-side proposal draft — **accepted, landing with B4**

Agreed, and for a reason beyond the URL length: a draft row means the forecast the
merchant approved is the forecast stored with the rollout, rather than something
recomputed from ids after the fact. Shape as you specified:

```ts
createProposalDraft(variantGids: string[]): Promise<{ id: string }>
getProposalDraft(id: string): Promise<{ id: string; variantGids: string[] } | null>
```

As `POST /api/proposals/draft` → `{ id }` and `GET /api/proposals/draft/[id]`,
backed by a `proposal_drafts` table with a 7-day TTL. Note the ids are
**`variant_gid`s**, not product ids — the catalog selects variants. It will exist
before A3 needs it; `sessionStorage` remains fine until then.

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
| 2026-07-30 | B2 | Static-token auth path (`lib/shopify/credentials.ts`) alongside OAuth; cost-aware Admin GraphQL client with throttle backoff; `read_all_orders` removed from requested scopes; negative-binomial golden data (Lane C 7); `elasticity_fits.low/high/interval_nominal` (Lane C 8); `ping()` hardened to detect a missing schema; `scripts/vercel-setup.sh`. Smoke 96 → 121. **B2 acceptance deferred, migrations still unapplied, not deployed** |
| 2026-07-29 | B1 | Serviced REQ-A-001/002/003 and Lane C 1–4: removed the four runtime deps Lane A did not want, moved `noUncheckedIndexedAccess` out of the shared tsconfig into `tsconfig.strict.json` (it was breaking Lane A's file), added `lib/engine/readings.ts` with server-side reading verdicts and rollout health, specified `GET /api/live`, added `{ok, affected_skus, message}` to rollback and kill-switch responses, `overrides` for the `sharp`/`postcss` advisories. Smoke 89 → 96 |
