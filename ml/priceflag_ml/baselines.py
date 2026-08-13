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
   transparent bracket math. Constants below are reconciled to the app's
   canonical fallback (lib/engine/forecast.ts DEFAULT_ELASTICITY_*) and must
   stay in lockstep with it. This is the incumbent for C2's fitted elasticity.
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
            # Clamped so the band always brackets its own point forecast
            # (after a level collapse the empirical q10 can go positive).
            low = np.clip(expected + self._q10, 0.0, expected)
            high = np.maximum(expected + self._q90, expected)
            # integer daily units: a band thinner than 1 unit is meaningless
            high = np.maximum(high, low + 1.0)
        else:
            # Too little history for quantiles: fall back to the NB floor so
            # the band is never degenerate.
            floor = _band_floor(expected)
            low = np.maximum(0.0, expected - floor)
            high = expected + floor
        return pd.DataFrame({"date": dates, "expected": expected, "low": low, "high": high})


class BracketBand:
    """Faithful Python port of Lane B's `lib/engine/bands.ts` fallback band —
    the band incumbent C3's fitted forecasters must beat (their words: "worth
    porting into your harness as a scorable baseline").

    Point: trailing 28-day mean, day-of-week mean shrunk toward the overall
    mean with prior strength 2. Interval: z80 * sqrt(max(sample_var, mean))
    (overdispersed-Poisson). Low edge floored to 0 when expected < 3 units
    (`floored`). Stockout days are NOT excluded — the TS incumbent does not
    see a stockout flag, and the port must score what actually ships.
    """

    model_version = "bracket-band-ts-port-1.0"
    WINDOW_DAYS = 28  # lib/contracts.ts BASELINE_WINDOW_DAYS
    MIN_EXPECTED = 3.0  # lib/contracts.ts DEFAULT_MIN_EXPECTED_UNITS
    DOW_PRIOR_STRENGTH = 2.0

    def __init__(self) -> None:
        self._history: pd.DataFrame | None = None

    def fit(self, history: pd.DataFrame) -> "BracketBand":
        if len(history) == 0:
            raise ValueError("BracketBand.fit: empty history")
        self._history = history.sort_values("date").reset_index(drop=True)
        return self

    def _band_for(self, target: pd.Timestamp) -> tuple[float, float, float]:
        df = self._history
        window = df[(df["date"] >= target - pd.Timedelta(days=self.WINDOW_DAYS)) & (df["date"] < target)]
        if len(window) == 0:
            return 0.0, 0.0, 0.0
        y = window["units"].to_numpy(dtype=float)
        overall = float(y.mean())
        same_dow = y[pd.DatetimeIndex(window["date"]).weekday.to_numpy() == target.weekday()]
        dow_mean = float(same_dow.mean()) if len(same_dow) else overall
        w = len(same_dow) / (len(same_dow) + self.DOW_PRIOR_STRENGTH)
        expected = w * dow_mean + (1 - w) * overall
        sample_var = float(y.var(ddof=1)) if len(y) >= 2 else 0.0
        sd = np.sqrt(max(sample_var, expected))
        low = 0.0 if expected < self.MIN_EXPECTED else max(0.0, expected - Z80 * sd)
        high = max(expected + Z80 * sd, expected)
        return expected, low, high

    def forecast(self, horizon: int) -> pd.DataFrame:
        if self._history is None:
            raise RuntimeError("fit() before forecast()")
        last = pd.Timestamp(self._history["date"].iloc[-1])
        dates = pd.date_range(last + pd.Timedelta(days=1), periods=horizon, freq="D")
        rows = [self._band_for(d) for d in dates]
        expected, low, high = (np.array(v) for v in zip(*rows))
        return pd.DataFrame({"date": dates, "expected": expected, "low": low, "high": high})


# Fixed assumption bracket used when no fit exists. NOTE (post-B1): Lane B's
# real fallback (`lib/engine/forecast.ts`) carries NO elasticity at all — it is
# pure breakeven arithmetic plus a scenario grid, and `assumption` means "no
# estimate". These constants therefore live on only as (a) the EB prior
# fallback for stores with too few identifiable SKUs and (b) a scorable
# strawman on the recovery harness — they are never served as if they were v0's.
#
# CANONICAL VALUES: these mirror the app's fallback elasticity constants
# (DEFAULT_ELASTICITY / DEFAULT_ELASTICITY_LOW / DEFAULT_ELASTICITY_HIGH in
# lib/engine/forecast.ts, and FALLBACK_ELASTICITY in lib/evaluator/index.ts).
# The app is the source of truth — keep these in lockstep with it.
BRACKET_POINT = -1.5
BRACKET_LOW = -2.5  # more price-sensitive scenario
BRACKET_HIGH = -0.5  # less price-sensitive scenario


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
