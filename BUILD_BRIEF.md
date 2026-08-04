# Priceflag v1 — Build Brief (three-lane parallel build)

Engineering companion to `PRD.md`. This brief is written for **three Claude Code
chats working the same repo in parallel** with zero pull/push collisions. If you
are one of those chats: find your lane below, read §2 (the rules that keep you
from colliding with the others), then execute your sprints in order.

The whole stack is free at this stage: Shopify Partner account + development
store + custom app (free, no review), Vercel Hobby, Supabase free tier, Resend
free tier, GitHub Actions free minutes.

## 1. The three lanes

| Lane | Mission | Owns (exclusive write access) |
|---|---|---|
| **A — Product UI** | An extremely clear interface: a merchant who has never seen the app reaches a safe first rollout without help | `app/**` (except `app/api/**`), `components/**`, `docs/lane-status/lane-a.md`, `contracts/requests-lane-a.md` |
| **B — Platform & Shopify** | Real store connect, real price writes, real telemetry, the evaluator, deploys | `lib/**`, `app/api/**`, `supabase/**`, `contracts/**` (schema owner), `scripts/**`, `docs/lane-status/lane-b.md`, root configs (`package.json`, `vercel.json`, `.env.example`) |
| **C — Machine Learning (Python)** | Models that actually work on retail order data: elasticity, demand baselines, counterfactual bands, calibration | `ml/**`, `.github/workflows/ml-*.yml`, `docs/lane-status/lane-c.md`, `contracts/requests-lane-c.md` |

Everything meets in the database and in `contracts/`: Lane B defines tables and
JSON schemas, Lane C fills `elasticity_fits` and `expected_bands`, Lane A renders
what the engine exposes. No lane imports another lane's in-progress code —
integration happens through committed, versioned contracts.

## 2. Non-collision rules (every lane, every session)

1. **Path ownership is absolute.** Never create, edit, or delete a file outside
   your lane's owned paths. If your work seems to require it, it doesn't — it
   requires a contract change (rule 5) or it belongs to another lane.
2. **Everyone works on `main`.** Because owned paths are disjoint, rebases never
   conflict. Sequence per session: `git pull --rebase origin main` when you
   start, again immediately before every push.
3. **Stage surgically.** `git add <your owned paths>` — never `git add -A` or
   `git add .`. Commit messages: `Lane A / Sprint A3: <what shipped>`.
4. **Push at the end of every sprint** (green tests first), and also mid-sprint
   whenever you finish a coherent, non-breaking unit. Update your
   `docs/lane-status/lane-<x>.md` in the same push: sprint completed, what
   landed, anything the other lanes should know. That file is how the three
   chats communicate.
5. **Contracts are law.** `contracts/` holds the JSON Schemas and the SQL
   migration files that define every cross-lane surface. Lanes A and C treat it
   as read-only. To request a change, append to your own
   `contracts/requests-lane-<x>.md` (yours alone — no conflicts) and continue
   with a mock behind your own interface; Lane B lands the change and notes it
   in its lane-status file.
6. **Never break `main`.** Each push must leave `npm run build` (A, B),
   `npx tsx scripts/smoke.ts` (B), and `pytest ml/` (C) green. If you pull work
   from another lane that breaks you, don't fix their code — pin to the last
   good contract version and flag it in your lane-status file.
7. Ground rules from `CLAUDE.md` still bind everyone: integer cents, no
   per-visitor pricing ever, forecasts show confidence honestly, every price
   write journaled and reversible.

## 3. Shared contracts (Lane B owns; frozen at kickoff)

Database tables (Supabase migrations in `supabase/migrations/`, mirrored as
schema docs in `contracts/db/`): `shops`, `products`, `order_days` (daily
aggregates only, no PII), `rollouts`, `rollout_readings`, `rollout_events`,
`journal_entries`, `webhook_events`, `elasticity_fits`, `expected_bands`,
`model_runs`. Column detail lives in the migration files — v0's `lib/types.ts`
shapes map 1:1.

JSON Schemas in `contracts/`:

