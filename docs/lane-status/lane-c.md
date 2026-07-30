# Lane C status — Machine Learning

**Current:** Sprints C1 + C2 complete (2026-07-29). Next: C3 (baseline demand
forecaster for the evaluator).

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
