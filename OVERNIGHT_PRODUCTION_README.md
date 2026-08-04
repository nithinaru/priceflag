# Priceflag public-beta production handoff

This file is the shared coordination surface for the production-readiness push. Read it completely before editing the repository.

## Objective

Ship an invite-only Shopify public beta with real-store data and manually approved price changes. Automatic rollback stays disabled by default until every safety gate is green and has been verified against a test store.

Safety beats the deadline. Do not weaken, skip, delete, or rewrite a failing safety test to make a branch green.

## Starting point

- Baseline commit: `716e762e8b383bc39a122323f9236d443b1a820f`
- `npm run typecheck`: pass
- `npm run build`: pass
- `npm run smoke`: 135 passed, 1 failed, 1 skipped
- `npx tsx tests/integration/run.ts --demo`: 36 passed, 8 failed, 1 skipped
- Production health: real mode, Supabase reachable
- ML nightly: green in golden-data mode only; real Supabase credentials are not configured in GitHub Actions
- Production application: access-gated and not approved for merchant beta access

Known safety failures at the baseline:

1. Demo order-history date filtering
2. Units breach probability incorrectly firing non-units guardrails
3. High false-positive guardrail rate on healthy low-volume rollouts
4. Correctly forecast demand changes scored against a no-change baseline
5. Expected bands becoming blind after day 28
6. Chained kill-switch rollback restoring an intermediate price
7. External Shopify price edits being overwritten after activation
8. A zero-dollar price reaching the storefront
9. Rollback missing a write that Shopify accepted but Priceflag did not acknowledge

## Branches and ownership

### Codex: `codex/prod-backend-safety`

Owns:

- `lib/engine/**`
- `lib/pricing/**`
- `lib/evaluator/**`
- `lib/adapters/**`
- `lib/money.ts`
- merchant forecast/rollout/kill-switch/cron API routes
- `contracts/**`
- `supabase/**`
- `tests/**`
- backend smoke coverage

Goal: fix every safety failure, implement tenant-scoped authenticated forecast and rollout APIs, and deliver a green backend PR.

### Claude Max: `claude/prod-ui-auth-infra`

Owns:

- merchant-facing `app/**` pages and actions, except Codex-owned API routes
- `components/**`
- `middleware.ts`
- `lib/shopify/**`
- `lib/sync/**`
- auth, webhook, sync, journal, and health API routes
- browser smoke coverage
- Vercel, Supabase, Shopify, and GitHub Actions configuration

Goal: replace real-mode demo data with authenticated store data, complete App Bridge/session-token authentication, register webhooks, and prepare a verified preview deployment.

If a change is required in the other lane's files, record the requested interface below before editing it. Do not silently cross ownership.

## Frozen integration interfaces

- Every merchant API request uses `Authorization: Bearer <Shopify session token>`.
- `resolveShopFromRequest(request)` is the only authority for the shop in production. No static shop or query-parameter fallback is allowed in production merchant routes.
- `POST /api/forecast` validates `proposal_request.schema.json` without guardrails and performs no writes.
- `POST /api/rollouts` requires explicit guardrails, creates a draft, freezes baselines/targets/cohorts, and does not start without merchant confirmation.
- `GET /api/rollouts/[id]` must return 404 for a rollout outside the authenticated shop.
- `POST /api/rollouts/[id]/rollback` succeeds only after live Shopify prices are verified against captured baselines.
- Webhooks authenticate with Shopify HMAC over the raw request body.
- Cron, ML ingest, and webhooks keep their dedicated machine authentication.
- The beta default is `auto_rollback: false`; a breach pauses and alerts.
- Supabase elevated keys remain server-only and must never use a `NEXT_PUBLIC_` name.

## Required checks before merging

```bash
npm ci
npm run typecheck
npm run smoke
npm run test:merchant-api
npm run test:pricing-safety
npm run test:ml-ingest
npm run test:webhooks
npx tsx tests/integration/run.ts --demo
npm run build
npm audit --audit-level=high
cd ml && uv sync --locked && uv run --locked pytest && uv run --locked python nightly.py
```

Before production promotion, also require:

- Supabase integration suite green against staging
- real-store ML nightly run, not golden-only mode
- cross-shop and forged-token requests rejected
- invalid webhook HMAC rejected and retries deduplicated
- authenticated install -> sync -> forecast -> draft -> manual start -> monitor -> pause -> verified rollback -> journal flow completed on a test product
- timeout-after-write and partial-rollback recovery verified
- external admin edit pauses instead of being overwritten
- zero-dollar price rejected at planning and write time
- chained kill switch restores the original pre-Priceflag price
- preview browser smoke and production error-log scan clean

## Merge and deployment policy

