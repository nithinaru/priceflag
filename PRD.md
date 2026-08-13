# Priceflag v1 — Product Requirements Document

| | |
|---|---|
| **Product** | Priceflag — pricing change management for Shopify |
| **Version** | v1.1 (amended Aug 2026: constrained price recommendations — Priceflag may propose; the merchant always approves) |
| **Author** | Nithin |
| **Date** | July 30, 2026 |
| **Status** | Draft for build — three-lane parallel execution |
| **Predecessor** | v0 demo (in repo) — full core loop against a simulated store |

## 1. Summary

Priceflag lets a Shopify merchant propose a price change, see its predicted 90-day
impact on profit and orders before anything goes live, and then roll the change out
gradually — by SKU cohort and by time — with guardrails written in advance and
automatic rollback if results fall below the predicted band.

One sentence: **LaunchDarkly for pricing.** Deliberately *not* Optimizely for
pricing: Priceflag is not an A/B testing tool. Every visitor sees the same price at
any given moment.

v0 proved the loop against a simulated store. v1 makes it real, with two pillars
carrying the product's weight:

1. **An extremely clear UI** — a merchant who has never seen the app reaches a
   safe first rollout without documentation, and can always answer "what is live
   right now and how do I undo it?" at a glance.
2. **Machine learning that is actually right** — a suite of Python models
   (elasticity estimation, demand baselines, counterfactual monitoring) that are
   validated against known ground truth before they're trusted, report honest
   confidence, and power both the forecast and the auto-rollback safety system.

v1 is built in three parallel lanes — Product UI (A), Platform & Shopify (B),
Machine Learning (C) — by three concurrent Claude Code sessions. Requirements
below are tagged with their owning lane.

## 2. Problem

Price changes are the highest-leverage, least-tooled decision in e-commerce. A
merchant changing a price today gets no prediction of what will happen, no staged
path to reduce risk, no monitoring against an expectation, no automatic undo, and
no record of what was changed, when, or why. The result is that merchants either
don't touch prices for years (leaving margin on the table, especially when COGS
rises) or change them store-wide in one shot and discover problems weeks later in
a P&L, long after the cause is forgettable.

Shopify itself keeps **no audit trail for prices**. The nearest tools solve
adjacent problems: Intelligems runs per-visitor price A/B tests (weeks of traffic,
per-visitor price variation, priced accordingly); Shopify Smart Pricing suggests
prices without measuring outcomes, and its native A/B mode is heavily gated;
Shopify Rollouts stages theme and checkout changes but explicitly not prices.
Nobody does **predict → stage → monitor → auto-rollback** for pricing.

## 3. Positioning and the load-bearing constraint

Per-visitor price testing on Shopify requires variant duplication or theme/checkout
injection. That creates funnel price inconsistency, breaks Google Merchant Center
and Meta feed verification (mismatch → product disapprovals), and carries
price-discrimination trust and legal risk.

Priceflag's answer is a product stance, not a workaround: changes roll out along
two safe dimensions — **fraction of selected SKUs** and **time** — never traffic.
"Every visitor sees the same price" is a marketing promise and a hard product
invariant. All v1 requirements assume it; any feature that would violate it is out
of scope by definition.

## 4. Target user

Primary: the founder or e-commerce manager of a DTC Shopify store with roughly
30–500 SKUs and $1M–$20M GMV — big enough that price changes are scary, small
enough that there is no pricing analyst and no data team. They know their COGS at
least roughly, change prices one to four times a year, and currently do it with a
spreadsheet, a bulk editor, and hope. Everything in the UI is written for this
person: no statistics vocabulary, no unexplained numbers.

Secondary (validate later): agencies managing pricing across client stores;
Shopify Plus teams needing approval workflows.

## 5. Goals and non-goals

**v1 goals**

1. A merchant can connect a real Shopify store and complete a real staged price
   rollout end to end, including an automatic rollback, without touching the
   Shopify admin and without asking a single support question.
