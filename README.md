# Priceflag ⚑

**Pricing change management for Shopify.** Connect your store, propose a new
price, and see the predicted 90-day impact on profit, orders, and revenue before
it goes live. Then roll the change out gradually — 25% of selected SKUs, 50%,
everyone — with guardrails that pause and alert when performance drops.

*LaunchDarkly for pricing.* Not an A/B testing tool: **every visitor always sees
the same price.** Priceflag stages changes by SKU cohort and by time, never by
traffic — no funnel price inconsistency, no Google Merchant Center feed
mismatches, no price-discrimination trust problems.

## How it works

1. **Connect** — install the app (Shopify custom app, free); Priceflag syncs
   your catalog, costs, and 180 days of order history via the Admin GraphQL API.
2. **Propose** — pick SKUs, enter a new price.
3. **Forecast** — a breakeven sentence that's always true ("you can lose up to
   14% of orders and still make the same profit"), plus a predicted 90-day range
   fitted to your store's own history by Python ML models, with an honest
   confidence tier (fitted / partial / assumption) and the work shown.
4. **Guardrails first** — decide the abort conditions before anything goes live.
5. **Staged rollout** — new price on 25% of selected SKUs → 50% → all, each
   stage held while real orders are monitored against a model-calibrated band.
6. **Safe recovery** — during the invite-only beta, a tripped guardrail pauses
   and alerts; it never writes prices automatically. Confirmed manual rollback
   and a store-level kill switch restore and verify frozen baseline prices.
7. **Price journal** — every change (even ones made outside Priceflag), with
   before/after, who, when, why, and outcome. Shopify keeps no price audit
   trail; Priceflag does.

## Project status

**v1 — in development, built in three parallel lanes** by concurrent Claude Code
sessions with non-overlapping file ownership:

| Lane | Mission | Owns |
|---|---|---|
| **A — Product UI** | Extremely clear interface; first rollout with zero explanation | `app/` (except `app/api/`), `components/` |
| **B — Platform & Shopify** | OAuth, sync, price writes, webhooks, evaluator, deploy | `lib/`, `app/api/`, `supabase/`, `contracts/`, `scripts/` |
| **C — Machine Learning** | Python models that actually work: elasticity, demand baselines, counterfactual bands, calibration | `ml/`, `.github/workflows/ml-*` |

