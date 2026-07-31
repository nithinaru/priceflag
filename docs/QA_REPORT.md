# Priceflag — Lane D QA Report

**Date:** 2026-07-30 · **Author:** Lane D (Integration & Adversarial QA) · **Commit under test:** `461a370`

Every finding below is reproducible from a clean checkout. Where a finding is
proved by a test, the test is committed in `tests/integration/` and is **failing
on purpose** — a test that fails because the product is wrong is a finding, not a
test to adjust.

```bash
npm install && npm run typecheck && npm run build
npx tsx scripts/smoke.ts
cd ml && uv sync --frozen && uv run pytest -q && cd ..
npx tsx tests/integration/run.ts          # Lane D — 52 passed, 9 failed
```

---

## 1. Headline

**No. This cannot be pointed at a real merchant's store today.**

The engine is genuinely good — rollback arithmetic, cent-exactness, R22
containment and idempotency all survived hard fuzzing. But three separate things
are true at once, and any one of them is disqualifying:

1. **The safety system is miscalibrated in a way that fires on healthy stores.**
   At the *shipped default* guardrail, a rollout with unchanged demand — pure
   Poisson noise — auto-rolls back **40% of the time on 1 SKU and 10% on 6 SKUs**
   ([D-01](#d-01)). Worse, the band it compares against is a *no-change*
   baseline, so a price rise whose demand effect was forecast **exactly right**
   auto-rolls back **68.5%** of the time ([D-02](#d-02)). Auto-rollback currently
   punishes correct forecasts.
2. **Undo is not trustworthy.** The kill switch leaves chained rollouts on a
   price Priceflag invented ([D-04](#d-04)); a rollback silently skips variants
   Shopify repriced but never acknowledged, and then *reports success*
   ([D-05](#d-05)); and a `-100%` change writes **$0.00** to the storefront
   ([D-06](#d-06)).
3. **There is no merchant-facing product.** Every screen renders the simulated
   demo store — in production, where `/api/health` says `"mode": "real"`
   ([D-07](#d-07)); a merchant cannot create a rollout at all ([D-08](#d-08));
   and there is no authentication ([D-09](#d-09)).

Nothing catastrophic has happened yet only because (3) means production has no
rollouts for the live hourly evaluator ([D-18](#d-18)) to act on. That is a
coincidence of incompleteness, not a safety property.

## 2. Counts

| | P0 | P1 | P2 | P3 | Total |
|---|---:|---:|---:|---:|---:|
| **DEFECT** | 6 | 6 | 1 | 0 | **13** |
| **NOT-BUILT** | 3 | 2 | 0 | 0 | **5** |
| **RISK** | 0 | 1 | 2 | 1 | **4** |
| **DOC-DRIFT** | 0 | 0 | 2 | 2 | **4** |
| **Total** | **9** | **9** | **5** | **3** | **26** |

## 3. What I verified as CORRECT

This matters as much as the findings. These were attacked and held.

| Property | Evidence |
|---|---|
| **Rollback arithmetic** | 40 fuzzed rollouts × 1–25 SKUs × prices and percentages that round badly (1, 999, 1667 @ 0.5%, 7%, 33%, 1/3), rollback at every stage, mid-stage interrupts, double rollback, rollback of a completed rollout, rollback after a partial stage. Every variant restored **to the cent**, compare-at included, on both adapters. Journal replay independently agrees. |
| **Cent-exactness** | 40 000 randomised round trips through Shopify decimal strings are byte-identical. Rollback reads the *captured* baseline, never an inverse percentage — the property that makes 7%-of-1667 safe. No float money in the pricing path. |
| **R22 — no write outside selection** | Proved against the writer's actual call log, not its plan. Bystander variants present in the store but absent from the rollout are never written, across advance, rollback and kill switch. Gift cards, subscription and non-`ACTIVE` products excluded at *write* time with a recorded reason. |
| **No per-visitor pricing** | Holds by construction. `assignCohorts(rolloutId, variantGids, stages)` takes no request, no user, no clock; stable across calls and input order. The pricing surface contains no visitor/session/cookie/UA/IP/traffic identifier. |
| **Idempotency & the forward crash window** | Re-applying a stage writes and journals nothing extra. Shopify-applied-but-DB-never-heard converges on the next reconcile without double-writing. `applied_at` is stamped only after Shopify confirms, so the DB can lag reality but never leads it. |
| **Evaluator mutual exclusion** | Two evaluators racing one rollout: exactly one runs, the other reports `locked`. Both adapters; the Supabase lease is enforced by Postgres. |
| **Journal immutability (except TRUNCATE)** | `UPDATE`, `DELETE` and `ON CONFLICT DO UPDATE` are all rejected by the database itself, not by convention. |
| **R28 — the model gate genuinely rejects** | Production `model_runs`: **3 succeeded, 4 rejected, 3 failed**. A worse-than-incumbent model is refused at the ingest boundary and recorded rather than deployed. Real, not aspirational. |
| **No ground-truth leak** | `truth[]` never reaches a forecast, an API response or the client. `scripts/seed-demo-fits.ts` hands Lane C's real fitter the **observable columns only**, using `truth[]` solely for a printed human comparison. Some demo SKUs honestly come back `assumption`. |

---

## 4. P0 findings

<a id="d-01"></a>
### D-01 · DEFECT · P0 — Auto-rollback fires on 10–40% of perfectly healthy rollouts

PRD risk #2, quantified for the first time. Lane A hit this and raised a *demo
fixture* guardrail from 30% to 45%; merchants are still on the shipped default.

Monte Carlo over `lib/engine/bands.ts` + `lib/engine/guardrails.ts`: 200 runs per
cell, a 12-day rollout (the default 25/50/100 plan), demand **unchanged** — only
Poisson noise — at the shipped default (`30% below expected for 2 days`,
`action: rollback_all`).

| Selection | False auto-rollback rate |
|---|---:|
| 1 SKU @ 3 units/day | **40.0%** |
| 3 SKUs @ 3/day | **29.5%** |
| 6 SKUs @ 3/day | **10.0%** |
| 12 SKUs @ 2/day | 7.0% |
| 26 SKUs @ 2/day | 0.0% |
| 50 SKUs @ 1/day | 0.5% |

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`✗ the shipped default guardrail on pure noise`.

**Blast radius.** The PRD's target merchant has 30–500 SKUs and changes prices on
a handful at a time. A single-SKU time canary — the *recommended* safe first
rollout (R11, R24) — coin-flips its way to a spurious revert two times in five.
Every one of those reverts real prices, sends a "your guardrail fired" email, and
burns the merchant's trust in the automation permanently. Success metric
"100% of auto-rollbacks restore correct prices" is met; the metric that matters —
*were they warranted* — is not measured anywhere.

---

<a id="d-02"></a>
### D-02 · DEFECT · P0 — The guardrail scores a change against a *no-change* band, so a correct forecast triggers a rollback

The expected band is built from history **strictly before the rollout started**
([lib/evaluator/index.ts:150-163](lib/evaluator/index.ts#L150)) — deliberately, so
it cannot drift toward the effect it is detecting. But that makes it a
counterfactual "what if nothing changed" baseline (exactly what R29 specifies),
and the guardrail then treats the merchant's *intended, predicted* demand drop as
a shortfall against it.

Same harness, 6 SKUs, demand falls by exactly the amount the forecast predicted:

| Predicted **and realised** drop | Auto-rollback rate |
|---|---:|
| 5% | 24.5% |
| 10% | 32.5% |
| 15% | 48.0% |
| 20% | **68.5%** |
| 25% | **76.5%** |
| 30% | **92.0%** |

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`✗ a correctly-forecast price rise is scored against a NO-CHANGE band`.

**Blast radius.** This inverts the product. A merchant raises prices, Priceflag
predicts orders will fall 20%, orders fall 20% — the forecast was *right*, profit
is up, and the system reverts it. Any price change with a meaningful predicted
demand effect is unrunnable under a 30% guardrail. The guardrail sentence the
merchant agrees to says "if daily units fall more than 30% below **expected**",
and no merchant reads "expected" as "expected if you had changed nothing".

**Fix direction (Lane B + C):** the guardrail must compare against expected units
*given the change* — the band shifted by the forecast's own predicted effect — or
against C5's counterfactual with its breach probability. Until then, auto-rollback
should default to `auto_rollback: false` (alert-only), which the code already
supports.

---

<a id="d-03"></a>
### D-03 · DEFECT · P0 — The safety system goes silently blind on day 28

The evaluator loads history `[start-60, start-1]`
([lib/evaluator/index.ts:151](lib/evaluator/index.ts#L151)) and `bracketBand`
looks at `[day-28, day)` ([lib/engine/bands.ts:67](lib/engine/bands.ts#L67)).
Once `day >= start + 28` the two ranges no longer overlap, the window is empty,
and the band returns `expected_units: 0, floored: true`. A floored units rule can
never hold, so **no guardrail can fire from rollout day 28 onward**.

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`✗ the bracket band goes blind once the rollout outlives its history window`.
The test drives a *total collapse to zero units for three consecutive days* and
the guardrail does not fire.

**Blast radius.** Silent, and it fails open. Reachable by any rollout that
outlives 28 days: a paused-and-resumed rollout, a long canary, a plan with long
holds, or a rollout that keeps holding because it is marginally under band. The
merchant believes they are covered — the UI still shows a guardrail — and they
are not.

---

<a id="d-04"></a>
### D-04 · DEFECT · P0 — The kill switch leaves chained rollouts on a Priceflag-invented price (R21)

R21 promises "revert everything Priceflag ever changed, one action".
[app/api/kill-switch/route.ts:63](app/api/kill-switch/route.ts#L63) instead
unwinds *each rollout to its own captured baseline*, in whatever order
`listRollouts` returns. Those coincide only if the order is strictly newest-first,
and `listRollouts` sorts on `created_at` with **no tie-breaker**
([demo.ts:526](lib/adapters/demo.ts#L526),
[supabase.ts:302](lib/adapters/supabase.ts#L302)) — so same-tick rollouts sort
equal, the stable sort preserves insertion order, and oldest wins.

Chained rollouts are the *normal* case for a returning merchant: it is the
retention loop the PRD is built on (R20).

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`R21 broken in 10/12 attempts`. Price 1000 → rollout A (+10%) → 1100, completed →
rollout B (+10%) → 1210. Kill switch. Correct: 1000. Actual: **1100**.

**Blast radius.** The merchant hits the emergency undo and is left selling at a
price they never chose, while the response says `ok: true` and *"Every price
Priceflag changed is back to what it was"*. A confident failure is worse than a
loud one. Latent rather than constant on Supabase (microsecond timestamps), which
means it would be found by a merchant, not by a test.

**Fix:** restore each variant to the **earliest** journaled `before_price_cents` —
which is what `PILOT_RUNBOOK.md`'s manual recovery SQL already does.

---

<a id="d-05"></a>
### D-05 · DEFECT · P0 — Rollback skips variants Shopify repriced but never acknowledged, then reports success

The mirror of the crash window. `applyStage` writes, Shopify applies it, the
socket dies, so `applied_at` stays null — correct, and `reconcile` heals it
*forward*. But `rollbackRollout` selects on `applied_at !== null`
([lib/pricing/writer.ts:331](lib/pricing/writer.ts#L331)), so a rollback issued
before the next reconcile does not consider that variant part of the rollout at
all. `verifyRollback` filters on the same predicate
([writer.ts:444](lib/pricing/writer.ts#L444)), so it reports **0 mismatches** and
the rollout is declared clean.

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`✗ a rollback skips variants Shopify repriced but never acknowledged`
(`expected 5000, actual 6000`, `intended=0, applied=0`, `0 mismatches`).

**Blast radius.** Exactly the situation a rollback exists for — something went
wrong mid-write — is the situation where it silently under-reverts. The
verification step that exists to catch this shares the bug, so both the journal
and the "verified" flag agree with each other and with nothing real.

**Fix:** rollback and verify should select every non-excluded variant whose live
price differs from its baseline, not those the DB believes it applied.

---

<a id="d-06"></a>
### D-06 · DEFECT · P0 — A `-100%` change writes $0.00 to the storefront

`applyPercent` and `applyAbsolute` clamp with `Math.max(0, …)`
([lib/money.ts:102](lib/money.ts#L102),
[money.ts:108](lib/money.ts#L108)). `computeTargetPrice` rejects a 0% change as
"not a change" but accepts a change *to* zero. Nothing in the money layer, the
forecast, the rollout planner or the price writer floors a target price above
zero.

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`✗ a -100% rollout writes $0.00 to the storefront` — 3/3 variants, `applied=3`.

**Blast radius.** A merchant who types `-100`, or an absolute cut larger than the
price, gives every selected product away for free, staged politely across three
cohorts. The forecast card renders a complete, confident set of numbers for it
first. There is no confirmation step that mentions zero.

**Fix:** reject a target price below some floor (1 cent at minimum) in
`computeTargetPrice`, and again in the writer as defence in depth.

---

<a id="d-07"></a>
### D-07 · NOT-BUILT · P0 — Every merchant-facing screen renders the simulated demo store

Every page under `app/` (except `app/api/**`) imports from
`@/components/demo/store` and `@/components/demo/rollouts`. The **only**
`getAdapter()` call outside `app/api/` is
[app/propose/actions.ts:63](app/propose/actions.ts#L63). `getDemoStore()` has no
mode check; `lib/config.ts` exposes `isDemoMode()` and nothing in `app/` or
`components/` calls it.

**Reproduction** against live production:

```bash
curl -s https://priceflag-app.vercel.app/api/health | python3 -m json.tool
# {"ok": true, "mode": "real", "adapter": {"kind": "supabase", "ok": true, ...}}

SEC=$(grep '^APP_ACCESS_SECRET=' .env.local | cut -d= -f2-)
curl -sL -c /tmp/j -b /tmp/j "https://priceflag-app.vercel.app/?access=$SEC" \
  | grep -oE 'ro_20[0-9]+|Everyday Tee|Demo data' | sort -u
# Demo data / Everyday Tee / ro_2039 / ro_2041 / ro_2042 / ro_2043
```

Production reports `mode: "real"` and serves the fictional catalogue. The 26
genuinely synced products of `priceflag-test.myshopify.com` are invisible on
every screen.

**NOT-BUILT rather than DEFECT** because the UI carries a permanent `Demo data`
badge, so it does not *claim* to be real. Still P0: it blocks the pilot entirely.

---

<a id="d-08"></a>
### D-08 · NOT-BUILT · P0 — A merchant cannot create a rollout

[app/propose/actions.ts:106](app/propose/actions.ts#L106) validates the request
and returns `{ ok: true, rollout_id: null, message: "This is the demo store…" }`.
There is no `POST /api/rollouts` route — `app/api/` holds `auth`, `cron`,
`health`, `journal`, `kill-switch`, `ml/ingest`, `sync`, `sync/status`,
`webhooks` and nothing else. `contracts/api.md` documents both
`POST /api/rollouts` and `POST /api/forecast`; neither exists.

**Blast radius.** The product's proposition — predict → stage → monitor →
auto-rollback — has no entry point. Every rollout in the production database was
created by a script or a test. The full lifecycle has still never run from the
interface a merchant would use.

---

<a id="d-09"></a>
### D-09 · NOT-BUILT · P0 — R33 application authentication (the PRD's own launch blocker)

`middleware.ts` implements a **shared-secret access gate**, not authentication —
it identifies nobody and scopes nothing, and says so itself. Routes that should
be session-scoped fall back to the statically-configured shop
([app/api/kill-switch/route.ts:26](app/api/kill-switch/route.ts#L26)):

```ts
try { return resolveShopFromRequest(request).shopDomain; }
catch { return staticShopDomain(); }
```

Anyone holding the one shared secret can drive the kill switch, the journal
export and the sync for the configured store. There is no per-merchant isolation,
so this cannot support even two pilots.

---

## 5. P1 findings

<a id="d-10"></a>
### D-10 · DEFECT · P1 — An admin price edit after a variant goes live is silently overwritten

[lib/pricing/writer.ts:179](lib/pricing/writer.ts#L179) only tests for an external
change when `variant.applied_at === null`. Once applied, a merchant's manual price
change takes the ordinary repair path and `reconcileRollout` — called before
*every* evaluator decision — writes Priceflag's target back over it, with no
journal entry recording the overwrite.

**Reproduction:** `npx tsx tests/integration/run.ts` — fails on **both** adapters:
`external_changes=0, applied=1, merchant's 850 is now 1100`.

**Blast radius.** A merchant runs a flash sale in the Shopify admin during a
rollout; within the hour Priceflag reverts it, silently, and goes on measuring
against a price the merchant did not choose. PRD R4 and PRD risk #3 both name this
scenario as something the product detects and pauses on. The `products/update`
webhook handler *does* handle it correctly — but see [D-11](#d-11).

---

<a id="d-11"></a>
### D-11 · NOT-BUILT · P1 — No webhook subscription is ever registered

The sink is built, HMAC-verified, deduplicated and correct. Nothing subscribes:

```bash
grep -rn "webhookSubscriptionCreate\|webhookSubscription" --include=*.ts . | grep -v node_modules
# (no output)
```

`webhook_events` in production holds **1 row**. Lane B lists it as an open item
at [docs/lane-status/lane-b.md:240](docs/lane-status/lane-b.md#L240); the
consequences are not drawn together anywhere.

| Topic | Requirement | Consequence |
|---|---|---|
| `products/update` | R4 | External-change detection never fires → [D-10](#d-10) becomes the *only* behaviour |
| `orders/create` | R2, R15 | Evaluator actuals depend entirely on batch sync; B4's own acceptance criterion is unmet |
| `app/uninstalled` | R1 | Uninstall never cleans up; the token is never cleared |
| GDPR topics | R23 | Never delivered |

---

<a id="d-12"></a>
### D-12 · DEFECT · P1 — One breach probability fires every guardrail, whatever metric it watches

`breach_probability` is a property of the *day* and Lane C derives it from
**units**. [lib/engine/guardrails.ts:116](lib/engine/guardrails.ts#L116) consults
it before it ever looks at `rule.metric`, so a units-derived probability also
satisfies a **revenue** rule with revenue exactly on expectation. It also returns
*before* the low-volume Poisson floor, so the floor does not protect a day
carrying a probability.

**Reproduction:** `npx tsx tests/integration/run.ts --demo` →
`✗ one breach probability fires EVERY rule, whatever metric each rule watches`.

**Blast radius.** An auto-rollback trigger. The merchant's stored guardrail
`sentence` — what they agreed to — stops describing what will happen. Compounds
with [D-02](#d-02) and [D-01](#d-01).

---

<a id="d-13"></a>
### D-13 · DEFECT · P1 — A partly-failed auto-rollback is marked terminal and announced as complete

[lib/evaluator/index.ts:337](lib/evaluator/index.ts#L337) sets
`status: 'rolled_back'` unconditionally after `rollbackRollout`, regardless of
`undo.failed` or `check.mismatched`, and emits *"Every price has been put back to
what it was."* to the event log and the merchant's inbox. `rolled_back` is
terminal (`isTerminal`), so `listActiveRollouts` excludes it and the stranded
price is **never retried**.

The `verified` flag and the mismatch list are recorded in the event's `data` blob,
where no merchant will see them, and nothing acts on them.

---

<a id="d-14"></a>
### D-14 · DEFECT · P1 — The rollback and kill-switch buttons are demo no-ops by default

[components/domain/rollback-button.tsx](components/domain/rollback-button.tsx) and
[components/domain/kill-switch.tsx](components/domain/kill-switch.tsx) both take
`demoMode = true` as a **default parameter**, and the pages render them without
passing it. On a connected store the merchant clicks "Put prices back", gets a
success toast, and no API is called.

**Blast radius.** Combined with [D-07](#d-07) this is currently masked — there is
no real data to undo. It becomes a P0 the moment the UI is wired to a real store,
because the failure is invisible: the confirmation says it worked.

---

<a id="d-15"></a>
### D-15 · DEFECT · P1 — The propose screen is broken in real mode

[app/propose/actions.ts:63](app/propose/actions.ts#L63) calls
`getAdapter().getLatestFits(store.shop.id, …)` where `store` is `getDemoStore()`
and `SHOP_ID` is the literal string `"demo-shop"`
([components/demo/store.ts:34](components/demo/store.ts#L34)). Against Supabase
that is a string compared to a `uuid` column. The throw is caught by the
surrounding `try` and returned to the merchant as
`{ ok: false, code: "forecast_failed" }`.

This is the one place the UI *does* reach the real adapter, and it is the one
place it cannot work.

---

<a id="d-16"></a>
### D-16 · DEFECT · P1 — Expected bands are summed across model version, band kind and rollout

[lib/evaluator/index.ts:108-131](lib/evaluator/index.ts#L108) fetches
`getExpectedBands(shop, {variantGids, fromDay: day, toDay: day, rolloutId: undefined})`
and passes **every** returned row to `combineBands`, which adds `expected_units`.
Nothing deduplicates by `(variant, day)`. Two rows for the same variant-day — a
baseline band and a C5 counterfactual band, or two model versions during a
rollover — double or triple the expectation.

`rolloutId: undefined` also means a previous rollout's counterfactual band can be
used to judge a new rollout on the same SKUs.

**Blast radius.** An inflated expectation is a manufactured shortfall: a routine
nightly model upgrade could auto-roll back every healthy rollout at once. Not
reproduced live (production has one band kind), hence P1 not P0 — but it is one
`ml/nightly.py` change away from firing.

---

<a id="d-17"></a>
### D-17 · NOT-BUILT · P1 — R20/R30 post-rollout reports and calibration are never stored

`rollout_reports` exists
([supabase/migrations/20260729090500_ml.sql:151](supabase/migrations/20260729090500_ml.sql#L151)),
is granted to the ML role, and holds **0 rows**. `POST /api/ml/ingest` accepts
only `model_run`, `fits` and `bands`
([app/api/ml/ingest/route.ts:40](app/api/ml/ingest/route.ts#L40)). Lane C computes
reports and `calibration_summary` in `ml/priceflag_ml/reports.py`, with no
transport into the database. The report page renders `buildDemoReport()`.

**Blast radius.** R30 is the PRD's declared moat — "measuring it at all is the
moat" — and it is measured on nothing real.

---

<a id="d-18"></a>
### D-18 · RISK · P1 — The evaluator cron is live and armed against production

The brief expected this to be absent. It is not.
`.github/workflows/evaluator.yml` is on `main`, hourly, targeting
`https://priceflag-app.vercel.app/api/cron/evaluate` with a real `CRON_SECRET`.

```bash
gh run list --workflow=evaluator.yml --limit 5
gh run view 30582485244 --log | grep 'HTTP\|evaluated'
# HTTP 200
# {"evaluated":0,"skipped_locked":0,"advanced":0,...,"errors":[]}
```

It reaches the app and returns 200. It does nothing today only because production
has no active rollouts — a consequence of [D-08](#d-08), not a control.

**Blast radius.** The moment a rollout exists in production, an hourly job will
advance stages and auto-roll back using a live `write_products` token — with the
false-alarm rate of [D-01](#d-01)/[D-02](#d-02), no authentication
([D-09](#d-09)), no external-change safety net ([D-10](#d-10)/[D-11](#d-11)), and
an undo that under-reverts ([D-04](#d-04)/[D-05](#d-05)). The automation was
switched on before the safety net.

---

## 6. P2 / P3 findings

<a id="d-19"></a>
**D-19 · DEFECT · P2 — `TRUNCATE` defeats the append-only journal.** `UPDATE`,
`DELETE` and `ON CONFLICT DO UPDATE` are correctly rejected; `TRUNCATE` is not,
because the guard is a row-level trigger and row triggers do not fire on
`TRUNCATE`. Reproduced via `tests/integration/run.ts` (every statement inside a
transaction that is always rolled back). Also recorded: a direct-Postgres table
owner can `ALTER TABLE … DISABLE TRIGGER` and then update — inherent to
ownership, but it means "the journal is immutable" is true of the application and
the Supabase client, not of anyone holding `SUPABASE_DB_URL`. The journal is the
price audit trail Shopify does not have and the recovery path the runbook depends
on. **Fix:** a statement-level `AFTER TRUNCATE` trigger, and revoke `TRUNCATE`
from the service role.

<a id="d-20"></a>
**D-20 · RISK · P2 — Test suites write into the production Supabase project.**
`scripts/smoke.ts` and Lane D's suite both run against the project the production
deployment uses. Lane D's run created 88 rollouts on `lane-d-test.myshopify.com`,
all `running` — and `evaluateAll` iterates `listActiveRollouts()` across **every**
shop, so they would have become 88 errors per hour in a live cron job. They could
not have written prices (`credentialsFromShop` throws `shop_not_connected` for a
tokenless shop), but the isolation is accidental. Lane D's suite now cancels its
own active rollouts; verified 0 remain. The structural problem — no separate test
project, and an evaluator with no shop allow-list — remains.

<a id="d-21"></a>
**D-21 · RISK · P2 — Revenue and profit expectations use an unweighted mean
price.** [lib/evaluator/index.ts:241](lib/evaluator/index.ts#L241) converts a
units band to revenue/profit via the mean `target_price_cents` across live
variants, while actuals are true summed net revenue. On a selection mixing a $9
staple with a $99 item these are not comparable, and an ordinary mix shift reads
as a shortfall. The same mean is applied retrospectively to historical readings
when rebuilding the streak ([:264](lib/evaluator/index.ts#L264)), re-scoring
earlier days at today's prices.

<a id="d-22"></a>
**D-22 · DOC-DRIFT · P2 — `contracts/api.md` documents routes that do not
exist**, including the whole `/api/rollouts` and `/api/forecast` surface, and
omits `/api/ml/ingest` which does exist. Lane A was told to mock endpoints that
had landed and to expect endpoints that never did.

<a id="d-23"></a>
**D-23 · DOC-DRIFT · P2 — Lane status files claim production serves the real
synced store.** Contradicted by [D-07](#d-07). `PILOT_RUNBOOK.md` also calls
routes that do not exist for rollout triage and per-rollout rollback, and its
"fastest possible undo" curl omits the access-gate credential the same document
declares mandatory — so the emergency runbook does not work as written.

<a id="d-24"></a>
**D-24 · DOC-DRIFT · P3 — `CLAUDE.md` points at `lib/rng.ts`, which does not
exist.** The seeded RNG is `mulberry32` at
[lib/demo/generator.ts:32](lib/demo/generator.ts#L32). The property holds; the
pointer is wrong, in the file every agent reads first.

<a id="d-25"></a>
**D-25 · RISK · P3 — `/api/health` is public and unauthenticated**, returning
`mode`, adapter reachability, contract and Shopify API versions, and which
secrets are configured. No secret values; everything else is correctly gated.

<a id="d-26"></a>
**D-26 · DOC-DRIFT · P3 — The brief's own premises are stale.** B4–B7 and A5–A7
*did* run (`git log` shows Lane A through A7, Lane B through B7); the evaluator
cron is *not* absent ([D-18](#d-18)); and the PRD has **R1–R33**, not R1–R32.

---

## 7. Requirements traceability — R1 to R33

**IMPLEMENTED** (built and verified) · **PARTIAL** (engine exists, no merchant
path, or one leg missing) · **NOT-BUILT**.

| Req | Lane | Status | Evidence | Findings |
|---|---|---|---|---|
| **R1** OAuth install, encrypted token, uninstall cleanup | B | PARTIAL | `lib/shopify/oauth.ts`, AES-256-GCM (smoke ✓). Production uses the **static-token** path; `access_token_enc` null on every shop. Uninstall webhook never registered. | D-11 |
| **R2** Initial sync, ≥180 days history | B | IMPLEMENTED | 26 products + 5 266 `order_days` rows (2026-01-31 → 07-30). | — |
| **R3** COGS import/edit, never a fabricated profit | A | PARTIAL | `setCogs` verified both adapters; forecast returns `profit_delta_cents: null` + `missing_cogs`. UI demo-only; all 26 real variants have null COGS. | D-07 |
| **R4** Webhooks; external edits journaled + pause | B | **NOT-BUILT** | Handler correct; **no subscription ever created**. Post-apply edits silently overwritten. | D-10, D-11 |
| **R5** Propose % or absolute across many SKUs | A | PARTIAL | Works on demo data; `computeTargetPrice` verified. | D-07, D-08, D-15 |
| **R6** Forecast card, breakeven first | A | PARTIAL | `buildForecast` validated against its schema (smoke ✓). Demo-only. | D-07 |
| **R7** Fitted elasticity with honest tiers | C | IMPLEMENTED | 106 pytest ✓; `elasticity_fits` populated with real tiers. | — |
| **R8** "Show your work" | A | PARTIAL | `buildScenarios` verified; demo-only. | D-07 |
| **R9** (COULD) Portfolio view | A | NOT-BUILT | No such surface. | — |
| **R10** Guardrails as an editable sentence, stored immutably | A,B | PARTIAL | Schema + builder + stored on the rollout. Cannot be exercised. | D-08 |
| **R11** Staged by cohort; 1 SKU → time canary | B | IMPLEMENTED | `normalizeStages` collapses to `CANARY_STAGE_PLAN`; cohorts deterministic and order-independent. | D-01 |
| **R12** Idempotent, journaled writes; captured baselines | B | IMPLEMENTED | Fuzz + crash-window ✓. Compare-before-write; `applied_at` only after Shopify confirms. | — |
| **R13** Compare-at policy | B | IMPLEMENTED | Verified both directions incl. null/zero; restoration verified in fuzz. | — |
| **R14** (SHOULD) Scheduled start | B | IMPLEMENTED | `isDueToStart` + start path. Never exercised. | D-08 |
| **R15** Daily evaluation, idempotent, locked | B | IMPLEMENTED | Lease excludes on both adapters ✓; `(rollout, day)` reading; catch-up capped at 14 days. | D-16, D-18, D-21 |
| **R16** Rollout page answers "what's live / how do I undo" | A | PARTIAL | Screens exist and are thorough — demo data only, and the undo buttons are no-ops. | D-07, D-14 |
| **R17** Auto-rollback restores every price + notifies | B | **DEFECT** | `rollbackRollout` + `verifyRollback` correct in the happy path; both miss lost-ack variants, and a partial failure is announced as complete. | D-05, D-13 |
| **R18** Journal, filterable, CSV export | A,B | IMPLEMENTED | `GET /api/journal?format=csv`; escapes commas, quotes, formula prefixes (smoke ✓). | D-19 |
| **R19** Email notifications; (SHOULD) Slack | B | PARTIAL | Resend wired for six kinds, best-effort. Slack not built. No email sent by a real evaluation. | D-13 |
| **R20** Post-rollout report | A,C | **NOT-BUILT** | `rollout_reports` = 0 rows; no ingest path; page renders `buildDemoReport()`. | D-17 |
| **R21** Store-level kill switch | B | **DEFECT** | Route exists, checked at the credential boundary; chained rollouts unwind wrong; UI button is a no-op. | D-04, D-14 |
| **R22** Never modify outside selection; exclude subs/gift cards | B | IMPLEMENTED | Proved against the writer's call log across advance, rollback, kill switch. | — |
| **R23** Webhook HMAC, GDPR, encryption, aggregates only | B | PARTIAL | HMAC correct (smoke ✓); `order_days` holds no PII. GDPR topics never delivered. | D-11 |
| **R24** Onboarding + sync progress | A | PARTIAL | Built (A5, `a1965ed`) against the schema; demo-only. | D-07 |
| **R25** Plain language everywhere | A | IMPLEMENTED | Engine strings are merchant-language throughout. | — |
| **R26** Every screen designed for its worst state | A | PARTIAL | States exist in components; unreachable for real data. | D-07 |
| **R27** WCAG AA, keyboard, responsive | A | PARTIAL | A7 ran (`2b89d10`, `b1445d9`). Not independently re-measured — see §9. | — |
| **R28** Model honesty gate | C | IMPLEMENTED | **Production `model_runs`: 3 succeeded, 4 rejected, 3 failed.** Enforced at ingest; a rejected run stores no fits or bands. | — |
| **R29** Fitted bands; calibration as a safety property | C | **DEFECT** | Bands populated (133 rows); staleness demotion verified. But the band is a no-change counterfactual used as a with-change expectation, and its calibration has never been measured against real outcomes. | D-01, D-02, D-03, D-12, D-16 |
| **R30** Calibration tracking from day one | C | **NOT-BUILT** | Computed in `reports.py`, stored nowhere. | D-17 |
| **R31** Versioned, traceable model outputs | C | IMPLEMENTED | `model_runs` (10 rows); fits and bands carry `model_run_id`. | — |
| **R32** Never serve stale model output as fresh | B,C | IMPLEMENTED | `effectiveFitConfidence` demotes past `MAX_FIT_AGE_DAYS` with a warning; evaluator falls back to bracket bands and sets `band_stale`. | — |
| **R33** Application authentication | B | **NOT-BUILT** | Shared-secret gate only; routes fall back to `staticShopDomain()`. | D-09 |

**Totals:** IMPLEMENTED 13 · PARTIAL 13 · NOT-BUILT 5 · DEFECT-blocked 3.

---

## 8. The three I would fix first

1. **Turn auto-rollback off by default ([D-01](#d-01), [D-02](#d-02),
   [D-03](#d-03)).** One line — `defaultGuardrails().auto_rollback = false` — and
   the code already downgrades a rollback to a pause. As it stands the safety
   system reverts 40% of healthy single-SKU rollouts and 68.5% of *correctly
   forecast* price rises, and goes blind on day 28. Alert-only keeps every
   benefit (the merchant is told, immediately, with the numbers) and removes the
   one behaviour that can lose a merchant money without a human in the loop.
   Then fix the band semantics properly: compare against expected-given-the-change.

2. **Make undo actually undo ([D-04](#d-04), [D-05](#d-05), [D-13](#d-13)).**
   These are three bugs in the one feature a frightened merchant reaches for, and
   all three fail *confidently* — success toast, success email, `verified: true`.
   Each has a failing test and a small fix: restore from the earliest journaled
   price; select rollback candidates by live-price mismatch rather than
   `applied_at`; and do not mark a rollout terminal when the revert did not fully
   land.

3. **Floor the target price ([D-06](#d-06)) and disarm the cron ([D-18](#d-18)).**
   Both are minutes of work. A `-100%` change currently gives the catalogue away
   for free, and the hourly writer is live ahead of authentication. Disable the
   `schedule:` trigger (keep `workflow_dispatch`) until R33 lands.

[D-07](#d-07) and [D-08](#d-08) are larger than any of these, but they are
*build* work for Lanes A and B rather than fixes, and they are already the
obvious next sprints.

---

## 9. What I could not test, and what I would need

| Not tested | Why | What would unblock it |
|---|---|---|
| A real price write to a real storefront | Deliberately never issued a mutating call against the live store; the whole writer surface ran through a stubbed transport. | A throwaway dev store with its own token, plus a `PRICEFLAG_SHOP_ALLOWLIST` so the evaluator cannot touch anything else. |
| The full lifecycle on real telemetry | `priceflag-test` has 26 products and **zero orders**; guardrails cannot fire without demand. | Scripted orders. Note `scripts/simulate-store.ts` is referenced in BUILD_BRIEF §7 but does not exist — only `simulate-rollout.ts` does. |
| Install / uninstall / reinstall (B2) | Production uses the static-token path; no OAuth install has ever run. | A Partner-Dashboard app with custom distribution and a store to install onto. |
| Credential failure mid-run (`sb_secret_` rejected, Supabase unreachable mid-write) | Would require revoking live credentials on the shared project. | A separate Supabase project for QA — which [D-20](#d-20) argues for anyway. |
| Real-browser UI states, keyboard nav, measured contrast | The screens only render demo data, so the states that matter for a pilot — real empty catalogue, real syncing, real zero-COGS — are unreachable. | [D-07](#d-07) fixed first; the audit is not meaningful before then. |
| Whether Lane C's recorded incumbent scores are still valid | The negative-binomial change altered golden series for a fixed seed. | Regenerate golden data at the recorded seeds and diff `ml/eval/*.json`. |
| ~15 lower-severity findings from the parallel code audit | The adversarial verification pass was interrupted before it finished, so I did not independently confirm them and have not included them above. | They are worth a triage pass; the areas were money-layer edge cases, contract conformance, ML gate details, and UI copy. |

---

## 10. Bottom line

The **engine** is good, and I want to be precise about that because it is the
part everyone worried about. Rollback arithmetic, cent-exactness, R22
containment, idempotency, the forward crash window and the evaluator lease all
held under adversarial fuzzing on both adapters. The model gate genuinely rejects
worse models and records the rejection. Ground truth genuinely never reaches a
forecast. The care in `lib/pricing/writer.ts` is real and it is why the price
*arithmetic* findings are as few as they are.

What is not sound is the layer above it. The safety system — the thing that
justifies letting software change prices unattended — is calibrated such that it
fires on healthy stores and punishes correct forecasts, and it stops working
entirely after 28 days without saying so. The undo path has three separate
confident-failure modes. And there is no product around any of it: no way to see
your store, no way to start a rollout, no authentication.

Pointing this at a real merchant today would mean a merchant who cannot see their
catalogue, cannot start a rollout, shares one password with everyone who has the
link, has their manual price edits reverted within the hour, whose emergency undo
can leave them on a price they never chose, and whose successful, correctly
forecast price rise gets automatically reverted two times in three.

The distance to pilot-ready is real but not enormous, and it is almost entirely
in the guardrail semantics, the undo path, and Lane A/B wiring — not in the
pricing engine and not in the ML.