1. Each lane opens a draft PR targeting `main`.
2. Neither lane pushes feature work directly to `main`.
3. Codex creates `codex/prod-integration` after both owned suites are green.
4. Merge backend first; rebase the UI/auth branch; then integrate it.
5. Promote the exact preview artifact that passed the complete gate.
6. If any mandatory gate is red or unverified, keep merchant access closed.

## Secrets policy

- Never commit, paste, echo, log, screenshot, or include secret values in PR text.
- Agents may verify only that required variables exist.
- Use the existing authenticated CLIs and local environment on the authorized machine.
- Do not copy production credentials between computers or into chat.

## Status log

Agents append short entries here when a milestone changes. Include UTC timestamp, branch, commit, checks, and blockers. Never include credential values.

- Coordination baseline: prepared from `716e762`; both implementation lanes pending.
- `2026-08-04T04:52:22Z` — `codex/prod-backend-safety` implementation commit
  `5fdfcb5`. Local gates: clean `npm ci`;
  typecheck; 138/138 smoke; 25/25 merchant API; 10/10 price-write safety;
  ML-ingest; webhook integrity; 51/51 demo integration; production build;
  dependency audit with zero high-severity findings; Python 117/117; golden
  nightly; local compiled-browser interactions 3/3 with no console/error
  overlay. Automatic rollback is false by default and the evaluator workflow is
  manual-only. Blocked external gates: staging migrations/advisors and Supabase
  integration, real-data nightly secrets/proof, Shopify test-store end-to-end,
  registered compliance webhooks, completed Claude real-mode pages, preview
  browser smoke, and production log verification. Claude draft PR #1 now exists
  with App Bridge/auth/webhook-install work, green app CI and a Ready Vercel
  preview, but its own PR description still marks real-mode pages and browser
  verification incomplete. Invite access remains closed and no merge or
  production deployment has been performed.
- `2026-08-04T05:01:02Z` — backend draft PR #2 is green for every
  credential-free GitHub check and has a Ready, SSO-protected Vercel preview.
  Supabase Preview is explicitly skipped, so staging remains closed. The
  production-gates workflow now installs Chromium and treats hydration,
  framework overlays, console errors and non-benign failed requests as blocking;
  the compiled local artifact passes 6/6 browser assertions. Claude draft PR #1
  has not yet rebased or completed its documented real-mode page/browser work.
- `2026-08-04T05:12:00Z` — Claude draft PR #1 advanced to `8b3f4ff` with a
  shop-scoped real-mode read layer and green legacy app CI/Ready protected
  preview. Integration remains blocked: its merchant forecast, rollout, cost and
  settings operations still use cookie-authorized Server Actions; real rollout
  creation explicitly returns unavailable; the App Bridge token failure path,
  uninstall handling and automatic-undo copy remain unresolved; and the branch
  has not rebased onto backend PR #2. Exact corrective guidance is recorded on
  PR #1. The Supabase connector available to Codex exposes only an unrelated
  inactive project, so no Priceflag database was touched and staging migration,
  advisor and integration gates remain unverified. Invite access remains closed.
- `2026-08-04T05:12:30Z` — `codex/prod-backend-safety` added the documented
  bearer-only `GET/PATCH /api/shop` and
  `PATCH /api/products/[variantId]/cogs` interfaces so Claude can replace
  cookie-authorized settings and cost Server Actions. Cross-shop requests return
  no tenant data, Shopify credentials are stripped, unsupported fields are
  rejected, and notification/cost validation is covered. Local typecheck,
  production build, 138/138 smoke and 28/28 merchant API checks pass.
- `2026-08-04T05:22:04Z` — `codex/prod-backend-safety` completed the remaining
  safe beta read/control contracts: authenticated catalog, live overview,
  rollout list, report, and draft/scheduled cancellation APIs. Cancellation is
  confirmation-gated, tenant-scoped, lock-serialized and refuses any rollout
  with price-write history; beta resume remains disabled so an external Shopify
  edit cannot be overwritten. Shared breach copy now says pause-and-alert unless
  an actual rollback decision exists. Local gates: typecheck, production build,
  139/139 smoke, 31/31 merchant API, 51/51 demo integration, price-write,
  webhook and ML-ingest suites all pass. Claude PR #1 remains unrevised and
  unrebased, so integration and invite access remain closed.
- `2026-08-04T08:03:32Z` — Kabir explicitly handed the sleeping Claude lane to
  Codex. `codex/prod-integration` was created from green backend head `e63be92`;
  Claude head `1d8aa5f` is being merged only on the integration branch. Claude's
  original branch and draft PR remain preserved. Codex now owns conflict
  resolution and the unfinished merchant UI/auth wiring, while all frozen
  bearer-only, webhook, rollback and beta safety contracts remain authoritative.
  This handoff does not authorize production promotion or bypass any external
  staging, real-data, preview or Shopify test-store gate.
