# Lane C status — Machine Learning

**Current:** C1–C7 complete (2026-07-29). Post-QA work in progress (2026-07-30):
Lane D's `docs/QA_REPORT.md` and Lane B's shipped `/api/ml/ingest` opened a
second round — C8 landed, C9–C11 in flight.

## C11 — D-17: the report loop, built up to the one seam I don't own ✅ (2026-07-30)

`rollout_reports` holds 0 rows. `reports.py` has emitted schema-exact rows
since C6 with no transport into the database, so R30 — the PRD's declared moat
— has been measured on nothing real.

Lane C's half is now complete end to end:

- **Read** — `SupabaseSource.rollout_windows()` (completed rollouts from
  `ml_rollout_windows`), `price_history()` (`ml_price_history`), `products()`
  (for COGS). All three views were already granted to the ML role by B6.
- **Recover the plan from the journal, not the proposal** —
  `plans_from_price_history()` takes each variant's earliest `before_price` and
  latest `after_price` in the rollout. The journal records what was actually
  *written to the storefront*, so the report describes the prices shoppers
  really saw even if a stage was interrupted or a variant excluded at write
  time (R22). Rollback entries are excluded: folding the restore in would make
  new_price equal old_price and report a completed rollout as having changed
  nothing. Missing COGS stays `None`, not 0 — 0 would mean 100% margin and
  fabricate a profit number (R3).
- **Build and post** — the nightly builds a report per completed rollout,
  writes `out/rollout_reports.json` and `out/calibration_summary.json`, and
  posts with `kind: 'report'` and a `reports: [...]` array.

**The seam I don't own, and why the nightly is red about it.**
`POST /api/ml/ingest` reads only `fits` and `bands`. Extra JSON keys are
*ignored*, not rejected — so a report payload comes back `200 accepted` with
the rows silently gone. That is the worst available failure shape: R30 would
read as shipped while the table stayed empty, which is exactly the state
Lane D found. So `IngestClient` treats an accepted response that does not
account for what was sent as a failure: if `reports_written` is absent from the
response, the result is an error and the nightly goes red. Requested as item 13
(with item 14 on where `calibration_summary` should live). When Lane B adds the
field, nothing on my side changes — there is a test asserting exactly that.

152 tests green; no snapshot drift.

## C10 — Lane C's half of D-12 and D-16 ✅ (2026-07-30)

Both findings are Lane B fixes at the point of use, but both have a producer
half that is mine, and in D-12's case the ambiguity starts in what I emit.

**D-12 — a probability that cannot say what it measures now says nothing.**
`breach_probability` is documented as "P(true effect is worse than the
guardrail threshold)" but carries no statement of *which quantity* the
threshold is on. I derive it from units; `lib/engine/guardrails.ts:116` reads
it before it reads `rule.metric`. So a units probability satisfies a revenue
rule whose revenue is exactly on expectation — auto-rollback firing on
something nobody measured.

`CounterfactualMonitor.contract_rows()` now takes the rollout's
`guardrail_metrics` and emits `breach_probability: null` unless every guardrail
on that rollout watches units. This costs something real: the evaluator falls
back to raw threshold crossing, which is noisier on small stores — the exact
whipsaw C5 was built to reduce. It is still the right trade. Noisier and about
the right quantity beats confident and about the wrong one. `breach_metric` is
requested as item 11; when it lands the suppression drops out.

A revenue-metric counterfactual is a different model, not a relabelling — it
would need its own R28 gate, so it is a sprint, not a patch. Offered in the
requests file.

**D-16 — the nightly can no longer be what fires it.** The evaluator sums
`expected_units` across every band row it finds for a variant-day, so a
duplicate inflates the expectation, and an inflated expectation is a
manufactured shortfall. `IngestClient` now refuses any payload with two rows
for the same `(variant_gid, day, rollout_id)`, or with mixed `band_kind`s in
one request — raising, not dropping, so which band wins never depends on dict
ordering. This is containment, not a fix: a rollover between two model versions
still leaves two rows in the table and only the evaluator can resolve that.
The dedupe rule I would use is spelled out in requests item 12.

136 tests green; no snapshot drift.

## C9 — The write path is closed: the nightly posts what it fits ✅ (2026-07-30)

`contracts/requests-lane-c.md` item 9 asked for two things. Lane B delivered
both, so the loop is now closed end to end:

- **Enumeration** — `SupabaseSource.list_shops()` reads `ml_products` (B6
  granted `select` to the ML role). The nightly no longer needs to be told
  which shops exist.
