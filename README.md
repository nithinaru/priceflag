# Priceflag ⚑

**Pricing change management for Shopify.** Connect your store, propose a new
price, and see the predicted 90-day impact on profit, orders, and revenue before
it goes live. Then roll the change out gradually — 25% of selected SKUs, 50%,
everyone — with guardrails you set in advance and automatic rollback if the
numbers drop.

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
6. **Auto-rollback** — a tripped guardrail restores every price within minutes.
   One-click manual rollback and a store-level kill switch always available.
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
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Custom app credentials |
| `SHOPIFY_SCOPES` | `read_products,write_products,read_orders,read_all_orders` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Database |
| `SUPABASE_ML_READONLY_KEY` | Read-only role for the ML lane |
| `RESEND_API_KEY` | Email notifications |
| `APP_URL` | Public app URL (ngrok / Vercel) |
| `ENCRYPTION_KEY` | Encrypts Shopify tokens at rest |
| `CRON_SECRET` | Protects the evaluator endpoint |

### ML lane (Python)

```bash
cd ml
uv sync                      # Python 3.12, pinned deps
pytest                       # golden-data recovery + backtest gates
```

## Repo layout

```
app/            UI pages + server actions (Lane A) · app/api/ webhooks, cron, oauth (Lane B)
components/     design system + UI components (Lane A)
lib/            engine: types, adapters, rollout state machine, forecast plumbing (Lane B)
contracts/      JSON Schemas + DB schema docs — the law between lanes (Lane B owns)
supabase/       migrations (Lane B)
ml/             Python models: elasticity, demand baselines, counterfactual, eval harness (Lane C)
scripts/        smoke test, store simulator (Lane B)
docs/lane-status/  one status file per lane — how the three chats communicate
PRD.md · BUILD_BRIEF.md · CLAUDE.md · PROMPTS.md
```

## Principles

Money is integer cents, always. Forecasts show their work — assumptions, ranges,
confidence tiers, never a confident black box; no model ships unless it beats
the incumbent on the eval harness. Every price write is journaled and
reversible; band calibration is a safety property because it drives
auto-rollback. And the invariant that names the product: **prices never vary by
visitor.**

---

Stack: Next.js 15 · React 19 · TypeScript · Tailwind v4 · Supabase · Vercel ·
Shopify Admin GraphQL API · Python 3.12 (statsmodels, scikit-learn, LightGBM,
PyMC) · GitHub Actions.