- `2026-08-04T08:17:53Z` — `codex/prod-integration` completed the local UI/auth
  handoff. Real forecast, draft creation, cost edits, notification settings,
  confirmation, pause, rollback, kill switch and sync requests now carry fresh
  App Bridge bearer tokens; the cookie is read-only page identity and no longer
  authorizes a Server Action write. Draft creation changes no Shopify price.
  The separate confirmation dialog lists every affected variant, frozen old
  price, target price and pause rule before the first write. Automatic rollback
  is unavailable in the beta UI and rejected by both create and confirm APIs.
  OAuth now returns to the Shopify Admin app-home handle rather than incorrectly
  treating the client id as a URL slug; production therefore also requires
  `SHOPIFY_APP_HANDLE`. Local gates after a clean `npm ci`: typecheck; 140/140
  smoke; 31/31 merchant API; 10/10 pricing safety; ML-ingest; webhook integrity;
  51/51 adversarial demo integration; production build; dependency audit;
  Python ML suite; and 10/10 compiled-browser assertions including the proposal
  and explicit-confirmation flows. Invite access remains closed: staging,
  real-data ML, Partner configuration, a real Shopify test-store exercise,
  verified Vercel preview and production logs remain external gates.
- `2026-08-04T08:35:53Z` — final local integration hardening added explicit
  confirmation to the store-wide kill switch; kept completed-but-unreverted
  prices visible to emergency controls; paged large Supabase reads; reconciled
  and deduplicated operational webhooks on install, sync, App Bridge boot and a
  five-minute retry; refreshed short-lived page identity before expiry; and
  lock-paused running/scheduled rollouts on uninstall so reinstall cannot revive
  a write without a new merchant decision. The demo forecast now uses a normal
  read-only endpoint, removing an aborted Server Action request from the browser
  gate. Confirmation, emergency stop, uninstall and reinstall now share
  lease-serialized shutdown semantics, so a concurrent draft cannot revive or
  write behind a completed stop. Final local checks: typecheck; 140/140 smoke; 34/34 merchant API; 10/10
  pricing safety; ML-ingest; webhook integrity including uninstall pause; 51/51
  adversarial demo integration; 117/117 Python; production build; zero npm audit
  vulnerabilities; and 10/10 compiled-browser assertions with no console,
  request, rendering or framework-overlay failures. Automatic rollback remains
  disabled. External staging, real Shopify, Partner, preview and production-log
  gates remain closed and no production promotion has occurred.
- `2026-08-04T08:57:37Z` — external-gate audit on `codex/prod-integration`
  confirmed draft PR #3 is clean and all credential-free GitHub checks pass;
  Supabase Preview is skipped because preview branches are disabled. Static
  migration review found that the server-only rollout lease RPCs revoked their
  default execute privilege without granting it back to `service_role`.
  Migration `20260804090000_harden_rollout_lock_rpc.sql` now restores only the
  service-role grant and fixes both functions to an empty search path. This must
  still be applied and exercised on Priceflag staging before merge. The
  authenticated Supabase connector available on this machine cannot access the
  Priceflag project, and no database was touched. GitHub currently has
  `CRON_SECRET` but not `SUPABASE_URL`, `SUPABASE_ML_READONLY_KEY`, or
  `ML_INGEST_SECRET`; the latest completed nightly log explicitly used golden
  mode, so real-data ML remains unverified. The exact Vercel preview is Ready
  but SSO-protected; this machine is not authorized for the owner team, so the
  preview browser and runtime-log gates remain open. The production health
  endpoint reports real mode with Supabase reachable, while unauthenticated and
  forged merchant-route requests both return 401. Invite access remains closed;
  no merge, database change, evaluator run, price write, or promotion occurred.
- `2026-08-04T09:21:53Z` — `codex/prod-integration` commit `e0c90bc` added a
  credential-free, isolated Supabase CI gate that replays the complete migration
  chain on a fresh Postgres project, runs schema lint, and exercises the real
  Supabase adapter plus adversarial integration suite. The new gate exposed and
  fixed missing service-role grants for rollout locks and fresh-project table
  privileges while preserving append-only journal enforcement, browser-role
  denials, tenant RLS, protected RPC boundaries, and the ML read-only token
  boundary. GitHub CI now reports 159/159 real-Supabase smoke assertions and
  80/80 real-Postgres adversarial integration assertions, alongside the green
  application and Python jobs. Hosted staging is still unverified and Supabase
  Preview remains skipped; invite access remains closed. No hosted database,
  production deployment, evaluator, or Shopify price was touched.

