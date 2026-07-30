# Model registry (Lane C)

Every model that has ever been champion, challenger, or rejected. Scores come
from the eval harness (`priceflag_ml/harness.py`) on the golden store
(`n_skus=24, days=180, seed=7`) unless noted. PRD R28: a challenger replaces
the champion only by beating it here AND on real-data backtests.

## Champions (current)

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

### bracket-v0-standin-0.1 — elasticity (incumbent since C1)

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

(none yet — C2/C3 will add them)

## Rejected

(none yet — rejected challengers get recorded here with their losing scores,
never deployed)