2. Forecasts and monitoring bands come from models fitted to the store's own
   order history wherever the data supports it, with honest, visible confidence —
   and the models are provably better than naive baselines before they ship.
3. Every price change Priceflag makes is journaled and reversible.
4. The entire stack runs on free tiers (Shopify custom app + dev store, Vercel
   Hobby, Supabase free, Resend free, GitHub Actions) until pilots justify more.
5. Five to ten pilot stores complete at least one rollout each.

**v1 non-goals**

- No per-visitor / traffic-split price testing (permanent non-goal).
- No public Shopify App Store listing yet (custom-app distribution to pilots).
- No multi-currency / Shopify Markets price lists, no B2B catalogs.
- No subscription-contract price changes (flagged and excluded from selection).
- No competitor scraping.
- ~~No AI price *recommendations* — v1 predicts the impact of the merchant's
  proposal, it does not originate proposals.~~ **Amended in v1.1:** Priceflag
  may *propose* a constrained, per-SKU price suggestion derived from the same
  fitted elasticity models that power forecasts — but **the merchant always
  approves**. Suggestions are read-only prefills in the propose flow: nothing
  auto-applies, every suggestion shows its rationale (expected profit range,
  the pessimistic-bound check, and the constraints that bound it — margin
  floor, max change cap, rounding), and suggestions respect the kill switch
  and review mode. Optimizer models are subject to the same R28 eval-harness
  discipline as every other model (golden-data recovery gate `run_c7`).
- No team roles/approvals (single user per store).
- No deep learning. The data (daily aggregates, ≤500 SKUs, ≤180 days) rewards
  small-data statistics; model complexity must earn its place on the eval harness.

## 6. User stories and requirements

MUST = launch blocker; SHOULD = build if it doesn't move the date; COULD =
deferred but designed for. Lane tag in brackets.

### 6.1 Connect (onboarding)

- **R1 (MUST) [B]** OAuth install as a Shopify custom app, scopes `read_products`,
  `write_products`, `read_orders`, `read_all_orders` (full history needs the
  extra scope; on a custom app this is self-granted, no review). Token encrypted;
  uninstall webhook cleans up.
- **R2 (MUST) [B]** Initial sync: products, variants, prices, and ≥180 days of
  order history in the background, catalog usable as soon as products land.
- **R3 (MUST) [A]** COGS capture: imported from Shopify's per-variant cost field
  where present, inline-editable where missing; products without COGS show
  revenue forecasts with a "profit unknown — add cost" state, never a fabricated
  profit number.
- **R4 (SHOULD) [B]** Webhooks on install: `orders/create`, `products/update`,
  `app/uninstalled`, GDPR topics. External price edits (made in Shopify admin)
  are journaled as `external` and pause any rollout touching that product.
- **R24 (MUST) [A]** Onboarding shows sync progress plainly (what's loaded,
  what's still coming, what's usable now) and guides the merchant to a sensible
  first rollout (modest change, forgiving guardrails).

### 6.2 Propose and forecast

- **R5 (MUST) [A]** Propose a uniform % or absolute change across one or many
  SKUs (search/filter/multi-select from catalog).
- **R6 (MUST) [A]** Forecast card per proposal: breakeven demand change stated as
  a plain sentence first (pure margin arithmetic — always true), then the
  predicted 90-day range for profit Δ, revenue Δ, orders Δ.
- **R7 (MUST) [C]** Fitted demand model: per-product elasticity from the store's
  own price variation (regularized log-log regression with seasonality and promo
  controls, shrunk toward a portfolio prior; hierarchical model when it proves
  better). Every estimate carries `fitted | partial | assumption` confidence
  with a one-line plain-language explanation.
- **R8 (MUST) [A]** "Show your work": the transparent scenario table from v0
  remains visible beneath every fitted number. No black boxes anywhere in the UI.
