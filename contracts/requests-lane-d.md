# Lane D → other lanes: requests

Lane D owns tests and findings, not product code. Everything here needs a
decision or a change inside another lane's owned paths. Full evidence and
reproduction for each item is in [`docs/QA_REPORT.md`](../docs/QA_REPORT.md).

Each request names the failing test that should go green when it lands.

---

## To Lane B — safety, in priority order

### 1. Auto-rollback should default to alert-only until the band semantics are fixed (D-01, D-02, D-03)

**This is a product decision, not just a code change, which is why it is a
request rather than a fix.** The PRD's open questions already ask it: *"Auto-rollback
on by default, or alert-only first?"* Lane D's measurement answers it.

At the shipped default (`30% below expected for 2 days`, `rollback_all`):

- a rollout with **unchanged demand** auto-rolls back **40%** of the time on 1
  SKU, 29.5% on 3, 10% on 6;
- a price rise whose demand effect was forecast **exactly right** auto-rolls back
  **68.5%** of the time at a predicted 20% drop, 92% at 30%.

The second number is the important one and it is a semantics bug, not a tuning
problem: the expected band is built from pre-rollout history, so it is a
*no-change* counterfactual (correctly, per R29), but the guardrail then scores the
merchant's intended and correctly-predicted demand effect as a shortfall against
it. The guardrail sentence promises "below expected"; no merchant reads that as
"below what would have happened if you had changed nothing".

Requested:

1. Short term — `defaultGuardrails()` sets `auto_rollback: false`. The code
   already downgrades a rollback to a pause, so the merchant still gets the
   email, the event and the numbers, with a human in the loop.
2. Proper fix — compare actuals against **expected-given-the-change**: the band
   shifted by the forecast's own predicted effect, or C5's counterfactual with
   its breach probability. This needs Lane C (below).
3. `bracketBand`'s window must not slide off the end of the history the evaluator
   loads. From rollout day 28 the window `[day-28, day)` no longer overlaps
   `[start-60, start-1]`, so `expected_units` is 0, every day is floored, and a
   total collapse to zero units cannot fire a guardrail. Either load history
   relative to `day` rather than `start`, or clamp the window to the loaded range
   and mark the band floored *loudly*.

*Test:* `tests/integration/false-rollback.test.ts` — three failing cases.

### 2. Rollback must restore from the earliest journaled price, not per-rollout baselines (D-04)

`app/api/kill-switch/route.ts` unwinds each rollout to its own captured baseline
in `listRollouts` order. That composes to the true pre-Priceflag price only if the
order is strictly newest-first, and `listRollouts` sorts on `created_at` with no
tie-breaker — so same-tick rollouts unwind oldest-first and the merchant is left
on a price Priceflag invented, while the response says `ok: true`.

Requested: restore each variant to the **earliest** `journal_entries.before_price_cents`
— which is exactly what `PILOT_RUNBOOK.md`'s manual recovery SQL already does. If
the per-rollout approach is kept instead, add `created_at DESC, id DESC` *and* a
comment stating the order is load-bearing.

*Test:* `tests/integration/concurrency.test.ts` → "the kill switch unwinds CHAINED
rollouts back to the original price".

### 3. Rollback must select on live price, not on `applied_at` (D-05)

`rollbackRollout` and `verifyRollback` both filter `applied_at !== null`. A
variant Shopify repriced but never acknowledged (the crash window) is therefore
invisible to both: the rollback leaves it on the new price and the verification
reports **0 mismatches**. The check that exists to catch this shares the bug.

Requested: select every non-excluded variant whose live price differs from its
baseline.

*Test:* `tests/integration/rollback-honesty.test.ts` → "a rollback skips variants
Shopify repriced but never acknowledged".

### 4. Floor the target price above zero (D-06)

`applyPercent`/`applyAbsolute` clamp with `Math.max(0, …)`, and nothing rejects a
target of zero. A `-100%` change writes **$0.00** to the storefront, staged
politely across three cohorts, with a confident forecast card in front of it.

Requested: reject a target price below 1 cent in `computeTargetPrice`, and again
in the writer as defence in depth. Consider a confirmation step for any change
over ~50%.

*Test:* `tests/integration/zero-price.test.ts`.

### 5. External-change detection must survive the variant going live (D-10, D-11)

`applyStage` only checks for an external price change when `applied_at === null`.
After that, `reconcileRollout` — called before every evaluator decision —
overwrites the merchant's manual price with no journal entry. The
`products/update` webhook handler *does* handle this correctly, but **no webhook
subscription is ever registered anywhere in the codebase**, so that defence does
not exist.

Requested: (a) register webhook subscriptions on install and for the static-token
path; (b) treat a live price that is neither the baseline nor our target as an
external change regardless of `applied_at`, and journal the observation either
way.

*Test:* `tests/integration/concurrency.test.ts` → "an admin edit AFTER the variant
went live…" (fails on both adapters).

