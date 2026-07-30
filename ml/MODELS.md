# Model registry (Lane C)

Every model that has ever been champion, challenger, or rejected. Scores come
from the eval harness (`priceflag_ml/harness.py`) on the golden store
(`n_skus=24, days=180, seed=7`) unless noted. PRD R28: a challenger replaces
the champion only by beating it here AND on real-data backtests.

## Champions (current)

### bracket-band-ts-port-1.0 — expected band (the incumbent C3 must beat)

- **What:** faithful Python port of Lane B's shipped fallback band
  (`lib/engine/bands.ts`): trailing 28-day mean, day-of-week mean shrunk
  toward the overall mean (prior strength 2), interval = z80 ·
  sqrt(max(sample_var, mean)), low edge floored to 0 when expected < 3 units.
  This is what the evaluator actually uses until C3's bands are fresh.
- **Scores (rolling-origin, horizon 14, 4 origins, golden seed 7):**
  median WAPE **0.572** · median MAPE 0.619 · pooled 80% coverage **0.803** ·
  pinball q10 0.794 · q90 1.278.
- **Note:** it beats seasonal-naive on every metric — so the C3 gate is
  against THIS band, not the weaker naive.

### seasonal-naive-0.2 — baseline demand forecaster (incumbent since C1)

- **What:** point = robust seasonal naive (mean of last ≤4 clean same-weekday
  observations, stockout days excluded); 80% band from empirical quantiles of
  *this rule's own* in-sample residuals; NB-approximate floor band only when
  history is too short for quantiles.
- **Scores (rolling-origin, horizon 14, 4 origins):**
  median WAPE **0.591** · median MAPE 0.639 · pooled 80% coverage **0.784**
  (nominal 0.80) · pinball q10 0.844 · q90 1.334
- **Role:** the bar C3's ETS / LightGBM challengers must beat (win on ≥70% of
  golden SKUs, coverage within ±10pts of nominal).
- **History:** v0.1 computed band quantiles from pure t-7 differences while
  centering the band on the mean-of-4 point forecast — the mismatched variance
  made the "80%" band cover ~88–90%, which would have suppressed auto-rollback.
  Caught by adversarial review before first commit; residuals now match the
  point rule and a calibration test pins coverage to 80±10pts.

### elasticity-poisson-eb-1.0 — elasticity (champion since C2)

- **What:** per-SKU Poisson GLM (IRLS; units ~ log link on log relative
  price + dow dummies + linear trend) fit on **non-promo, non-stockout days
  only** (promotional price variation is confounded with the promo lift —
  excluded by construction); moving-block bootstrap SE (block 14) plus a
  drift allowance (`DRIFT_SE = 0.35`) for slow seasonality a linear trend
  can't track; empirical-Bayes shrinkage toward a robust portfolio prior
  (median center; fixed `tau = 0.6` — estimating tau from 10–25 noisy fits
  proved unstable, see Rejected). SKUs with no permanent price variation
  honestly degrade to the bracket (`assumption`).
- **Scores (5 golden seeds, identifiable slice, vs bracket incumbent):**
  recovery MAE **0.486 vs 0.491** · within ±0.3 **43.9% vs 33.1%** ·
  80% CI covers true elasticity **86.0%** (bracket has no per-SKU CI) ·
  per-SKU differentiation (bracket gives every SKU −1.2 forever).
  Snapshot: `eval/c2_elasticity.json`.
- **Scope honesty:** the brief's aspiration of ±0.3 recovery for most
  identifiable SKUs is statistically unreachable on this data: an unbiased
  single-SKU estimator has sd ≈ 0.8–1.2 given 90–180 days of NB-dispersed
  daily counts and 1–3 price changes of 5–20% (measured on golden by
  simulation). The gate therefore compares estimators on within-±0.3 rate,
  MAE, and CI calibration — the challenger wins all three.

### bracket-v0-standin-0.1 — elasticity (incumbent C1→C2, now the assumption-tier fallback)

- **What:** fixed assumption bracket, point −1.2, range [−2.2, −0.6],
  `confidence: assumption`, ignores the data. Stand-in for v0's transparent
  bracket math until `lib/forecast.ts` is committed (see
  contracts/requests-lane-c.md); constants to be reconciled then.
- **Scores (golden recovery):** all SKUs MAE **0.519**, 29.2% within ±0.3;
  identifiable slice (≥2 permanent price levels, n=19) MAE **0.464**, 31.6%
  within ±0.3.
- **Role:** the bar C2's ridge log-log estimator must beat on the identifiable
  slice while degrading honestly to `assumption` elsewhere.

## Challengers

(none in flight — C3/C4 will add them)

## Rejected

All tested during C2 development on golden data; none deployed.

- **log-log ridge, λ=1 on all coefficients** (the brief's literal v1 recipe):
  penalizing the log-price coefficient attenuates elasticity ~4x (its column
  variance is tiny — a 10% price change is 0.095 in logs). Identifiable-slice
  MAE 1.18, within ±0.3 5%.
- **log-log OLS with promo dummy, unpenalized elasticity:** log(units+1)
  attenuates low-volume SKUs; promo-window price cuts collinear with the
  promo dummy → wild fits on promo-only SKUs. MAE 0.69, within ±0.3 26%.
- **Penalized cubic-spline time control:** flexible enough to absorb the
  price-step discontinuity, stealing the price signal. Raw SEs up to 10+;
  MAE 0.67.
- **Sub-annual sin/cos + trend time control:** nearly collinear with a
  mid-series price step; same failure as splines. Wild raw fits (−9..+5).
- **DerSimonian–Laird precision-weighted EB prior:** bootstrap SEs are noisy
  enough that inverse-variance weighting let deceptively-tight wild fits
  drag the prior to −1.9 (true portfolio mean −1.4) and collapse tau² to the
  floor — every SKU shrunk to a wrong center at claimed se 0.05, CI coverage
  11%. Replaced by median center + fixed tau.
- **MAD-estimated tau²:** unstable in the other direction (tau 0.3 on one
  seed, 2.4 on another → shrinkage lottery). Fixed tau = 0.6 instead.
- **Robust variants (SE floor 0.6 / winsorize at mu±2tau):** indistinguishable
  from base on 5-seed golden (ΔMAE < 0.005); not adopted beyond a simple
  clip of raw fits to [−3.5, 0].
