# Priceflag — Lane D QA Report

**Date:** 2026-07-30 · **Author:** Lane D (Integration & Adversarial QA) · **Commit under test:** `461a370`

Every claim below is reproducible from a clean checkout. Where a finding is
proved by a test, the test is committed in `tests/integration/` and is currently
**failing on purpose** — a test that fails because the product is wrong is a
finding, not a test to adjust.

```bash
npm install && npm run typecheck && npm run build
npx tsx scripts/smoke.ts
cd ml && uv sync --frozen && uv run pytest -q && cd ..
npx tsx tests/integration/run.ts          # Lane D
```

---

## 1. Headline

**No, this app cannot be pointed at a real merchant's store today.**

Not because the engine is unsound — it is the most carefully built part and it
survived everything I threw at it. Because **there is no merchant-facing path to
a real store at all**, and the automation that writes prices is already armed.

The three things that matter most:

1. Every screen a merchant sees renders the **simulated demo store**, in
   production, where `/api/health` reports `"mode": "real"` ([D-07](#d-07)).
2. A merchant **cannot create a rollout**. The create action returns
   `rollout_id: null` and there is no `POST /api/rollouts` route ([D-08](#d-08)).
   The core loop — the product — cannot be started from the UI.
3. The evaluator cron is **live, hourly, and reaching production** ([D-02](#d-02)),
   against a deployment holding a `write_products` Admin token, with no
   application authentication ([D-10](#d-10)) and no webhook safety net
   ([D-05](#d-05)).

Nothing catastrophic can happen *right now* only because (2) means production
has no rollouts for (3) to act on. That is a coincidence of incompleteness, not
a safety property.

## 2. Counts

| Classification | P0 | P1 | P2 | P3 | Total |
|---|---:|---:|---:|---:|---:|
| **DEFECT** | 1 | 3 | 2 | 0 | **6** |
| **NOT-BUILT** | 3 | 3 | 1 | 0 | **7** |
| **RISK** | 0 | 2 | 3 | 1 | **6** |
| **DOC-DRIFT** | 0 | 1 | 2 | 2 | **5** |
| **Total** | **4** | **9** | **8** | **3** | **24** |

## 3. What I verified as CORRECT

Recording this matters as much as the findings: these were attacked and held.

| Property | Evidence |
|---|---|
| **Rollback completeness** | 40 fuzzed rollouts × 1–25 SKUs × prices and percentages that round badly (1, 999, 1667 @ 0.5%, 7%, 33%, 1/3), rollback at every stage, mid-stage interrupts, double rollback, rollback of a completed rollout, rollback after a partial stage. Every variant restored **to the cent**, compare-at included. Journal replay independently agrees. |
| **Cent-exactness** | 40 000 randomised round trips through Shopify decimal strings are byte-identical. Rollback reads the *captured* baseline, never an inverse percentage — the property that makes 7%-of-1667 safe. No float money anywhere in the pricing path. |
| **R22 — no write outside selection** | Proven against the writer's actual call log, not its plan. Bystander variants present in the store but absent from the rollout are never written, across stage advance, rollback and kill switch. Gift cards, subscription products and non-`ACTIVE` products excluded at *write* time and recorded with a reason. |
| **No per-visitor pricing** | Holds by construction. `assignCohorts(rolloutId, variantGids, stages)` takes no request, no user, no clock; stable across calls and input order. The pricing surface contains no visitor/session/cookie/UA/IP/traffic identifier. |
| **Idempotency & the crash window** | Re-applying a stage writes and journals nothing extra. The dangerous case — Shopify applied it, the process died before the DB recorded it — converges on the next reconcile without double-writing or double-journalling. `applied_at` is only ever stamped after Shopify confirms, so the DB can lag reality but never leads it. |
| **Evaluator mutual exclusion** | Two evaluators racing one rollout: exactly one runs, the other reports `locked`. Holds on both adapters; the Supabase lease is enforced by Postgres. |
| **Journal immutability (partial)** | `UPDATE`, `DELETE` and `ON CONFLICT DO UPDATE` are all rejected by the database itself, not by convention. (`TRUNCATE` is not — [D-03](#d-03).) |
| **R28 — the model gate genuinely rejects** | `model_runs` in production holds **3 succeeded, 4 rejected, 3 failed**. A worse-than-incumbent model is refused at the ingest boundary and recorded rather than deployed. This is real, not aspirational. |
| **No ground-truth leak** | `hiddenElasticity` / `truth[]` never reach a forecast, an API response, or the client. `scripts/seed-demo-fits.ts` hands Lane C's real fitter the **observable columns only** and uses `truth[]` solely for a printed human comparison. Some demo SKUs honestly come back `assumption`. |

---

## 4. Findings

### P0

<a id="d-07"></a>
#### D-07 · NOT-BUILT · P0 — The entire merchant-facing UI renders the simulated demo store

Every page under `app/` (except `app/api/**`) imports its data from
`@/components/demo/store` and `@/components/demo/rollouts`. The **only**
`getAdapter()` call outside `app/api/` is [app/propose/actions.ts:63](app/propose/actions.ts#L63),
which fetches elasticity fits. `getDemoStore()` has no mode check —
`lib/config.ts` exposes `isDemoMode()` and nothing in `app/` or `components/`
calls it.

Affected: dashboard ([app/page.tsx:51](app/page.tsx#L51)), catalog
([app/products/page.tsx:24](app/products/page.tsx#L24)), rollouts list and detail
([app/rollouts/page.tsx:135](app/rollouts/page.tsx#L135),
[app/rollouts/[id]/page.tsx:79](app/rollouts/[id]/page.tsx#L79)), journal
([app/journal/page.tsx:5](app/journal/page.tsx#L5)), settings, and the
"what is live right now" card
([components/shell/live-status.tsx:55](components/shell/live-status.tsx#L55)).

**Reproduction** — against the live production deployment:

```bash
curl -s https://priceflag-app.vercel.app/api/health | python3 -m json.tool
# {"ok": true, "mode": "real", "adapter": {"kind": "supabase", "ok": true, ...}}

SEC=$(grep '^APP_ACCESS_SECRET=' .env.local | cut -d= -f2-)
curl -sL -c /tmp/j -b /tmp/j "https://priceflag-app.vercel.app/?access=$SEC" \
  | grep -oE 'ro_20[0-9]+|Everyday Tee|Demo data' | sort -u
# Demo data / Everyday Tee / ro_2039 / ro_2041 / ro_2042 / ro_2043
```

Production reports `mode: "real"` with Supabase reachable and a real Shopify
token configured, and serves the fictional catalogue. The 26 genuinely synced
products of `priceflag-test.myshopify.com` are invisible on every screen.

**Blast radius.** A pilot merchant onboarded today sees a fictional store. They
cannot see their own catalogue, their own prices, or their own rollouts. This is
the single largest gap between what exists and what a merchant can use.

**Why NOT-BUILT and not DEFECT:** the UI carries a permanent `Demo data` badge
(`DemoShop.mode` is the literal `"demo"`), so it does not *claim* to be real
data. It is a missing wiring sprint, not a lie. It is still P0 because it blocks
the pilot entirely.

---

<a id="d-08"></a>
#### D-08 · NOT-BUILT · P0 — A merchant cannot create a rollout

[app/propose/actions.ts:106](app/propose/actions.ts#L106) `createRollout()`
validates the request and then returns:

```ts
return { ok: true, rollout_id: null, message: "This is the demo store, so no prices were changed…" };
```

There is no `POST /api/rollouts` route — `app/api/` contains `auth`, `cron`,
`health`, `journal`, `kill-switch`, `ml/ingest`, `sync`, `sync/status`,
`webhooks` and nothing else. `contracts/api.md` documents `POST /api/rollouts`
and `POST /api/forecast`; neither exists.

**Reproduction:** `ls app/api` and `grep -rn "rollout_id: null" app/propose/actions.ts`.

**Blast radius.** The product's entire proposition — predict → stage → monitor →
auto-rollback — has no entry point. Every rollout in the production database was
created by a script or a test, never by the UI. The full lifecycle has therefore
still never run end to end against a real store from the interface a merchant
would use.

---

<a id="d-10"></a>
#### D-10 · NOT-BUILT · P0 — R33 application authentication (the PRD's own launch blocker)

`middleware.ts` implements a **shared-secret access gate**, not authentication.
It identifies nobody and scopes nothing; the file says so itself. Routes that
should be session-scoped fall back to the statically-configured shop —
[app/api/kill-switch/route.ts:26-32](app/api/kill-switch/route.ts#L26):

```ts
try { return resolveShopFromRequest(request).shopDomain; }
catch { return staticShopDomain(); }
```

So any caller who holds the one shared secret can drive the kill switch, the
journal export and the sync for the statically-configured store. The PRD names
this a pilot launch blocker in R33, and Lane B flagged it in commit `844322e`.

**Blast radius.** One leaked link or rotated-but-not-revoked secret equals full
control of a real store's prices. There is no per-merchant isolation, so this
cannot support more than one pilot at all.

---

<a id="d-01"></a>
#### D-01 · DEFECT · P0 — The kill switch does not unwind chained rollouts to the pre-Priceflag price (R21)

R21 promises "revert everything Priceflag ever changed, one action". The
implementation in [app/api/kill-switch/route.ts:63](app/api/kill-switch/route.ts#L63)
instead unwinds *each rollout to its own captured baseline*, in whatever order
`listRollouts` returns:

```ts
for (const rollout of await adapter.listRollouts(shop.id)) {
  const undo = await rollbackRollout(context, rollout, { source: 'kill_switch', … });
```

Those two things coincide only if rollouts are unwound strictly newest-first.
`listRollouts` sorts on `created_at` with **no tie-breaker**
([lib/adapters/demo.ts:526](lib/adapters/demo.ts#L526),
[lib/adapters/supabase.ts:302](lib/adapters/supabase.ts#L302)), so two rollouts
created inside the same clock tick compare equal, `Array.prototype.sort` is
stable, and insertion order — **oldest first** — wins.

Chained rollouts are the normal case for a returning merchant: it is exactly the
retention loop the PRD is built around (R20).

**Reproduction:**

```bash
npx tsx tests/integration/run.ts --demo
```

> `✗ the kill switch unwinds CHAINED rollouts back to the original price`
> `R21 broken in 10/12 attempts — the kill switch left the merchant on a price Priceflag invented instead of the pre-Priceflag 1000.`

Scenario: price 1000 → rollout A (+10%) → 1100, completed → rollout B (+10%) →
1210. Kill switch. Correct answer 1000; actual answer **1100**.

**Blast radius.** A merchant hits the emergency undo and is left selling at a
price Priceflag invented, with the UI reporting success (`ok: true`, "Every price
Priceflag changed is back to what it was"). It is worse than a silent failure
because it is a *confident* one. On `SupabaseAdapter` the ordering usually holds
because Postgres timestamps are microsecond-resolution — so in production this is
latent rather than constant, which is precisely why it would be found by a
merchant and not by a test.

**Correct fix (Lane B):** restore each variant to the **earliest** journaled
`before_price_cents`, which is the true pre-Priceflag price and is exactly what
`PILOT_RUNBOOK.md`'s manual recovery SQL already does. Failing that, add an
explicit `created_at DESC, id DESC` tie-breaker *and* a comment saying the order
is load-bearing.

---

### P1

<a id="d-04"></a>
#### D-04 · DEFECT · P1 — An admin price edit after a variant goes live is silently overwritten

[lib/pricing/writer.ts:179](lib/pricing/writer.ts#L179) only tests for an
external change when the variant has not been applied yet:

```ts
if (variant.applied_at === null && current.priceCents !== variant.baseline_price_cents) {
  result.external_changes.push(…);   // R4: pause, do not overwrite
  continue;
}
```

Once `applied_at` is set, a merchant's manual price change falls through to the
ordinary repair path and `reconcileRollout` — which the evaluator calls before
*every* decision — writes Priceflag's target back over it.

**Reproduction:** `npx tsx tests/integration/run.ts` — fails on **both** adapters:

> `✗ an admin edit AFTER the variant went live is silently overwritten by the next reconcile`
> `external_changes=0, applied=1, merchant's 850 is now 1100`

**Blast radius.** A merchant runs a flash sale in the Shopify admin during a
rollout. Within the hour the evaluator reverts it. The promo dies silently, the
merchant is not told, and the rollout goes on measuring against a price the
merchant did not choose. PRD R4 and PRD risk #3 both name this exact scenario as
something the product detects and pauses on.

The `products/update` webhook handler
([app/api/webhooks/[topic]/route.ts:217](app/api/webhooks/%5Btopic%5D/route.ts#L217))
*does* handle this case correctly and would pause the rollout first — but see
[D-05](#d-05): that webhook is never registered, so the defence does not exist.

---

<a id="d-05"></a>
#### D-05 · NOT-BUILT · P1 — No webhook subscription is ever registered

The webhook *sink* is built, HMAC-verified, deduplicated and correct. Nothing
ever subscribes Shopify to send it anything:

```bash
grep -rn "webhookSubscriptionCreate\|webhookSubscription" --include=*.ts . | grep -v node_modules
# (no output)
```

`webhook_events` in production holds **1 row**. Lane B lists "Webhook
registration on install" as an open item at
[docs/lane-status/lane-b.md:240](docs/lane-status/lane-b.md#L240) — the gap is
known; its consequences are not drawn together anywhere.

**Blast radius**, one dead promise per topic:

| Topic | Requirement | Consequence |
|---|---|---|
| `products/update` | R4 | External-change detection never fires → [D-04](#d-04) becomes the *only* behaviour |
| `orders/create` | R2, R15 | The evaluator's "what actually sold" depends entirely on batch sync. B4's own acceptance criterion — "test order lands in `order_days` within a minute" — is unmet |
| `app/uninstalled` | R1 | Uninstall never cleans up; the token is never cleared |
| GDPR topics | R23 | Never delivered. A Shopify app listing requires these to work |

---

<a id="d-06"></a>
#### D-06 · DEFECT · P1 — One breach probability fires every guardrail, whatever metric it watches

`breach_probability` is a property of the *day*, and Lane C's C5 monitor derives
it from **units**. [lib/engine/guardrails.ts:116-127](lib/engine/guardrails.ts#L116)
consults it before it ever looks at `rule.metric`:

```ts
const probability = observation.breach_probability;
if (probability !== null && probability !== undefined) {
  const holds = probability >= BREACH_PROBABILITY_THRESHOLD;
  return { holds, floored: false, known: true, … };
}
```

So a units-derived probability also satisfies a **revenue** rule — even when
revenue is exactly on expectation.

**Reproduction:** `npx tsx tests/integration/run.ts --demo`

> `✗ one breach probability fires EVERY rule, whatever metric each rule watches`
> `a units-derived breach probability must not fire a REVENUE rule: the merchant set a limit on revenue, and revenue is exactly on expectation here`

**Blast radius.** This is an auto-rollback trigger. A merchant who deliberately
chose "revert if **revenue** falls 30% below expected" — a reasonable choice when
unit mix is noisy but revenue is stable — gets a rollback driven by a model
watching something else. It also means the rule's stored `sentence`, which is
what the merchant agreed to, no longer describes what will happen.

Related, and worth a decision rather than a fix: the probability branch also
returns **before** the low-volume Poisson floor is consulted, so the floor does
not protect a day carrying a breach probability. Pinned by a passing test so the
precedence is at least explicit.

---

<a id="d-09"></a>
#### D-09 · NOT-BUILT · P1 — R20/R30 post-rollout reports and calibration are never stored

`rollout_reports` exists as a table
([supabase/migrations/20260729090500_ml.sql:151](supabase/migrations/20260729090500_ml.sql#L151)),
is granted to the ML read-only role, and holds **0 rows**. Nothing writes it:
`POST /api/ml/ingest` accepts only `model_run`, `fits` and `bands`
([app/api/ml/ingest/route.ts:40-50](app/api/ml/ingest/route.ts#L40)). Lane C
computes reports and `calibration_summary` in
[ml/priceflag_ml/reports.py:275](ml/priceflag_ml/reports.py#L275), but there is
no path from there into the database. The report page renders
`buildDemoReport()` from `components/demo/report.ts`.

**Blast radius.** R30 is the PRD's declared moat — "measuring it at all is the
moat" — and the number is not being measured on anything real. The retention
loop (R20) has no data source outside demo mode.

---

<a id="d-02"></a>
#### D-02 · RISK · P1 — The evaluator cron is live and armed against production

The brief expected this to be absent. It is not.
`.github/workflows/evaluator.yml` is on `main`, `schedule: cron '0 * * * *'`,
targeting `https://priceflag-app.vercel.app/api/cron/evaluate` with a real
`CRON_SECRET`.

```bash
gh run list --workflow=evaluator.yml --limit 5
# completed  success  evaluator  main  workflow_dispatch  30582485244  19s
# completed  failure  evaluator  main  schedule           30578684061  16s
gh run view 30582485244 --log | grep 'HTTP\|evaluated'
# HTTP 200
# {"evaluated":0,"skipped_locked":0,"advanced":0,...,"errors":[]}
```

It reaches the app and returns 200. It does nothing today only because
production holds no active rollouts — a consequence of [D-08](#d-08), not a
safety control. The most recent *scheduled* run failed on a since-relaxed
`VERCEL_AUTOMATION_BYPASS_SECRET` check; manual dispatches now succeed, so the
next scheduled tick should too.

**Blast radius.** The moment a rollout exists in production, an hourly job will
advance stages and can auto-rollback, using a live `write_products` token,
with no application authentication ([D-10](#d-10)), no external-change safety net
([D-05](#d-05), [D-04](#d-04)), and a kill switch that mis-unwinds chained
rollouts ([D-01](#d-01)). The automation is ready before the safety net is.

---

### P2

<a id="d-03"></a>
#### D-03 · DEFECT · P2 — `TRUNCATE` defeats the append-only journal

`UPDATE`, `DELETE` and `ON CONFLICT DO UPDATE` are all correctly rejected by the
database. `TRUNCATE` is not: the guard is a row-level trigger, and row triggers
do not fire on `TRUNCATE` unless declared `AFTER TRUNCATE`.

**Reproduction:** `npx tsx tests/integration/run.ts` (needs `SUPABASE_DB_URL`).
Every statement runs inside a transaction that is always rolled back, so the real
journal is never damaged.

> `✗ TRUNCATE is rejected — the journal accepted "TRUNCATE is rejected"; it is not append-only`

Recorded alongside it: a direct-Postgres table owner can also `ALTER TABLE …
DISABLE TRIGGER` and then update. That is inherent to table ownership and is not
a bug — but it means "the journal is immutable" is true of the *application* and
of the Supabase JS client, and not of anyone holding `SUPABASE_DB_URL`.

**Blast radius.** The journal is the price audit trail Shopify does not have —
a named competitive differentiator — and the recovery path `PILOT_RUNBOOK.md`
depends on. One statement erases it, and no other record of pre-rollout prices
survives independently.

**Fix (Lane B):** add `create trigger … after truncate on journal_entries execute
function <raise>` (statement-level), and revoke `TRUNCATE` from the service role.

---

<a id="d-11"></a>
#### D-11 · RISK · P2 — Test suites write into the production Supabase project

`scripts/smoke.ts` and Lane D's suite both run against the same Supabase project
the production deployment uses. Lane D's own run created **88 rollouts** on
`lane-d-test.myshopify.com`, all `running` — and `evaluateAll` iterates
`listActiveRollouts()` across **every shop**, so they would have become 88 errors
per hour in a live cron job.

They could not have written prices: `credentialsFromShop` throws
`shop_not_connected` for a shop with no stored token
([lib/shopify/credentials.ts:117](lib/shopify/credentials.ts#L117)), and
`evaluateAll` catches per-rollout. But the isolation is accidental — a test shop
that ever acquires a token would be evaluated for real.

Lane D's suite now cancels its own active rollouts (verified: 0 active rollouts
remain across all shops). The structural problem — no separate test project, and
an evaluator with no shop allow-list — remains.

---

<a id="d-12"></a>
#### D-12 · RISK · P2 — Expected revenue and profit are derived from a mean price across the selection

[lib/evaluator/index.ts:241-249](lib/evaluator/index.ts#L241):

```ts
const liveUnitPrice = variants.reduce((s, v) => s + v.target_price_cents, 0) / Math.max(1, variants.length);
const expectedRevenue = Math.round(expected.band.expected_units * liveUnitPrice);
```

A units band is converted to revenue and profit by an **unweighted mean price**
across every live variant. Actuals, by contrast, are true summed net revenue. On
a selection mixing a $9 staple with a $99 item, the two are not comparable, and
an ordinary shift in mix reads as a revenue shortfall. The same mean is then
applied retrospectively to *historical* readings when rebuilding the streak
([lib/evaluator/index.ts:264](lib/evaluator/index.ts#L264)), so earlier days are
re-scored at today's stage's prices.

**Blast radius.** Revenue and profit guardrails are miscalibrated on any
heterogeneous selection — which is most of them. Combined with [D-06](#d-06),
the non-units guardrails are the least trustworthy part of the safety system.
Not proven to fire falsely in practice, hence RISK rather than DEFECT.

---

### P3

<a id="d-13"></a>
#### D-13 · DOC-DRIFT · P3 — `CLAUDE.md` points at `lib/rng.ts`, which does not exist

> "Demo mode stays first-class: seeded, deterministic (`lib/rng.ts`)"

`ls lib/rng.ts` → no such file. The seeded RNG is `mulberry32` at
[lib/demo/generator.ts:32](lib/demo/generator.ts#L32). The *property* holds; the
pointer is wrong, and it is in the file every agent is told to read first.

<a id="d-14"></a>
#### D-14 · RISK · P3 — `/api/health` is public and unauthenticated

`GET https://priceflag-app.vercel.app/api/health` → 200 without any credential,
returning `mode`, adapter kind and reachability, contract version, Shopify API
version, and which secrets are configured. Everything else is correctly gated.
Low severity — no secret values — but it confirms a live, configured target to
anyone who finds the URL.

<a id="d-15"></a>
#### D-15 · DOC-DRIFT · P3 — The brief's own premises are stale

Recorded because they shaped this audit: B4–B7 and A5–A7 **did** run (`git log`
shows Lane A through A7 and Lane B through B7); the evaluator cron is **not**
absent ([D-02](#d-02)); and the PRD has **R1–R33**, not R1–R32 — R33 was appended
later and is the declared pilot blocker.

---

## 5. Requirements traceability — R1 to R33

Status: **IMPLEMENTED** (built and verified) · **PARTIAL** (engine exists, no
merchant path, or one leg missing) · **NOT-BUILT**.

| Req | Lane | Status | Evidence | Findings |
|---|---|---|---|---|
| **R1** OAuth install, scopes, encrypted token, uninstall cleanup | B | PARTIAL | `lib/shopify/oauth.ts`, `app/api/auth/*`, AES-256-GCM in `lib/crypto.ts` (smoke ✓). Production uses the **static-token** path; `access_token_enc` is null on every shop row. Uninstall webhook never registered. | D-05 |
| **R2** Initial sync, ≥180 days history, catalog usable early | B | IMPLEMENTED | 26 products + 5 266 `order_days` rows (2026-01-31 → 2026-07-30) for `priceflag-test`. `lib/sync/*`, `app/api/sync`. | — |
| **R3** COGS import + inline edit, never a fabricated profit | A | PARTIAL | `setCogs` verified on both adapters (smoke ✓); forecast returns `profit_delta_cents: null` and a `missing_cogs` warning. UI is demo-only. All 26 real variants have null COGS. | D-07 |
| **R4** Webhooks; external edits journaled + pause rollout | B | **NOT-BUILT** | Handler correct and HMAC-verified; **no subscription is ever created**. Post-apply edits are silently overwritten. | D-04, D-05 |
| **R5** Propose uniform % or absolute across many SKUs | A | PARTIAL | `components/propose/*` works against demo data; `computeTargetPrice` verified. No real-store path. | D-07, D-08 |
| **R6** Forecast card: breakeven sentence first, then ranges | A | PARTIAL | `buildForecast` verified against `forecast_result.schema.json` (smoke ✓). Demo-only rendering. | D-07 |
| **R7** Fitted per-product elasticity with honest tiers | C | IMPLEMENTED | `ml/priceflag_ml/elasticity.py`, 106 pytest ✓; `elasticity_fits` populated with real tiers (1 `fitted`, 6 `assumption`). | — |
| **R8** "Show your work" scenario table | A | PARTIAL | `buildScenarios` verified; demo-only rendering. | D-07 |
| **R9** (COULD) Portfolio view | A | NOT-BUILT | No aggregate-collection surface. | — |
| **R10** Guardrails as an editable sentence, stored immutably | A,B | PARTIAL | `guardrails.schema.json` + `components/propose/guardrail-builder.tsx`; stored on the rollout row. Cannot be exercised — no create path. | D-08 |
| **R11** Staged rollout by SKU cohort; 1 SKU → time canary | B | IMPLEMENTED | `normalizeStages` collapses a single variant to `CANARY_STAGE_PLAN`; cohorts verified deterministic and order-independent. | — |
| **R12** Idempotent, rate-limit-aware, journaled price writes; baselines are the rollback source of truth | B | IMPLEMENTED | Lane D fuzz + crash-window tests ✓. Compare-before-write, `applied_at` only after Shopify confirms. | — |
| **R13** Compare-at policy | B | IMPLEMENTED | `resolveCompareAt` verified in both directions incl. the null and zero cases; restoration verified in the rollback fuzz. | — |
| **R14** (SHOULD) Scheduled start | B | IMPLEMENTED | `isDueToStart` + `evaluateAll` start path. Never exercised in production. | D-08 |
| **R15** Daily evaluation, idempotent, per-rollout locked | B | IMPLEMENTED | Lease excludes on both adapters ✓; `(rollout, day)` reading is the idempotency record; catch-up capped at 14 days. | D-02, D-12 |
| **R16** Rollout page answers "what's live / how do I undo" | A | PARTIAL | Screens exist and are thorough — against demo data only. | D-07 |
| **R17** Auto-rollback restores every price within minutes + notify | B | IMPLEMENTED | `rollbackRollout` + `verifyRollback` (asks Shopify, not the journal) ✓; Resend email on `auto_rollback`. Never run against real telemetry. | D-01 |
| **R18** Price journal, filterable, CSV export | A,B | IMPLEMENTED | `GET /api/journal?format=csv`; CSV escapes commas, quotes and formula-injection prefixes (smoke ✓). | D-03 |
| **R19** Email notifications; (SHOULD) Slack | B | PARTIAL | Resend wired for all six kinds, best-effort by design. Slack not built. No email has been sent by a real evaluation. | — |
| **R20** Post-rollout report | A,C | **NOT-BUILT** | `rollout_reports` = 0 rows; no ingest path; report page renders `buildDemoReport()`. | D-09 |
| **R21** Store-level kill switch | B | **DEFECT** | Route exists and is checked at the credential boundary, but chained rollouts unwind to the wrong price. | D-01 |
| **R22** Never modify outside selection; exclude subs + gift cards | B | IMPLEMENTED | Proven against the writer's call log across advance, rollback and kill switch. | — |
| **R23** Webhook HMAC, GDPR, encrypted tokens, aggregates only | B | PARTIAL | HMAC verification correct (smoke ✓); `order_days` holds no PII. GDPR topics never delivered. | D-05 |
| **R24** Onboarding shows sync progress and guides a first rollout | A | PARTIAL | `components/onboarding/*` built (Sprint A5, `a1965ed`) against `sync_progress.schema.json`; demo-only. | D-07 |
| **R25** Plain language everywhere | A | IMPLEMENTED | Engine strings are merchant-language throughout; no jargon in guardrail or reading sentences. | — |
| **R26** Every screen designed for its worst state | A | PARTIAL | Empty/loading/error/zero-COGS states exist in components; unreachable for real data. | D-07 |
| **R27** WCAG AA, keyboard, responsive | A | PARTIAL | Sprint A7 ran (`2b89d10`, `b1445d9`) incl. reduced motion and 1.4.11. Not independently re-measured by Lane D. | — |
| **R28** Model honesty gate | C | IMPLEMENTED | **Verified against production `model_runs`: 3 succeeded, 4 rejected, 3 failed.** Enforced at the ingest boundary — a rejected run stores no fits or bands. | — |
| **R29** Fitted expected bands; calibration as a safety property | C | PARTIAL | `expected_bands` populated (133 rows); staleness demotion verified. Band calibration has never been measured against real outcomes. | D-06, D-12 |
| **R30** Calibration tracking from day one | C | **NOT-BUILT** | Computed in `reports.py`, stored nowhere. | D-09 |
| **R31** Versioned model outputs, traceable | C | IMPLEMENTED | `model_runs` (10 rows) with `model_version`; fits and bands carry `model_run_id`. | — |
| **R32** Staleness rule — never serve stale model output as fresh | B,C | IMPLEMENTED | `effectiveFitConfidence` demotes past `MAX_FIT_AGE_DAYS` and raises a `stale_model` warning; the evaluator falls back to bracket bands and sets `band_stale`. Verified in smoke and by Lane D's contract reading. | — |
| **R33** Application authentication | B | **NOT-BUILT** | Shared-secret gate only; routes fall back to `staticShopDomain()`. | D-10 |

**Totals:** IMPLEMENTED 14 · PARTIAL 13 · NOT-BUILT 6.

---

## 6. The three I would fix first

1. **[D-01] The kill switch.** It is the promise a merchant leans on when they
   are frightened, it reports success while being wrong, and it has a failing
   test and a clean fix (restore the earliest journaled `before_price_cents` —
   which the runbook's manual SQL already does). Everything else on this list
   costs a merchant time; this one costs them margin, silently, at the worst
   possible moment.

2. **[D-04 + D-05] External-change detection.** Together these mean Priceflag
   will fight a merchant for control of their own prices and win. The webhook
   handler is already written and correct — this is a registration call plus
   moving the `applied_at === null` condition. Small change, and it removes the
   most likely way a first pilot ends badly.

3. **[D-02 + D-10] Disarm the automation until authentication exists.** Not a
   code fix so much as a sequencing error: the hourly writer is live before the
   auth model is. I would disable the `schedule:` trigger (keeping
   `workflow_dispatch`) until R33 lands. Cheap, reversible, and it removes the
   one path by which today's gaps could reach a real storefront unattended.

`D-07`/`D-08` are larger than any of these, but they are *build* work, not
fixes — they belong to Lane A and Lane B as sprints, and they are already the
obvious next sprints.

---

## 7. What I could not test, and what I would need

| Not tested | Why | What would unblock it |
|---|---|---|
| A real price write to a real storefront | Deliberately never issued a mutating call against the live store; the whole writer surface was driven through a stubbed transport. | A throwaway Shopify development store with its own token, and a `PRICEFLAG_SHOP_ALLOWLIST` so the evaluator can never touch anything else. |
| The full lifecycle on real telemetry | `priceflag-test` has 26 products and **zero orders**; guardrails cannot fire without demand. | Scripted orders against a dev store (`scripts/simulate-store.ts` is referenced in BUILD_BRIEF §7 but does not exist — only `simulate-rollout.ts` does), or an order-generating fixture. |
| Whether auto-rollback *would* whipsaw a healthy small store | Needs a Monte Carlo over the real band generator across seeds × SKU counts × thresholds. Lane A's raise of a demo guardrail from 30% → 45% is direct evidence the concern is real and unquantified. | Nothing external — this is a day of work and it is the highest-value untested question in the product. It decides whether auto-rollback should ship on by default. |
| Install / uninstall / reinstall (B2) | Production uses the static-token path; no OAuth install has ever run. | A Partner-Dashboard app with custom distribution and a store to install onto. |
| `sb_secret_` key rejected mid-run, Supabase unreachable mid-write | Would require revoking live credentials against the shared project. | A separate Supabase project for QA. |
| Real-browser UI states, keyboard nav, measured contrast | The screens only render demo data, so the states that matter for a pilot (real empty catalogue, real syncing, real zero-COGS) are unreachable. | [D-07](#d-07) fixed first; the audit is not meaningful before then. |
| Whether Lane C's recorded incumbent scores are still valid | Lane C's negative-binomial change altered golden series for a fixed seed. | Regenerate golden data at the recorded seeds and diff against `ml/eval/*.json`. |

---

## 8. Bottom line

The **engine** is good. Rollback correctness, cent-exactness, R22 containment,
idempotency, the crash window, and the evaluator lease all held under
adversarial fuzzing on both adapters. The model gate genuinely rejects worse
models and records the rejection. Ground truth genuinely never reaches a
forecast. The care in `lib/pricing/writer.ts` and `lib/engine/` is real, and it
is why the P0 list is as short as it is.

What does not exist is the **product around it**: no way for a merchant to see
their own store, no way to start a rollout, no authentication, no webhooks, and
no calibration record. Meanwhile the one piece of automation that *is* live —
the hourly evaluator against a production `write_products` token — is the piece
that should have been switched on last.

Pointing this at a real merchant's store today would mean a merchant who cannot
see their catalogue, cannot start a rollout, shares one password with everyone
else who has the link, has their manual price edits reverted within the hour, and
whose emergency undo can leave them on a price they never chose. The distance to
pilot-ready is not large — it is D-07, D-08, D-10, D-01, D-04/D-05, roughly in
that order — but it is real, and none of it is the ML or the pricing engine.