- `forecast_result.schema.json` — what the UI's forecast card renders
  (breakeven, scenarios, fitted range, `confidence: fitted|partial|assumption`,
  `explanation` string). Extends v0's `ForecastResult`; existing fields never
  change meaning.
- `expected_band.schema.json` — per product × date: `expected_units`, `low`,
  `high`, `model_version`. Written by Lane C, consumed by Lane B's evaluator.
- `elasticity_fit.schema.json` — `elasticity`, `se`, `n_obs`,
  `price_variation_pct`, `confidence`, `model_version`, `fitted_at`.
- `sync_progress.schema.json` — what onboarding UI polls: stage, counts, ETA.

Fallback chain (so lanes never block each other): if Lane C's fit/bands are
missing for a product, Lane B serves v0's transparent bracket math tagged
`confidence: "assumption"`; Lane A renders whatever confidence tier arrives.
Every lane is shippable alone.

## 4. Sprints

Sprint = one focused Claude Code session (~half a day to a day of work), ending
in green tests + a push + a lane-status update. Do them strictly in order within
your lane. **Integration checkpoints** (§5) are where Nithin verifies the lanes
still fit together — sprints are sequenced so the pieces each checkpoint needs
exist by then.

### Lane A — Product UI (mission: nothing to explain)

Design bar for every sprint: plain-language over jargon (say "undo this change
if…", not "guardrail threshold"); one primary action per screen; money and
percentages always formatted, never raw; every state designed (empty, loading,
syncing, error, zero-COGS, thin-data); the merchant can always answer "what is
live right now, and how do I undo it?" in one glance.

- **A1 — Design system foundation.** Tokens (type scale, spacing, color incl.
  status colors, dark-mode-ready), primitives (Button, Card, Table, Badge,
  Input, Modal, Toast, Skeleton, EmptyState), app shell + nav. Refactor v0's
  three pages onto the primitives, zero behavior change. *Accept:* v0 flows
  pixel-checked; `npm run build` green. **Push.**
- **A2 — Catalog & COGS.** Search/filter/sort, multi-select with sticky action
  bar, inline COGS editing with `cogs_source` indicator, "profit unknown — add
  cost" state, subscription/gift-card badges (excluded from selection).
  *Accept:* 500-row catalog is fast and legible; selection flows to propose.
- **A3 — Propose flow v2.** Multi-SKU proposal (% or absolute), forecast card
  rendering `forecast_result.schema.json` — breakeven sentence first, fitted
  range with visual band, confidence tier with its one-line explanation, "show
  your work" scenario table collapsed beneath. Guardrail builder that reads as a
  sentence with editable blanks + live preview ("if units fall >30% below
  expected for 2 days, everything reverts automatically"). *Accept:* usability
  self-test — every number on screen traceable to a visible explanation.
- **A4 — Rollout monitoring v2.** Stage timeline, actual-vs-expected chart with
  uncertainty band (follow repo dataviz conventions from v0's chart), breach
  states, event log, prominent one-click rollback + store-level kill switch,
  paused-for-external-change state. *Accept:* the "what's live / how do I undo"
  glance test passes on every rollout state.
- **A5 — Onboarding & sync.** Connect-store flow, sync progress from
  `sync_progress.schema.json` (catalog-ready vs history-ready staging), demo ↔
  real mode switcher, notification settings, first-run guidance toward a first
  safe rollout. *Accept:* new-user path from install link to proposed rollout
  with no dead ends (mocked platform responses fine).
- **A6 — Post-rollout report & journal v2.** Realized vs predicted report page
  (the retention loop), journal with filters + CSV download button, price-change
  annotations on product pages. *Accept:* report renders from a completed
  rollout's readings.
- **A7 — Polish, a11y, responsive.** Keyboard nav, focus states, contrast audit,
  mobile layouts (merchants check rollouts from phones), microcopy pass,
  loading/error sweep. *Accept:* self-run WCAG AA checklist documented in
  lane-status.

### Lane B — Platform & Shopify (mission: boring, safe, reversible)

- **B1 — Contracts + Supabase persistence.** Write every `contracts/` schema and
  all initial migrations (this sprint unblocks A and C — do it first). Extract
  `StoreAdapter` from v0's `lib/state.ts`; implement `DemoAdapter` (current
  behavior) and `SupabaseAdapter`; seed script loads the demo store into
  Supabase. *Accept:* smoke test green on both adapters; state survives restart.
  **Push.**
- **B2 — Shopify OAuth + install.** Custom-app OAuth (offline token, encrypted
  at rest), `shops` row, `app/uninstalled` cleanup, embedded session-token
  verification, shop-scoped access everywhere. *Accept:* install/uninstall/
  reinstall on a dev store all clean.
- **B3 — Sync pipeline.** Products/variants with `inventoryItem.unitCost` →
  `products`; 180 days of orders (`read_all_orders` scope on the custom app) →
  `order_days` aggregates; background with progress written to the
  `sync_progress` contract; nightly baseline materialization. *Accept:* dev
  store syncs end-to-end; re-sync idempotent.
- **B4 — Price writer + webhooks.** `productVariantsBulkUpdate` writer:
  compare-before-write idempotency, rate-limit aware, backoff, journal entry per
  change, compare-at policy (R13). Webhooks: HMAC-verified, deduped
  `orders/create` → `order_days` upsert; `products/update` → external-change
  detection → journal + pause affected rollout; GDPR topics. *Accept:* rollout
  stage changes real storefront prices; manual admin edit pauses the rollout and
  journals as `external`; test order lands in `order_days` within a minute.
- **B5 — Evaluator + notifications.** Cron (15 min, store-timezone day
  boundaries): aggregate yesterday → compare to `expected_bands` (fallback:
  bracket math) → guardrails → advance/hold/auto-rollback. Per-rollout advisory
  lock, idempotent per (rollout, date), Poisson floor for low-volume days.
  Resend emails for start/advance/breach/rollback/completion. Kill switch.
  *Accept:* scripted end-to-end on dev store — healthy rollout advances, starved
  one auto-rolls back with prices verified restored and emails received; same-day
  re-run is a no-op. **This sprint makes the product real.**
- **B6 — ML plumbing.** Read-only DB role for Lane C, `model_runs` registry
  table, evaluator prefers `expected_bands` when fresh (staleness check),
  `elasticity_fits` flows into the forecast endpoint per the fallback chain.
  *Accept:* with C2/C3 outputs present, forecast card shows `fitted` tier and
  evaluator uses model bands; with them absent, everything still works.
- **B7 — Hardening + production deploy.** Vercel prod, `CRON_SECRET`, error
  tracking on writer/evaluator paths, journal CSV export endpoint, 500-SKU sync
  and 10-concurrent-rollout sanity, `PILOT_RUNBOOK.md` (install link flow,
  manual price-restore-from-journal SQL). *Accept:* runbook dry-run performed.

### Lane C — Machine Learning (mission: models that are actually right)

Python 3.12, `ml/` as a package (`uv` for deps), pinned versions. The discipline
that makes the models "actually work": **every model must beat the incumbent on
the eval harness before it replaces it**, and every claim ships with a
calibration number. Scope honesty — daily aggregates, 12–500 SKUs, 90–180 days
of history: this is small-data statistics, not deep learning. The winning tools
are regularized regression, state-space models, gradient boosting, and
hierarchical Bayes; anything fancier must prove itself on the harness.

- **C1 — Data access + golden harness.** `ml/data.py` (read-only Supabase pull →
  tidy frames), synthetic golden-data generator with *known* elasticities
  (port/extend v0's demo generator: seasonality, promos, noise, trend, stockout
  gaps), eval harness + metrics: elasticity recovery error, interval coverage,
  pinball loss, backtest MAPE vs seasonal-naive. `pytest` from day one.
  *Accept:* harness runs on golden + real dev-store data; seasonal-naive
  baseline scores recorded (the number every model must beat). **Push.**
- **C2 — Elasticity v1 (the workhorse).** Log-log ridge regression per product:
  `log(units+1) ~ log(price) + dow + promo + trend`, empirical-Bayes shrinkage
  toward the portfolio prior weighted by observed price variation; SEs via
  bootstrap. Map to `confidence: fitted|partial|assumption` by data richness.
  Write `elasticity_fits` per contract. *Accept:* recovers golden elasticities
  within ±0.3 when history contains ≥2 price levels; degrades to `assumption`
  honestly when it doesn't; calibration table in lane-status.
- **C3 — Baseline demand forecaster (feeds the evaluator).** Expected units per
  product×day with **no** price change: exponential-smoothing state space
  (statsmodels ETS/`UnobservedComponents`) and LightGBM with dow/trend/promo
  features; per-product champion by rolling-origin backtest; 80% intervals via
  empirical residual quantiles, floored for low-volume SKUs. Write
  `expected_bands`. *Accept:* beats seasonal-naive on ≥70% of golden SKUs;
  interval coverage within ±10pts of nominal. **This powers auto-rollback — the
  bands' honesty is a safety property.**
- **C4 — Hierarchical elasticity (v2).** Partial pooling across
  products/categories (PyMC hierarchical Bayes, or fast empirical-Bayes
  equivalent if fit time is unreasonable): thin-history products borrow strength
  instead of falling to `assumption`. *Accept:* beats C2 on golden thin-data
  cases AND real-data backtests; otherwise C2 stays champion and this is
  recorded — no vanity upgrades.
- **C5 — Rollout counterfactual monitor.** During a rollout: counterfactual
  expected band from C3 conditioned on pre-change data (CausalImpact-style),
  cumulative-effect estimate with uncertainty, breach *probability* rather than
  raw threshold crossing (reduces noise-whipsaw for small stores). Exposed as an
  `expected_bands` variant per contract. *Accept:* on golden rollouts with known
  true effects, flags real drops within 2 days at ≤10% false-positive rate.
- **C6 — Calibration + post-rollout reports.** After each completed rollout:
  realized vs predicted, updated elasticity, "customers were less price-sensitive
  than assumed" narrative fields (contract: `rollout_report` rows Lane A
  renders). Global calibration dashboard data (% of forecasts landing in range —
  the PRD's honesty metric). *Accept:* report generated for a completed
  dev-store rollout.
- **C7 — Production loop.** Nightly GitHub Actions workflow: pull → refit →
  validate on harness → write fits/bands + `model_runs` (version, metrics) →
  fail loudly (never write worse-than-incumbent fits). Drift check; model cards
  in `ml/MODELS.md`. *Accept:* action runs green on schedule against the dev
  store; a deliberately-degraded model is rejected by the gate.

## 5. Integration checkpoints (Nithin runs these)

- **CP1 (after A1/B1/C1):** repo builds, both adapters green, harness runs, all
  contracts committed. Lanes officially unblocked.
- **CP2 (after A3/B3/C2):** propose flow renders a real fitted forecast for a
  synced dev store end to end.
- **CP3 (after A4/B5/C3):** full lifecycle on the dev store with scripted
  orders — stages advance, a breach auto-rolls back, UI shows it live. *This is
  the demo-able product.*
- **CP4 (after A6/B6/C5):** model-driven bands in the evaluator, post-rollout
  report rendered.
- **CP5 (after A7/B7/C7):** production deploy + nightly ML loop; pilot-ready.

## 6. Environment

`.env.example` (Lane B maintains): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_SCOPES=read_products,write_products,read_orders,read_all_orders`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ML_INGEST_SECRET`,
`RESEND_API_KEY`, `APP_URL`, `ENCRYPTION_KEY`, `CRON_SECRET`. Lane C
additionally uses repo secrets in GitHub Actions for the nightly job.

## 7. Testing summary

Lane A: `npm run build` + visual states documented per sprint. Lane B:
`scripts/smoke.ts` grows into engine/adapter/evaluator tests; simulator script
(`scripts/simulate-store.ts`) fires synthetic webhooks to compress days into
minutes. Lane C: `pytest ml/` — golden-data recovery, backtests, coverage gates;
the eval harness is itself under test. When any Shopify API detail is uncertain,
verify against current docs at shopify.dev — the Admin API versions quarterly.
