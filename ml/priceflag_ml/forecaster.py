"""C3: fitted baseline demand forecaster — expected units per SKU x day with
NO price change, plus honest 80% intervals. Feeds the evaluator's
`expected_bands`; band calibration drives auto-rollback (R29), so interval
honesty is a safety property here, not a nicety.

Champion: ``CleanLevelBaseline`` — a promo-aware day-of-week level model:

1. restrict to *clean* days (non-promo, non-stockout) in a trailing 56-day
   window — the single biggest win over the incumbent, whose trailing mean
   inhales promo spikes and then over-expects for weeks;
2. multiplicative weekday profile (smoothed);
3. exponentially-weighted level on the deseasonalized clean days
   (half-life 14 days), which tracks slow trend/seasonal drift;
4. 80% band: z80 * sqrt(max(clean-residual variance, expected)) — the
   incumbent's overdispersed-Poisson family, calibrated on clean days;
   low edge floored to 0 when expected < 3 units (`is_floored`, matching
   the evaluator's "a plausible zero is not a breach" semantics).

Selected on the harness over statsmodels ETS, LightGBM, and a per-SKU
champion-selection ensemble — all three lost to the shipped bracket band or
barely tied it; scores and reasons in ml/MODELS.md (R28: losers recorded,
not deployed). ``ETSCandidate`` and ``LGBMCandidate`` remain here as scorable
challengers for future sprints.

Future promo days are forecast as non-promo (the merchant's promo calendar is
unknown at band-generation time); the evaluator treats promo-day breaches via
guardrail scope, not the baseline band.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .baselines import Z80, BracketBand

MODEL_VERSION = "baseline-cleanlevel-1.0"

MIN_EXPECTED_FLOOR = 3.0  # matches lib/contracts DEFAULT_MIN_EXPECTED_UNITS
LEVEL_WINDOW_DAYS = 56
LEVEL_HALFLIFE_DAYS = 14.0
MIN_CLEAN_DAYS = 7  # below this, serve the incumbent band instead
# In-window residual variance understates true forecast error (in-sample
# residuals + EW level-estimation error). Calibrated on 5 golden seeds so the
# NON-FLOORED days — the ones that can actually fire a rollback — cover at
# nominal: 1.0 -> 0.736 non-floored coverage, 1.15 -> 0.791, per-SKU p10 of
# coverage 0.643 -> 0.713.
BAND_SD_INFLATION = 1.15


def _impute_stockouts(df: pd.DataFrame) -> pd.DataFrame:
    """Replace stockout-day units with NaN then interpolate: a stockout day is
    missing demand, not zero demand."""
    if "stockout" not in df.columns or not df["stockout"].any():
        return df
    out = df.copy()
    units = out["units"].astype(float).where(~out["stockout"], np.nan)
    out["units"] = units.interpolate(limit_direction="both").fillna(0.0)
    return out


def _clean_days(df: pd.DataFrame) -> pd.DataFrame:
    mask = np.ones(len(df), dtype=bool)
    if "promo" in df.columns:
        mask &= ~df["promo"].to_numpy(dtype=bool)
    if "stockout" in df.columns:
        mask &= ~df["stockout"].to_numpy(dtype=bool)
    return df[mask]


def _dow_profile(df: pd.DataFrame, alpha: float = 0.5) -> np.ndarray:
    """Multiplicative weekday profile, smoothed so empty weekdays stay sane."""
    weekday = pd.DatetimeIndex(df["date"]).weekday.to_numpy()
    y = df["units"].to_numpy(dtype=float)
    overall = y.mean() if len(y) else 0.0
    profile = np.ones(7)
    for wd in range(7):
        vals = y[weekday == wd]
        if len(vals):
            profile[wd] = (vals.mean() + alpha) / (overall + alpha) if overall > 0 else 1.0
    return np.clip(profile, 0.2, 5.0)


class CleanLevelBaseline:
    """Champion baseline forecaster (see module docstring)."""

    model_version = MODEL_VERSION

    def __init__(self, window: int = LEVEL_WINDOW_DAYS, halflife: float = LEVEL_HALFLIFE_DAYS) -> None:
        self._window = window
        self._halflife = halflife
        self._last_date: pd.Timestamp | None = None
        self._profile: np.ndarray | None = None
        self._level = 0.0
        self._resid_var = 0.0
        self._fallback: BracketBand | None = None

    def fit(self, history: pd.DataFrame) -> "CleanLevelBaseline":
        if len(history) == 0:
            raise ValueError("CleanLevelBaseline.fit: empty history")
        # Full reset: a reused instance must never serve state (fallback,
        # profile, level) from a previous fit.
        self._fallback = None
        self._profile = None
        self._level = 0.0
        self._resid_var = 0.0
        df = history.sort_values("date").reset_index(drop=True)
        self._last_date = pd.Timestamp(df["date"].iloc[-1])
        # Trailing CALENDAR window, not "last N clean rows ever": old clean
        # days must not masquerade as a current level — a months-stale level
        # miscenters the band and manufactures false rollbacks (R29).
        window_start = self._last_date - pd.Timedelta(days=self._window)
        clean = _clean_days(df[df["date"] > window_start])
        if len(clean) < MIN_CLEAN_DAYS:
            # Nearly no recent clean history (all-promo or all-stockout):
            # pretending to a fitted level would be dishonest — serve the
            # incumbent.
            self._fallback = BracketBand().fit(df)
            return self

        self._profile = _dow_profile(clean)
        weekday = pd.DatetimeIndex(clean["date"]).weekday.to_numpy()
        deseason = clean["units"].to_numpy(dtype=float) / self._profile[weekday]
        age = (self._last_date - pd.DatetimeIndex(clean["date"])).days.to_numpy(dtype=float)
        w = 0.5 ** (age / self._halflife)
        self._level = float(np.sum(w * deseason) / np.sum(w))

        resid = clean["units"].to_numpy(dtype=float) - self._level * self._profile[weekday]
        self._resid_var = float(np.var(resid, ddof=1)) if len(resid) >= 2 else 0.0
        return self

    def forecast(self, horizon: int) -> pd.DataFrame:
        if self._fallback is not None:
            fc = self._fallback.forecast(horizon)
            # The bracket band returns a degenerate (0,0,0) once the target
            # is > 28 days past the end of history (empty trailing window).
            # Beyond that, repeat the same-weekday band from the last valid
            # week rather than emitting "expected 0" as if it were data.
            expected = fc["expected"].to_numpy().copy()
            low = fc["low"].to_numpy().copy()
            high = fc["high"].to_numpy().copy()
            for i in range(len(fc)):
                if i >= 7 and expected[i] == 0.0 and high[i] == 0.0:
                    expected[i], low[i], high[i] = expected[i - 7], low[i - 7], high[i - 7]
            fc["expected"], fc["low"], fc["high"] = expected, low, high
            fc["is_floored"] = fc["expected"] < MIN_EXPECTED_FLOOR
            return fc
        if self._last_date is None:
            raise RuntimeError("fit() before forecast()")
        dates = pd.date_range(self._last_date + pd.Timedelta(days=1), periods=horizon, freq="D")
        expected = np.maximum(self._level * self._profile[dates.weekday.to_numpy()], 0.0)
        # Overdispersed-Poisson band (same family as the incumbent's), but
        # with the spread estimated from CLEAN-day residuals so promo spikes
        # don't widen the band that guards non-promo days.
        sd = BAND_SD_INFLATION * np.sqrt(np.maximum(self._resid_var, expected))
        floored = expected < MIN_EXPECTED_FLOOR
        low = np.where(floored, 0.0, np.maximum(0.0, expected - Z80 * sd))
        high = np.maximum(expected + Z80 * sd, expected)
        # Never a degenerate band: an all-zero clean window must still admit
        # a Poisson-plausible first sale without flagging an above-band breach.
        high = np.maximum(high, low + 1.0)
        return pd.DataFrame(
            {"date": dates, "expected": expected, "low": low, "high": high, "is_floored": floored}
        )


class ETSCandidate:
    """Recorded challenger: weekday profile x damped-trend exponential
    smoothing (statsmodels). Lost the C3 gate — kept scorable, not served."""

    name = "ets"

    def fit(self, history: pd.DataFrame) -> "ETSCandidate":
        from statsmodels.tsa.holtwinters import ExponentialSmoothing

        df = _impute_stockouts(history.sort_values("date").reset_index(drop=True))
        self._last_date = pd.Timestamp(df["date"].iloc[-1])
        self._profile = _dow_profile(df)
        weekday = pd.DatetimeIndex(df["date"]).weekday.to_numpy()
        deseason = df["units"].to_numpy(dtype=float) / self._profile[weekday]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                model = ExponentialSmoothing(
                    deseason, trend="add", damped_trend=True, initialization_method="estimated"
                ).fit(optimized=True)
                self._forecast_level = model.forecast
            except Exception:  # singular series (e.g. all zeros): flat level
                mean_level = float(np.mean(deseason))
                self._forecast_level = lambda h: np.full(h, mean_level)
        return self

    def forecast(self, horizon: int) -> pd.DataFrame:
        dates = pd.date_range(self._last_date + pd.Timedelta(days=1), periods=horizon, freq="D")
        level = np.asarray(self._forecast_level(horizon), dtype=float)
        expected = np.maximum(level * self._profile[dates.weekday.to_numpy()], 0.0)
        sd = np.sqrt(expected + 1.0)
        low = np.maximum(0.0, expected - Z80 * sd)
        high = expected + Z80 * sd
        return pd.DataFrame({"date": dates, "expected": expected, "low": low, "high": high})


class LGBMCandidate:
    """Recorded challenger: LightGBM Poisson on dow/trend/promo with
    origin-frozen level features (direct multi-step, no recursion, no
    leakage). Lost the C3 gate — kept scorable, not served."""

    name = "lgbm"

    @staticmethod
    def _levels(units: pd.Series) -> tuple[pd.Series, pd.Series]:
        rm7 = units.shift(1).rolling(7, min_periods=3).mean()
        rm28 = units.shift(1).rolling(28, min_periods=7).mean()
        return rm7, rm28

    def fit(self, history: pd.DataFrame) -> "LGBMCandidate":
        import lightgbm as lgb

        df = history.sort_values("date").reset_index(drop=True)
        self._first_date = pd.Timestamp(df["date"].iloc[0])
        self._last_date = pd.Timestamp(df["date"].iloc[-1])
        imputed = _impute_stockouts(df)
        units = imputed["units"].astype(float)
        rm7, rm28 = self._levels(units)
        weekday = pd.DatetimeIndex(df["date"]).weekday.to_numpy()
        day_idx = (pd.DatetimeIndex(df["date"]) - self._first_date).days.to_numpy(dtype=float)
        promo = df["promo"].to_numpy(dtype=float) if "promo" in df.columns else np.zeros(len(df))
        stockout = df["stockout"].to_numpy(dtype=bool) if "stockout" in df.columns else np.zeros(len(df), bool)

        X = np.column_stack([weekday, day_idx, promo, rm7.to_numpy(), rm28.to_numpy()])
        keep = ~np.isnan(X).any(axis=1) & ~stockout
        if keep.sum() < 28:
            # Degrade to a flat mean level (like ETS's singular-series branch)
            # instead of raising: one stockout-heavy SKU must not abort a
            # whole harness re-scoring run.
            mean_level = float(units[~stockout].mean()) if (~stockout).any() else 0.0
            self._model = None
            self._flat_level = mean_level
            self._frozen = (mean_level, mean_level)
            self._last_day_idx = float(day_idx[-1]) if len(day_idx) else 0.0
            return self
        self._model = lgb.LGBMRegressor(
            objective="poisson",
            n_estimators=200,
            learning_rate=0.05,
            num_leaves=15,
            min_child_samples=10,
            deterministic=True,
            n_jobs=1,
            random_state=0,
            verbose=-1,
        ).fit(X[keep], units.to_numpy()[keep], categorical_feature=[0])
        self._frozen = (
            float(rm7.iloc[-1]) if np.isfinite(rm7.iloc[-1]) else float(units.mean()),
            float(rm28.iloc[-1]) if np.isfinite(rm28.iloc[-1]) else float(units.mean()),
        )
        self._last_day_idx = float(day_idx[-1])
        return self

    def forecast(self, horizon: int) -> pd.DataFrame:
        dates = pd.date_range(self._last_date + pd.Timedelta(days=1), periods=horizon, freq="D")
        if self._model is None:
            expected = np.full(horizon, self._flat_level)
        else:
            rm7, rm28 = self._frozen
            X = np.column_stack(
                [
                    dates.weekday.to_numpy(dtype=float),
                    self._last_day_idx + np.arange(1, horizon + 1, dtype=float),
                    np.zeros(horizon),  # future promo calendar unknown -> assume none
                    np.full(horizon, rm7),
                    np.full(horizon, rm28),
                ]
            )
            expected = np.maximum(self._model.predict(X), 0.0)
        sd = np.sqrt(expected + 1.0)
        low = np.maximum(0.0, expected - Z80 * sd)
        high = expected + Z80 * sd
        return pd.DataFrame({"date": dates, "expected": expected, "low": low, "high": high})


def bands_contract_rows(
    forecast: pd.DataFrame,
    shop_domain: str,
    variant_gid: str,
    generated_at: str,
    model_version: str = MODEL_VERSION,
) -> list[dict]:
    """`expected_band.schema.json`-shaped rows (band_kind=baseline) for one SKU.

    Enforces the schema's cross-field invariant (low <= expected_units <=
    high) that jsonschema itself cannot check — a band violating it must fail
    loudly here, never reach the evaluator.
    """
    bad = (forecast["low"] > forecast["expected"]) | (forecast["expected"] > forecast["high"])
    if bad.any():
        first = forecast[bad].iloc[0]
        raise ValueError(
            f"band violates low <= expected <= high on {pd.Timestamp(first['date']).date()}: "
            f"low={first['low']}, expected={first['expected']}, high={first['high']}"
        )
    rows = []
    for rec in forecast.itertuples():
        rows.append(
            {
                "contract_version": "1.0.0",
                "shop_domain": shop_domain,
                "variant_gid": variant_gid,
                "day": str(pd.Timestamp(rec.date).date()),
                "expected_units": float(rec.expected),
                "low": float(rec.low),
                "high": float(rec.high),
                "interval": 0.8,
                "band_kind": "baseline",
                "rollout_id": None,
                "is_floored": bool(getattr(rec, "is_floored", False)),
                "model_version": model_version,
                "generated_at": generated_at,
            }
        )
    return rows
