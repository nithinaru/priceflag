# Lane C status — Machine Learning

**Current:** Sprint C1 complete (2026-07-29). Next: C2 (elasticity v1).

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