Read in this order: `PRD.md` (what and why, requirements R1–R32) →
`BUILD_BRIEF.md` (lane rules, contracts, 7 sprints per lane, integration
checkpoints) → `CLAUDE.md` (ground rules for agents) → `PROMPTS.md` (kickoff
prompt for each lane's chat). Lanes coordinate only through `contracts/` and
`docs/lane-status/` — see BUILD_BRIEF §2 before touching anything.

The v0 demo (full core loop against a simulated store, no Shopify account
needed) ships in this repo permanently — it's the sales demo and the test
harness.

## Getting started

### Demo mode (no Shopify account)

```bash
npm install
npm run dev                  # http://localhost:3000 — simulated store, full loop
npx tsx scripts/smoke.ts     # engine smoke test
```

Open `http://localhost:3000/model-lab` for the Founder Lab. It accepts editable
price, cost, sales-volume, elasticity, uncertainty, history, horizon, rounding,
and SKU-count inputs, then runs the shared production forecast engine and SKU
rollout planner. The entered elasticity is visibly labelled as a simulated fit;
the route stores nothing and is unavailable when `PRICEFLAG_MODE=real`.

```bash
npm run test:founder-lab     # focused engine + rollout-plan checks
npm run smoke:browser        # includes the full interactive Founder Lab path
```

### Real mode (free end to end)

Prereqs — all free tiers: [Shopify Partner account](https://partners.shopify.com)
with a development store and a custom app on it (instant API credentials, no
review; grant `read_all_orders` for full history), [Supabase](https://supabase.com)
project, [Resend](https://resend.com) key, [Vercel](https://vercel.com) Hobby for
deploy, GitHub Actions for the nightly ML refit.

```bash
cp .env.example .env.local   # fill in the table below
npx supabase db push         # apply migrations
npm run dev
```

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Partner app credentials |
| `SHOPIFY_APP_HANDLE` | App-home slug from Shopify Dev Dashboard |
| `SHOPIFY_SCOPES` | `read_products,write_products,read_orders,read_all_orders` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Database |
| `ML_INGEST_SECRET` | Rotatable server-to-server credential for narrow ML export and validated ingest routes |
| `RESEND_API_KEY` | Email notifications |
| `APP_URL` | Public app URL (ngrok / Vercel) |
| `ENCRYPTION_KEY` | Encrypts Shopify tokens at rest |
| `CRON_SECRET` | Protects the evaluator endpoint |
| `PRICEFLAG_SHOP_ALLOWLIST` | Required for beta deploys: exact invited shop IDs/domains the evaluator may touch |

### ML lane (Python)

```bash
cd ml
uv sync                      # Python 3.12, pinned deps
pytest                       # golden-data recovery + backtest gates
```

The production nightly never receives a Supabase credential. It reads aggregate
model inputs through authenticated `POST /api/ml/export`; the application keeps
its service-role key server-side and the route cannot represent Shopify tokens,
customer identities, or order-level records. The worker first attests that the
origin is a READY deployment in the pinned Vercel project and that the export
reports the expected Supabase project and environment. Migration
`20260804180000_normalize_ml_readonly_privileges.sql` permanently retires the
former direct reader as `NOLOGIN` and removes its policies, memberships and
application grants.

`ml-nightly.yml` fails closed unless it sees at least one real shop with order
history and the application acknowledges at least one model-output row. Its
target is verified against the pinned Vercel project and deployment class before
the ingest secret is sent. Every accepted model-run receipt is then read back
through the same authenticated application boundary with the exact commit,
status and row count. The only uploaded file is `real_ingest_evidence.json`; it
records the source identity,
aggregate counts, commit and pass/fail state—never shop domains, products,
variant IDs, model-run IDs, order data, connection details, or credentials. A
green golden-only run is useful PR evidence but is not a production-nightly
launch gate.

Real-data release verification is a separate push-triggered
`ml-release-gate.yml` job on `codex/prod-integration`. Its
`priceflag-ml-release` Environment must require human approval of the exact SHA,
prevent self-review/bypass and allow only that branch. The scheduled production
job has no manual dispatch and uses a separate `priceflag-ml-production`
Environment restricted to `main`. Both jobs query GitHub's Environment and
deployment-branch-policy APIs before any secret-bearing step, including the
release environment's administrator-bypass setting. The owner must still verify
that the ML credentials exist only as Environment secrets.

### Pull-request safety gates

Every pull request runs the credential-free `production-gates` workflow. It
installs the exact Node and Python lockfiles, then runs typechecking, smoke,
merchant API, price-write, ML-ingest, webhook, deployment-safety, and demo
integration tests; a dependency audit; the production build; Python tests; and
the deterministic golden nightly model/drift gates. The workflow has
read-only repository access; it receives no secrets, deploys nothing, and makes
no production calls.

The Supabase integration suite cannot run safely in untrusted pull-request CI
without staging credentials. It is therefore an environment-required launch
gate, not a skipped or mocked PR success: before preview promotion, an operator
must run the suite against the dedicated staging Supabase project and record a
green result. Never point this gate at production or expose its credentials to
forked pull requests.

The manual `staging-launch-gates` workflow provides that evidence. Create a
protected GitHub Environment named `priceflag-staging` with a required human
reviewer and restrict deployment branches to `main` and
`codex/prod-integration`. Set its non-secret `SUPABASE_PROJECT_REF` variable,
and store `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, and
`SUPABASE_STAGING_SENTINEL` as environment secrets. Do not provide a Supabase
Management API access token. Before the first run, an owner must mark the
dedicated staging database with these database settings (substituting the real
staging ref and a newly generated random secret):

```sql
alter database postgres set app.priceflag_environment = 'staging';
alter database postgres set app.priceflag_project_ref = '<staging-project-ref>';
alter database postgres set app.priceflag_staging_sentinel = '<random-secret>';
```

Store the same random secret only as the protected Environment's
`SUPABASE_STAGING_SENTINEL`; never reuse or print it. Dispatch the workflow from
`codex/prod-integration` (or `main` after approval), entering
`APPLY_STAGING_MIGRATIONS` and the exact full candidate SHA. It refuses the
known Production project and positively verifies the staging ref, environment,
and secret database sentinel before any mutation. It performs a migration dry
run, applies migrations, proves a second dry run is clean, runs the real adapter
and adversarial suites, lints the hosted database, blocks security advisor
warnings/errors and performance advisor errors, and retains the complete JSON
advisor evidence for 30 days. Never put these values in a repository secret,
workflow input, file committed to Git, issue, or chat.

## Repo layout

```
app/            UI pages + server actions (Lane A) · app/api/ webhooks, cron, oauth (Lane B)
components/     design system + UI components (Lane A)
lib/            engine: types, adapters, rollout state machine, forecast plumbing (Lane B)
contracts/      JSON Schemas + DB schema docs — the law between lanes (Lane B owns)
supabase/       migrations (Lane B)
ml/             Python models: elasticity, demand baselines, counterfactual, eval harness (Lane C)
scripts/        smoke test, store simulator (Lane B)
lib/auth/       magic-link accounts: the pf_user session cookie and account→shop link
docs/lane-status/  one status file per lane — how the three chats communicate
PRD.md · BUILD_BRIEF.md · CLAUDE.md · PROMPTS.md
```

## Signing in

Two independent ways in, answering different questions:

- **From the Shopify admin** — the app is embedded, Shopify signs a session
  token, and no Priceflag account is involved. This is the everyday path.
- **From signin.priceflag.org** — a magic link proves control of an email
  address and mints the `pf_user` cookie. For somebody who has not installed
  yet, or who opens the dashboard directly rather than through Shopify.

Neither authorises a price write; that still requires a Shopify session token,
checked in the route handler, every time. The sign-in screen itself is
`signin.html` in the website repo — static, and holding no keys.

Setup, including the Supabase and Vercel steps that cannot live in the repo, is
in [docs/auth-setup.md](docs/auth-setup.md).

## Principles

Money is integer cents, always. Forecasts show their work — assumptions, ranges,
confidence tiers, never a confident black box; no model ships unless it beats
the incumbent on the eval harness. Every price write is journaled and
reversible; band calibration is a safety property because it drives pause-and-alert
guardrails. Automatic rollback remains disabled for the beta. And the invariant
that names the product: **prices never vary by visitor.**

---

Stack: Next.js 15 · React 19 · TypeScript · Tailwind v4 · Supabase · Vercel ·
Shopify Admin GraphQL API · Python 3.12 (statsmodels, scikit-learn, LightGBM,
PyMC) · GitHub Actions.
