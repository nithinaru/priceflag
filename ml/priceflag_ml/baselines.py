"""Incumbent models (PRD R28: the numbers every challenger must beat).

Two incumbents at kickoff:

1. ``SeasonalNaive`` — forecast baseline. Point forecast = mean of the last
   (up to) 4 non-stockout observations of the same weekday (a robustified
   seasonal naive). The 80% interval comes from the empirical quantiles of
   *this rule's own in-sample residuals* — residuals must be computed against
   the same point forecast the band is centered on, or the band's nominal
   level is a lie (bands drive auto-rollback; calibration is a safety
   property). When history is too short to estimate residual quantiles, bands
   fall back to a negative-binomial-approximate floor so they are never
   degenerate.

2. ``BracketElasticity`` — elasticity "estimator" that ignores the data and
   returns a fixed assumption bracket. This is the stand-in for v0's
   transparent bracket math (`lib/forecast.ts` is not committed to the repo
   yet — see contracts/requests-lane-c.md; constants below are from the PRD's
   description of the v0 scenario table and will be reconciled when the v0
   source lands). This is the incumbent for C2's fitted elasticity.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

Z80 = 1.2816  # two-sided 80% normal quantile

# Dispersion assumed for the variance floor when the data can't tell us:
# conservative (small k = more overdispersion). Daily retail order counts are
# overdispersed, so a pure-Poisson floor under-covers; var = mu + mu^2/k.
FLOOR_DISPERSION_K = 5.0


def _band_floor(expected: np.ndarray) -> np.ndarray:
    """Minimum half-width of the 80% band: NB-approximate, never zero."""
    return Z80 * np.sqrt(expected + expected**2 / FLOOR_DISPERSION_K + 1.0)


class SeasonalNaive:
    """Robust seasonal naive with calibrated empirical 80% intervals.

    fit() expects a single-SKU daily frame with columns
    ``date, units[, stockout]``, one row per consecutive calendar day.
    """

    model_version = "seasonal-naive-0.2"

    def __init__(self) -> None:
        self._pattern: np.ndarray | None = None  # units by weekday (Mon..Sun)
        self._q10 = 0.0
        self._q90 = 0.0
        self._has_resid_quantiles = False
        self._last_date: pd.Timestamp | None = None
        self._fallback_mean = 0.0

    def fit(self, history: pd.DataFrame) -> "SeasonalNaive":
        if len(history) == 0:
            raise ValueError("SeasonalNaive.fit: empty history — nothing to forecast from")
        df = history.sort_values("date").reset_index(drop=True)
        y = df["units"].to_numpy(dtype=float)
        stockout = df["stockout"].to_numpy(dtype=bool) if "stockout" in df.columns else np.zeros(len(df), bool)
        weekday = pd.DatetimeIndex(df["date"]).weekday.to_numpy()
        self._last_date = pd.Timestamp(df["date"].iloc[-1])

        ok = ~stockout
        self._fallback_mean = float(y[ok].mean()) if ok.any() else 0.0

        # Weekday pattern: mean of up to the last 4 non-stockout observations
        # of each weekday.
        pattern = np.full(7, self._fallback_mean)
        for wd in range(7):
            vals = y[(weekday == wd) & ok]
            if len(vals):
                pattern[wd] = float(vals[-4:].mean())
        self._pattern = pattern

        # Empirical residuals of THIS point rule on clean in-sample days —
        # the band must be calibrated around the forecast it brackets.
        if len(y) >= 14 and ok.sum() >= 8:
            resid = y[ok] - pattern[weekday[ok]]
            self._q10, self._q90 = (float(q) for q in np.quantile(resid, [0.10, 0.90]))
            self._has_resid_quantiles = True
        return self

    def forecast(self, horizon: int) -> pd.DataFrame:
        if self._pattern is None or self._last_date is None:
            raise RuntimeError("fit() before forecast()")
        dates = pd.date_range(start=self._last_date + pd.Timedelta(days=1), periods=horizon, freq="D")
        expected = self._pattern[dates.weekday.to_numpy()]
        if self._has_resid_quantiles:
            # Empirical band only — stacking a variance floor on top of valid
            # quantiles systematically over-covers (max of two ~80% bands).
            low = np.maximum(0.0, expected + self._q10)
            high = expected + self._q90
            # integer daily units: a band thinner than 1 unit is meaningless
            high = np.maximum(high, low + 1.0)
        else:
            # Too little history for quantiles: fall back to the NB floor so
            # the band is never degenerate.
            floor = _band_floor(expected)
            low = np.maximum(0.0, expected - floor)
            high = expected + floor
        return pd.DataFrame({"date": dates, "expected": expected, "low": low, "high": high})


# v0 bracket stand-in (see module docstring): a fixed assumption used when no
# fit exists. Point and range chosen to match the PRD's "conservative /
# expected / aggressive" scenario framing for DTC goods.
BRACKET_POINT = -1.2
BRACKET_LOW = -2.2  # more price-sensitive scenario
BRACKET_HIGH = -0.6  # less price-sensitive scenario


class BracketElasticity:
    """Assumption-tier incumbent: fixed elasticity bracket, ignores the data.

    Output carries the `elasticity_fit` contract fields (BUILD_BRIEF §3);
    ``fitted_at`` is supplied by the caller at write time so this module stays
    deterministic.
    """

    model_version = "bracket-v0-standin-0.1"

    def estimate(self, history: pd.DataFrame, fitted_at: str | None = None) -> dict:
        price = history["price_cents"].to_numpy(dtype=float) if "price_cents" in history.columns else np.array([])
        variation = float((price.max() - price.min()) / price.mean() * 100.0) if price.size and price.mean() > 0 else 0.0
        return {
            "elasticity": BRACKET_POINT,
            "low": BRACKET_LOW,
            "high": BRACKET_HIGH,
            "se": None,
            "n_obs": int(len(history)),
            "price_variation_pct": variation,
            "confidence": "assumption",
            "model_version": self.model_version,
            "fitted_at": fitted_at,
        }