- `2026-08-04T10:37:39Z` — `codex/prod-integration` candidate based on
  `59b9131` closes the final local safety findings: metric-specific,
  price-conditioned revenue/profit guardrails; exact heterogeneous-SKU
  reporting; deterministic chained rollback to the earliest baseline; a
  batched 1,001-variant rollback regression; Shopify topic/shop capability
  binding; and atomic, deduplicated `refunds/create` ingestion so post-order
  returns reach live profit readings. The mixed-day refund regression treats a
  negative accounting day as an unknown realized sale price instead of an
  invalid negative price. Full sync now commits through the same per-shop
  database lock and rejects a snapshot if an order/refund webhook arrived while
  Shopify was being read, so a stale sync cannot erase an already-deduplicated
  refund. Both cases are included in the real-Supabase adapter suite. Final
  independent safety rechecks report no open P0/P1 findings in rollback,
  guardrails, refund ingestion, or sync concurrency.
  Fresh local evidence: clean dependency install; typecheck; production build;
  144/144 smoke; 38/38 merchant API; 15/15 price-write safety; ML-ingest and
  webhook integrity; 63/63 demo adversarial integration; Python 117/117;
  golden-only nightly; zero dependency vulnerabilities; and 12/12 compiled
  browser interactions with no blocking console, request, render, or framework
  errors. Four new migrations remain unapplied to hosted staging and must pass
  the isolated GitHub Supabase replay after this candidate is pushed. Real-data
  ML, Shopify Partner/test-store, hosted staging/advisors, protected preview,
  and production-log gates remain external and open. Invite access remains
  closed; automatic rollback remains disabled; no hosted database, evaluator,
  Shopify price, merge, or deployment was touched.

## Current launch checklist

- [x] Clean dependency install
- [x] TypeScript, smoke, focused API/safety, demo integration, build and audit
- [x] Python tests and offline golden nightly
- [x] Session-token tenant isolation regressions
- [x] Webhook HMAC, retry dedupe, cross-shop ownership and compliance purge regressions
- [x] Zero-price, acknowledgement-loss, partial rollback, compare-at restore,
  chained kill switch and external-edit regressions
- [x] Automatic rollback disabled by default; scheduled evaluator disabled
- [x] Fresh isolated Supabase migration replay, schema lint, real adapter and
  adversarial Postgres suites
- [ ] Hosted staging migration apply, security/performance advisors and staging
  integration suite
- [ ] GitHub ML secrets and a proven real-store nightly ingest
- [x] Claude UI/App Bridge/onboarding work integrated locally with bearer-only writes
- [ ] Shopify webhook subscriptions deployed from the real Partner app config
- [ ] `SHOPIFY_APP_HANDLE`, canonical app URL, redirect URL, custom distribution,
  protected-data approval and compliance topics verified in Shopify configuration
- [ ] Test-store end-to-end write, pause, rollback and journal exercise
- [ ] Verified Vercel preview and production log scan
- [x] Zero open P0/P1 findings across the integrated candidate (local review)

## Cross-lane interface requests

- `2026-08-04T04:52:22Z` — the Claude branch had not appeared on GitHub, so
  Codex made safety-critical changes in the originally assigned platform paths:
  `middleware.ts`, `lib/shopify/**`, authenticated sync/journal/webhook/health
  routes, Shopify-write tests, and production workflows. Claude must rebase onto
  the backend PR and preserve these contracts; do not overwrite them silently.
- `2026-08-04T05:12:30Z` — Codex added the pre-existing contract routes
  `GET/PATCH /api/shop` and `PATCH /api/products/[variantId]/cogs`. Claude should
  call the PATCH routes with `authenticatedFetch` from the client and remove the
  cookie-authorized write path from `app/settings/actions.ts` and
  `app/products/actions.ts` after rebasing.
- `2026-08-04T05:22:04Z` — Codex added bearer-only `GET /api/products`,
  `GET /api/live`, `GET /api/rollouts`, `GET /api/rollouts/[id]/report`, and
  `POST /api/rollouts/[id]/cancel`. Claude may use these instead of duplicating
  rollout/readiness view logic, but must keep `resume: false` and must not create
  a beta resume control for external-change pauses.
- `2026-08-04T08:03:32Z` — ownership handoff accepted: Codex may edit the former
  Claude-owned UI/auth paths on `codex/prod-integration`. No edits will be pushed
  to `claude/prod-ui-auth-infra`; its history remains an auditable input.
  Claude still owns App Bridge token attachment, real-mode page data, Partner
  app webhook registration/config, browser UX, and preview infrastructure.