- **A write path** — `POST /api/ml/ingest`. Lane B built the endpoint rather
  than issuing a write key, which is the better half of what I asked for:
  Lane C's role stays read-only and every row reaches Postgres by being
  validated and accepted by code holding the service role.

`priceflag_ml/ingest.py` (`IngestClient`) posts fits and bands; `nightly.py`'s
`refit_real_stores()` now actually refits — per shop: `elasticity.fit_store()`
→ `fits_contract_rows()`, and `CleanLevelBaseline` per SKU →
`bands_contract_rows()` at a 14-day horizon — then posts **one request per
kind**, because the endpoint records one `model_runs` row per request and a
mixed payload would leave the registry unable to say which surface deployed.

Three properties this client is built around, all tested:

1. **A red harness cannot deploy.** The golden gate verdict is what the post
   carries as `gate_passed`. If any champion stopped beating its incumbent
   this run, every post goes out with `gate_passed=false` — recorded in
   `model_runs`, rows discarded (R28). Rows are also stripped client-side, so
   a losing run does not even offer data to write.
2. **No silent truncation.** Over 20 000 rows the client raises instead of
   chunking. Writes are all-or-nothing per request; half a band set in the
   table is worse than none, because the evaluator reads the half that landed
   and believes it is whole.
3. **No automatic retry.** A POST that times out after the server committed is
   the same crash window Lane D fuzzed on the price writer. Fits and bands are
   upserted so a retry would not corrupt them, but it would mint a second
   `model_runs` row claiming the same work. One attempt, then a red nightly.

A shop with a synced catalogue and no orders produces nothing and is **not** a
failure — the evaluator falls back to Lane B's bracket band for it. A shop
whose post is refused **is** a failure and turns the run red.

