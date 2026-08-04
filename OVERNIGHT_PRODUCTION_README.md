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

## Current launch checklist

- [x] Clean dependency install
- [x] TypeScript, smoke, focused API/safety, demo integration, build and audit
- [x] Python tests and offline golden nightly
- [x] Session-token tenant isolation regressions
- [x] Webhook HMAC, retry dedupe, cross-shop ownership and compliance purge regressions
- [x] Zero-price, acknowledgement-loss, partial rollback, compare-at restore,
  chained kill switch and external-edit regressions
- [x] Automatic rollback disabled by default; scheduled evaluator disabled
- [ ] Staging Supabase migration apply, advisors and Supabase integration suite
- [ ] GitHub ML secrets and a proven real-store nightly ingest
- [ ] Claude UI/App Bridge/onboarding branch and PR
- [ ] Shopify webhook subscriptions deployed from the real Partner app config
- [ ] Test-store end-to-end write, pause, rollback and journal exercise
- [ ] Verified Vercel preview and production log scan
- [ ] Zero open P0/P1 findings across the integrated candidate

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
  Claude still owns App Bridge token attachment, real-mode page data, Partner
  app webhook registration/config, browser UX, and preview infrastructure.