### 6. Do not mark a partly-failed rollback terminal, or announce it as complete (D-13)

`lib/evaluator/index.ts` sets `status: 'rolled_back'` regardless of `undo.failed`
and `check.mismatched`, and emits *"Every price has been put back to what it
was."* `rolled_back` is terminal, so `listActiveRollouts` excludes it and the
stranded price is never retried.

Requested: on a partial failure, keep the rollout evaluable (`paused` with a
reason), say what did not restore, and surface `mismatched` where a merchant can
see it.

### 7. Deduplicate expected bands before combining them (D-16)

The evaluator passes **every** `expected_bands` row for a (variant, day) to
`combineBands`, which adds `expected_units`. Two band kinds, or two model versions
during a rollover, multiply the expectation and manufacture a shortfall. It also
queries with `rolloutId: undefined`, so a previous rollout's counterfactual band
can judge a new rollout on the same SKUs.

Requested: select one band per (variant, day) by `band_kind` + freshest
`model_run`, scoped to the rollout when a counterfactual band exists.

### 8. Smaller, still worth doing

- **D-12** — `breach_probability` short-circuits before `rule.metric` is read, so
  a units-derived probability fires revenue and profit rules too, and bypasses
  the low-volume floor. Scope it to the metric it was computed for.
- **D-19** — `TRUNCATE` defeats the append-only journal (row triggers do not fire
  on `TRUNCATE`). Add a statement-level `AFTER TRUNCATE` trigger and revoke
  `TRUNCATE` from the service role.
- **D-18** — the hourly evaluator workflow is live against production with a
  `write_products` token. Suggest disabling the `schedule:` trigger (keeping
  `workflow_dispatch`) until R33 lands.
- **D-20** — tests share the production Supabase project, and `evaluateAll`
  iterates every shop. A `PRICEFLAG_SHOP_ALLOWLIST` on the evaluator would make
  the isolation deliberate rather than accidental.
- **D-21** — expected revenue/profit use an unweighted mean price across the
  selection while actuals are true sums; historical readings are re-scored at
  today's prices.
- **D-23** — `PILOT_RUNBOOK.md`'s emergency undo calls routes that do not exist
  and omits the access-gate credential the same document declares mandatory. A
  runbook that does not work is worse than none.

---

## To Lane A

- **D-14** — `RollbackButton` and `KillSwitch` both take `demoMode = true` as a
  **default parameter** and the pages render them without passing it, so on a
  connected store the merchant clicks "Put prices back", sees a success toast, and
  no API is called. Invert the default, or make the prop required.
- **D-07** — every page reads `@/components/demo/store`; nothing calls
  `isDemoMode()`. This is the pilot blocker. Until it lands, please keep the
  permanent `Demo data` badge — it is the only reason this is a coverage gap
  rather than a lie to the merchant.
- **D-15** — `app/propose/actions.ts` passes the literal `"demo-shop"` to
  `getLatestFits` against a `uuid` column, so the one place the UI does reach the
  real adapter is the one place it cannot work.

## To Lane B and Lane A jointly

- **D-08** — there is no `POST /api/rollouts` (and no `POST /api/forecast`), and
  `createRollout` returns `rollout_id: null`. A merchant cannot start a rollout.
  `contracts/api.md` documents both. This is the largest single gap between what
  is built and what is usable.

## To Lane C

- **D-02 (the semantics half)** — the evaluator needs an
  *expected-given-the-change* band, not a no-change baseline, for anything a
  guardrail is scored against. C5's counterfactual with a breach probability is
  the right shape; it needs to be the primary path rather than an optional
  enrichment, and the breach probability needs to carry the metric it was computed
  for (see D-12).
- **D-17 / R30** — `rollout_reports` has a table, a schema and a Python
  summariser, and 0 rows, because `POST /api/ml/ingest` accepts only
  `model_run`, `fits` and `bands`. Calibration — the PRD's stated moat — is
  measured on nothing real. Needs a transport (a Lane B request too).
- The negative-binomial change altered golden series for a fixed seed. Please
  confirm the incumbent scores recorded in `ml/eval/*.json` were regenerated
  after it; if not, every "beats the incumbent" claim is measured against a bar
  that no longer exists. Lane D could not settle this.

Credit where due: the R28 gate genuinely works. Production `model_runs` shows
**3 succeeded, 4 rejected, 3 failed** — worse models are refused at the ingest
boundary and recorded rather than deployed. That is the discipline the brief
asked for, and it is visibly real.

---

## Cross-cutting suggestion

Every P0 above is a *semantics* or *wiring* failure, and none is an arithmetic
failure — the money layer and the rollback arithmetic survived hard fuzzing.
The tests that would have caught these are not unit tests of functions but
end-to-end assertions about outcomes: "after this sequence, what price is on the
storefront, and what did we tell the merchant?" `tests/integration/` is built for
exactly that shape and is cheap to extend; adding a case there when a finding is
fixed is the thing that keeps it fixed.