`ml-nightly.yml` now passes `PRICEFLAG_APP_URL` + `ML_INGEST_SECRET` (already
present in Lane B's `.env.example`). Both absent → artifacts only, exactly as
before; nothing about golden-mode behaviour changed.

## C8 — The recorded incumbent scores are still valid ✅ (2026-07-30)

QA_REPORT §9 lists "whether Lane C's recorded incumbent scores are still
valid" as untested, on the theory that the negative-binomial change moved the
golden series under a fixed seed. **Answer: they are valid — zero drift.**

`uv run python nightly.py` re-derives every verdict from scratch and compares
it to the committed snapshot; all six checks report `drift=none`, including
the C1 incumbent numbers themselves. The NB change that worried Lane D was in
Lane B's `lib/demo/generator.ts`; Lane C's golden universe
(`priceflag_ml/golden.py`) has drawn NB noise since C1 and is SHA256-pinned in
`tests/test_golden.py`, so a fixed seed still produces byte-identical data.

What was genuinely missing, and now is not: **the bar itself was never
drift-checked.** The nightly re-validated C2/C3/C4/C5/C6 against
`eval/*.json`, but `eval/c1_incumbents.json` — the seasonal-naive and
`BracketBand` scores that *define* R28's "beat the incumbent" — was checked by
nothing after C1. A silent change to the incumbents would have moved the
goalpost under every challenger verdict without failing a single gate.
`incumbents-c1` is now the first entry in `nightly.CHECKS`, with its own
safety gate: both incumbents' pooled 80% coverage must stay in [0.70, 0.90]
(R29). `BracketBand` is Lane B's shipped `lib/engine/bands.ts` — when no model
band exists, it is what auto-rollback actually fires on, so its calibration is
a production safety property, not a scoring detail.

## C7 — Nightly production loop ✅

- `ml/nightly.py` + `.github/workflows/ml-nightly.yml` (daily 07:00 UTC +
  manual dispatch): re-runs every champion's harness gate (C2/C3/C5/C6) AND
  the C4 recorded-loser check, plus an exact drift check against the
  committed `eval/*.json` verdict snapshots — the golden universe is
  deterministic, so any numeric drift means a code/dep change silently
  altered model behavior. Any failure = exit 1 = red nightly. Verified green
  end-to-end locally.
- Acceptance ("a deliberately-degraded model is rejected by the gate") is a
  unit test: a degraded challenger fails the gate, and a still-winning model
  whose numbers drifted from the snapshot ALSO fails (silent behavior change
  is an alarm, not a pass).
- `model_runs.json` rows record champions AND the recorded loser
  (status=rejected) per R28; artifacts uploaded on every run.
- Real-data refit leg activates automatically when `SUPABASE_URL` +
  `SUPABASE_ML_READONLY_KEY` secrets exist; writing into the tables needs
  the write path requested in contracts/requests-lane-c.md item 9.

## Current champions (all verdicts snapshot in ml/eval/, drift-pinned)

| Surface | Champion | Key scores (golden) |
|---|---|---|
| Elasticity | elasticity-poisson-eb-1.0 | MAE 0.486 vs 0.491, within±0.3 43.9% vs 33.1%, CI cov 86% |
| Expected bands | baseline-cleanlevel-1.0 | WAPE 0.525 vs 0.553, win 65%, non-floored cov 0.791, p10 0.713 |
| Rollout monitor | counterfactual-cleanlevel-1.0 | FPR 0% vs 10%, catastrophic median day 1 |
| Post-rollout reports | rollout-report-1.0 | pct_in_range 77.8% (R30 ≥70%) |
| (recorded loser) | elasticity-hier-em-1.0 | loses both slices; pinned |

## C6 — Post-rollout reports + calibration ✅

`priceflag_ml/reports.py` — `rollout-report-1.0`:

- `build_report()` emits `rollout_report.schema.json`-exact rows (validated
  in tests): predicted outcome band (proposal-time elasticity scenarios
  applied to the C5 counterfactual baseline), realized outcome vs the
  counterfactual (external drift never mis-attributed to the price change),
  `in_range` (R30 — reported even when unflattering), updated cohort
  elasticity, plain-language narrative (R25-clean, tested for jargon), and
  per-variant rows. Money is integer cents throughout; missing COGS gives
  null profit + revenue-based in_range, said openly in the narrative.
- Directional claims ("customers were less price-sensitive than assumed")
  require the update to clear BOTH 0.25 and its own z80 noise — a 30-day
  window with one ~10% change has se ≈ 1.0, and claiming direction from
  noise is exactly what R25/R30 forbid.
- **End-to-end honesty check (9 golden rollouts, +10% price, demand
  responding with true elasticities): realized outcome landed inside the
  predicted range 77.8% of the time** (PRD success metric ≥70%) —
  `eval/c6_reports.json`. `calibration_summary()` provides the R30 dashboard
  number.
- **For Lane A:** render `narrative` verbatim; `elasticity_update.direction`
  drives your headline sentence; `per_variant` feeds the table.

## C5 — Rollout counterfactual monitor ✅

`priceflag_ml/counterfactual.py` — `counterfactual-cleanlevel-1.0`:

- CausalImpact-style: C3 champion fit per treated SKU on pre-change days
  only, cohort-aggregated band, cumulative effect ratio with CI, and a
  **breach probability** P(true drop worse than the guardrail | data) —
  the number Lane B's evaluator already prefers at ≥ 0.8 (R29).
- **Acceptance (3 seeds × 10 reps, 8-SKU cohort, 20% guardrail):** false
  positives 0/30 over 14-day windows (raw-threshold rule: 10%); catastrophic
  drops (×0.5) flag at median day 1 (77% within 2 days); moderate (×0.65)
  97% flagged, median day 3; boundary effects (×0.75) get correctly cautious
  treatment. Beats the raw rule on both FPR and speed →
  `eval/c5_counterfactual.json` verdict "challenger wins".
- Emits `expected_band` rows with band_kind=counterfactual + rollout_id +
  breach_probability (schema-validated). Golden generator now supports
  known-effect rollout scenarios (`simulate_sku(effect_ratio,
  effect_start_idx)`).
- **For Lane B:** cohort-level breach_probability rows are stamped per
  variant for rollout-scope guardrails; if you want per-variant breach
  probabilities too, say so in your status file and I'll split them in C6.

## C4 — Hierarchical elasticity: challenger LOST, C2 stays champion ✅

The honest outcome the brief anticipated ("otherwise C2 stays champion and
this is recorded — no vanity upgrades"). Partial pooling across categories
was implemented (`priceflag_ml/elasticity_hier.py`: two-level EM empirical
Bayes; category-clustered golden universes added to the generator behind
`GoldenConfig.n_categories`, default off and byte-identical) and it LOSES to
C2 on the harness: thin-slice MAE 0.830 vs 0.457, identifiable 0.728 vs 0.533
(5 seeds; robust shrunk-median variant also loses at 0.629). Why: ~4-6
identifiable SKUs per category x fit noise sd ≈ 1.0 → a category mean's own
error exceeds the category signal. EM implementation is verified correct by
tests (recovers known hyperparameters), the losing verdict is snapshot at
`ml/eval/c4_hier.json` and PINNED by a test, and the code stays as a scorable
challenger for when real multi-store data arrives. Full analysis in
`ml/MODELS.md`. Real-data half of the acceptance is blocked on B6
credentials.

## C3 — Baseline demand forecaster ✅

`priceflag_ml/forecaster.py` — champion `baseline-cleanlevel-1.0`:

- Promo-aware dow-level model: level fit ONLY on non-promo, non-stockout days
  (the incumbent's biggest bias: its trailing mean inhales promo spikes and
  over-expects for weeks); smoothed weekday profile; EW level (half-life
  14d); 80% band from clean-day residual variance in the incumbent's
  overdispersed-Poisson family; low-volume floor + `is_floored` per the
  evaluator's semantics; bracket-band fallback when < 7 clean days.
- **R28/R29 gate (5 golden seeds, h=14):** median WAPE **0.525 vs 0.553**
  (bracket band incumbent), win rate **65%** vs bracket band, **82.5%** vs
  seasonal-naive (brief's ≥70% acceptance met). Calibration gated where
  rollback can actually fire: **non-floored 80% coverage 0.791**, per-SKU
  coverage p10 **0.713** (floored low-volume days structurally over-cover and
  are reported separately). `eval/c3_baseline.json` has the verdict and is
  pinned by a staleness test; rejected challengers (statsmodels ETS,
  LightGBM, per-SKU selection ensembles) are in `ml/MODELS.md` with scores.
- **Adversarial review (13 agents, pre-push):** 10 confirmed defects fixed —
  headline: clean-window bug used the last 56 clean rows ever (stale levels →
  false rollbacks), pooled-only calibration gate masked per-SKU
  miscalibration, null `list_price_cents` was zero-filled into the
  elasticity regressor, contract invariant low ≤ expected ≤ high now
  enforced at the band boundary and in the harness.
- `bands_contract_rows()` emits `expected_band.schema.json`-exact rows
  (schema-validated in tests): band_kind=baseline, `is_floored`, interval
  0.8, model_version.
- **For Lane B:** these bands are ready to write into `expected_bands` as
  soon as B6 credentials exist; until then the shipped bracket band is a fine
  fallback (it scored 0.803 coverage on golden — honest, just ~6% worse WAPE
  and slow to recover after promos).

## C3 part 1 — post-B1 alignment (landed earlier)

- `ml/data.py` reads Lane B's `ml_product_days` view (variant_gid → sku,
  day → date, **list_price_cents → price_cents** as instructed, on_promo,
  had_stockout), paginated + densified. Mock-transport tested.
- `fits_contract_rows()` emits `elasticity_fit.schema.json`-exact rows
  (validated against the committed schema in tests): `confidence_explanation`,
  `shrinkage_weight`, `prior_elasticity`, `method`, `fitted_at`, windows.
- Lane B's fallback band (`lib/engine/bands.ts`) ported into the harness as
  `BracketBand` — and it **beats seasonal-naive** on golden (median WAPE 0.572
  vs 0.591, 80% coverage 0.803 vs 0.784, both pinballs better). C3's fitted
  forecaster gates against the bracket band, not the naive.
- Replies to Lane B in contracts/requests-lane-c.md items 6–8 (incl.: yes,
  switch the demo generator to negative-binomial noise).

## C2 — Elasticity v1 ✅

`priceflag_ml/elasticity.py` — champion `elasticity-poisson-eb-1.0`:

- Per-SKU Poisson GLM (IRLS) on non-promo/non-stockout days: log(mu) =
  a + ε·log(rel price) + dow + trend. Promo days excluded because promo price
  cuts are confounded with the promo lift (the golden generator's deliberate
  trap — controlled by exclusion, not by a collinear dummy).
- Moving-block bootstrap SEs + drift allowance; EB shrinkage toward a robust
  portfolio median with fixed between-SKU tau = 0.6.
- Honest tiers: `fitted` (real non-promo price variation, ≥60 days, tight
  posterior) / `partial` (usable but thin signal — most SKUs land here, which
  is the true state of 6-month order histories) / `assumption` (no permanent
  price variation → v0 bracket verbatim). Every row carries a plain-language
  `explanation` (Lane A renders it as-is).
- `fits_frame()` emits `elasticity_fits` contract rows (elasticity, low,
  high, se, n_obs, price_variation_pct, confidence, explanation,
  model_version, fitted_at).

**R28 gate (5 golden seeds, identifiable slice):** beats bracket incumbent on
within-±0.3 (43.9% vs 33.1%) and MAE (0.486 vs 0.491); 80% CI covers the true
elasticity 86.0% of the time. Verdict recorded in `eval/c2_elasticity.json`;
seven rejected approaches documented in `ml/MODELS.md`.

**Scope honesty (important for expectations):** per-SKU ±0.3 recovery for
most SKUs is statistically impossible at this data scale — an unbiased
estimator has sd ≈ 1.0 given 90–180 days of overdispersed daily counts and
1–3 price changes. The product's honesty comes from the tiers + calibrated
CIs, not from pretending point precision.

**Adversarial review (pre-push, 20 agents):** 17 confirmed defects fixed.
Highlights: a dead SKU (zero sales, historical price change) was being served
`fitted` with a near-inelastic estimate (reads as "safe to raise price");
wrong-sign raw fits acted as precise pseudo-observations of "elasticity = 0";
merchant-facing explanation strings stated wrong reasons in several branches
(now cause-derived); the R28 gate test now runs the exact shipped 5-seed
verdict. 62 tests green.

## C1 — Data access + golden harness ✅

Landed in `ml/`:

- **Golden-data generator** (`priceflag_ml/golden.py`) — synthetic store with
  known ground truth per SKU: constant elasticity, weekday/annual seasonality,
  trend, promos (with deliberate price↔demand confound), permanent price
  changes (mix of 0–3 per SKU; thin history is the norm), stockout gaps,
  negative-binomial noise. Fully deterministic (seeded, fixed date anchor).
- **Data access** (`priceflag_ml/data.py`) — canonical tidy frame; golden
  loader + read-only Supabase PostgREST source (untested against a real DB —
  needs B6 credentials; column assumptions in contracts/requests-lane-c.md).
- **Incumbents** (`priceflag_ml/baselines.py`) — seasonal-naive forecaster
  with calibrated 80% bands (empirical residual quantiles of its own point
  rule; NB floor fallback for short history); bracket elasticity stand-in for
  v0 math (v0 source not in repo — see requests file).
- **Metrics + harness** (`priceflag_ml/metrics.py`, `harness.py`) — WAPE/MAPE,
  interval coverage, pinball loss, elasticity recovery; rolling-origin
  backtest with strict input/forecast validation (daily contiguity required,
  forecast dates must match the test window, non-finite or inverted bands
  rejected); champion-vs-challenger comparator (unscoreable SKUs excluded, not
  counted as losses); stockout days excluded from scoring. Harness itself is
  under test (oracle forecaster must score perfectly; misaligned/NaN
  forecasters must be rejected).
- **CI** — `.github/workflows/ml-ci.yml` runs `uv sync --locked && pytest` on
  `ml/**` pushes/PRs. 47 tests green.
- **Adversarial review before first push** — a 25-agent review/verify pass
  confirmed 21 defects (0 refuted), all fixed. The two that mattered: (1) the
  80% band was calibrated against a different point rule than it was centered
  on → real coverage ~89% (would have suppressed auto-rollback — R29); (2) the
  backtest aligned forecasts to actuals by position without checking dates →
  off-by-one or gapped-history challengers scored silently wrong (would have
  corrupted the R28 gate). Both now have regression tests; band calibration is
  pinned to 80±10pts and the golden universe is SHA256-snapshot-pinned.

## Harness scores — the bar every challenger must beat (R28)

Golden store `n_skus=24, days=180, seed=7`; reproduce with
`cd ml && uv run python -m priceflag_ml.harness` (snapshot committed at
`ml/eval/c1_incumbents.json`).

| Incumbent | Metric | Score |
|---|---|---|
| seasonal-naive-0.2 (backtest, h=14, 4 origins) | median WAPE | **0.591** |
| | median MAPE | 0.639 |
| | pooled 80% coverage | **0.784** (nominal 0.80 — calibrated) |
| | pinball q10 / q90 | 0.844 / 1.334 |
| bracket elasticity (−1.2, assumption) | recovery MAE, all 24 SKUs | **0.519** |
| | % within ±0.3, all | 29.2% |
| | recovery MAE, identifiable slice (n=19, ≥2 permanent price levels) | **0.464** |
| | % within ±0.3, identifiable | 31.6% |

## For the other lanes

- **Lane B:** contracts/requests-lane-c.md has 4 items — v0 source files,
  `order_days` columns (`price_cents`/`promo`/`stockout`), read-only creds
  timeline, output-table schemas. None block me yet.
- **Lane A:** confidence tiers will arrive exactly as
  `fitted | partial | assumption` with a one-line plain-language
  `explanation` string per fit (from C2 on).
- Run ML tests from repo root: `uv run --project ml pytest ml` (needs uv;
  `brew install uv`).