- **R28 (MUST) [C]** Model honesty gate: no model ships or updates unless it
  beats the incumbent (starting incumbent: seasonal-naive baseline and v0
  bracket math) on the golden-data + backtest eval harness. Failed challengers
  are recorded, not deployed.
- **R9 (COULD) [A]** Portfolio view: aggregate forecast for a change across a
  collection.

### 6.3 Guardrails and staged rollout

- **R10 (MUST) [A,B]** Guardrails defined at proposal time as an editable plain
  sentence ("if daily units fall more than 30% below expected for 2 days in a
  row, revert everything automatically"), stored immutably with the rollout.
- **R11 (MUST) [B]** Staged rollout by SKU cohort, editable stages (default 25%
  → 50% → 100%, hold 3–4 days); single-SKU rollouts collapse to a time canary.
- **R12 (MUST) [B]** Price writes via Admin GraphQL `productVariantsBulkUpdate`:
  idempotent, rate-limit aware, retried with backoff, journaled. Pre-rollout
  prices captured at creation are the single source of truth for rollback.
- **R13 (MUST) [B]** Compare-at policy: on decrease, preserve compare-at; on
  increase past compare-at, clear it (never display a fake discount).
- **R14 (SHOULD) [B]** Scheduled start ("go live Monday 6am store time").

### 6.4 Monitor, rollback, journal

- **R15 (MUST) [B]** Daily evaluation of active rollouts (cron): aggregate actual
  orders, compare to the expected band, evaluate guardrails, advance / hold /
  auto-rollback. Idempotent, per-rollout locked.
- **R29 (MUST) [C]** Expected bands come from a fitted baseline demand model
  (seasonality + trend + promo aware, honest intervals, low-volume floor), not a
  point guess — the band's calibration is a *safety property* because it drives
  auto-rollback. Counterfactual (CausalImpact-style) monitoring with breach
  probability replaces raw thresholds once it beats them on the harness.
- **R16 (MUST) [A]** Rollout page answers at a glance: what stage, what's live,
  actual vs expected (with the uncertainty band drawn), breach status, and a
  one-click rollback. Event log in plain language.
- **R17 (MUST) [B]** Auto-rollback restores every affected price within minutes
  of the triggering evaluation and notifies the merchant.
- **R18 (MUST) [A,B]** Price journal: every change (rollout, rollback, external)
  with before/after, actor, reason, linked rollout; filterable; CSV export.
- **R19 (MUST) [B]** Email notifications for start / stage advance / breach /
  auto-rollback / completion. **(SHOULD)** Slack webhook.
- **R20 (SHOULD) [A,C]** Post-rollout report: realized vs predicted, updated
  elasticity, plain-language narrative ("your customers were less price-sensitive
  than assumed"). Each completed rollout makes the next forecast better — this is
  the retention loop.
- **R30 (MUST) [C]** Calibration tracking from day one: % of completed rollouts
  whose realized 30-day profit lands inside the predicted range, stored and
  reportable.

### 6.5 UI quality bar (cross-cutting, Lane A)

- **R25 (MUST)** Plain language everywhere: no "elasticity", "confidence
  interval", or "guardrail threshold" in merchant-facing copy — say what happens
  and when. Technical detail available behind "show your work" affordances.
- **R26 (MUST)** Every screen designed for its worst state: empty, loading,
  syncing, error, zero-COGS, thin-history. No dead ends; every state says what
  to do next.
- **R27 (MUST)** Accessible and responsive: WCAG AA contrast, keyboard
  navigable, readable on a phone (merchants check rollouts from phones).

### 6.6 Trust and safety (cross-cutting)

- **R21 (MUST) [B]** Store-level kill switch: revert everything Priceflag ever
  changed, one action.
- **R22 (MUST) [B]** Never modify products outside an active rollout's
  selection; subscription products and gift cards excluded in v1.
- **R23 (MUST) [B]** Webhook HMAC verification; GDPR webhooks; tokens encrypted
  at rest; only daily aggregates stored (units/revenue per SKU per day), never
  customer identities.
- **R31 (MUST) [C]** Model outputs are versioned (`model_runs` registry); every
  forecast and band is traceable to the model version that produced it.
- **R32 (MUST) [B,C]** Staleness rule: if fits/bands are missing or stale the
  system degrades gracefully to transparent bracket math tagged `assumption` —
  it never blocks and never silently serves stale model output as fresh.
- **R33 (MUST) Application authentication. Every route that reads shop data or can cause a price write must require a verified session (Shopify App Bridge session token via lib/shopify/session.ts), not the statically-configured shop. Deployment Protection is not access control for production: the project's ssoProtection is all_except_custom_domains, so attaching a pilot's custom domain removes it entirely — which is exactly what onboarding a merchant involves. Pilot launch blocker.

## 7. Success metrics

Activation: a connected store starts its first rollout within 7 days (≥60% of
pilots). Clarity: zero support questions needed to reach a first rollout (track
every question a pilot asks; each one is a UI bug). Depth: ≥80% of rollouts
launched with consciously-set guardrails. Safety: 100% of auto-rollbacks restore
correct prices (verified against journal); band calibration within ±10pts of
nominal coverage. Honesty: ≥70% of completed rollouts land realized 30-day
profit inside the predicted range (R30 measures this; measuring it at all is the
moat). Outcome: median realized profit Δ across completed rollouts is positive.
Retention: ≥50% of pilots run a second rollout within 60 days.

## 8. Competitive context

| | Priceflag | Intelligems | Shopify Smart Pricing | Shopify Rollouts |
|---|---|---|---|---|
| Core motion | Predict → stage → guardrail → rollback | Per-visitor price A/B tests | AI price suggestions; gated native A/B | Theme/checkout launches & experiments |
| Prices vary per visitor | Never | Yes (its premise) | In A/B mode | n/a (no pricing) |
| Prediction before change | Yes, calibrated | No (test to learn) | Suggestion without measurement | No |
| Auto-rollback on live metrics | Yes | No | No | No |
| Price audit trail | Yes | No | No | No |
| Works without big traffic | Yes | Needs traffic | A/B mode needs volume | n/a |

## 9. Risks and open questions

Top risks: (1) **forecast credibility** — thin price-variation history is the
norm; mitigations are the confidence-tier UX, hierarchical pooling (C4), and
leading with breakeven math, which is always true. (2) **noisy small stores** —
guardrails driven by miscalibrated bands would whipsaw pilots with random
rollbacks; hence R29's calibration-as-safety-property and breach probabilities.
(3) **external interference** — promos or admin edits mid-rollout; detected via
`products/update`, rollout pauses with a prompt instead of mis-attributing the
demand shift. (4) **platform motion** — Shopify Smart Pricing could grow
measurement; speed, the journal, and the guardrail habit are the defense.
(5) **three-lane drift** — parallel chats diverging; mitigated by frozen
contracts and integration checkpoints.

Open questions for pilots: is SKU-cohort staging comprehensible, or does
everyone want the time canary on everything? Auto-rollback on by default, or
alert-only first? Email enough, or is Slack a launch need? Pricing model —
leaning flat $99–199/mo.

## 10. Release plan

Execution is sprint-based across three parallel lanes (7 sprints each), with
five integration checkpoints; CP3 is the demo-able
product, CP5 is pilot-ready. Every sprint ends with a push to GitHub, so `main`
always reflects the true state of all three lanes. After CP5: dogfood on the dev
store, then 2–3 friendly pilots via custom-app install links, then 5–10 pilots
with weekly check-ins. Exit criteria to start the v2 / App Store track: ≥5
completed real rollouts, ≥1 auto-rollback that saved a merchant money, forecast
calibration ≥60%, and 3 merchants who would be "very disappointed" without it.
