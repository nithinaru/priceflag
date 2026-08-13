"""Incumbent behavior: seasonal-naive correctness, the ported bracket band,
and band sanity."""

import numpy as np
import pandas as pd
import pytest

from priceflag_ml.baselines import BracketBand, BracketElasticity, SeasonalNaive


def _daily_frame(units, start="2026-01-05"):  # 2026-01-05 is a Monday
    dates = pd.date_range(start, periods=len(units), freq="D")
    return pd.DataFrame({"date": dates, "units": units, "stockout": False})


def test_seasonal_naive_exact_on_periodic_series():
    week = [10, 12, 11, 13, 15, 20, 18]
    df = _daily_frame(week * 8)  # 8 clean weeks
    fc = SeasonalNaive().fit(df).forecast(14)
    expected = np.array(week * 2, dtype=float)
    np.testing.assert_allclose(fc["expected"].to_numpy(), expected)
    # perfectly periodic history -> residuals are 0, but the Poisson floor
    # must still give a non-degenerate band that contains the actuals
    assert (fc["low"] <= expected).all()
    assert (fc["high"] >= expected).all()
    assert (fc["high"] > fc["low"]).all()


def test_seasonal_naive_dates_continue_history():
    df = _daily_frame([5] * 28)
    fc = SeasonalNaive().fit(df).forecast(7)
    assert fc["date"].iloc[0] == df["date"].iloc[-1] + pd.Timedelta(days=1)
    assert len(fc) == 7


def test_seasonal_naive_nonnegative_low_band():
    rng = np.random.default_rng(3)
    df = _daily_frame(rng.poisson(0.4, size=90))  # very low volume SKU
    fc = SeasonalNaive().fit(df).forecast(14)
    assert (fc["low"] >= 0).all()
    assert (fc["high"] > 0).all()  # floored band never collapses to a point


def test_seasonal_naive_ignores_stockout_days():
    week = [10.0, 12, 11, 13, 15, 20, 18]
    df = _daily_frame(week * 8)
    # knock out the LAST two Mondays (inside the last-4 window the pattern is
    # built from): the zeros must not drag the Monday forecast down
    df.loc[df.index[[42, 49]], ["units", "stockout"]] = [0.0, True]
    fc = SeasonalNaive().fit(df).forecast(7)
    monday = fc.loc[pd.DatetimeIndex(fc["date"]).weekday == 0, "expected"].iloc[0]
    assert monday == pytest.approx(10.0)


def test_seasonal_naive_requires_fit():
    with pytest.raises(RuntimeError):
        SeasonalNaive().forecast(7)


def test_seasonal_naive_empty_history_raises():
    empty = pd.DataFrame({"date": pd.to_datetime([]), "units": [], "stockout": []})
    with pytest.raises(ValueError, match="empty history"):
        SeasonalNaive().fit(empty)


def test_seasonal_naive_all_stockout_history():
    df = _daily_frame([0] * 28)
    df["stockout"] = True
    fc = SeasonalNaive().fit(df).forecast(7)
    assert (fc["expected"] == 0).all()
    assert (fc["low"] >= 0).all()
    assert (fc["high"] > 0).all()  # floor keeps the band non-degenerate


def test_band_calibration_near_nominal_on_stationary_data():
    """Calibration is a safety property (R29): on clean stationary
    overdispersed data, the '80%' band must actually cover ~80% —
    not 90% (too wide: rollback never fires) and not 60% (whipsaw)."""
    rng = np.random.default_rng(123)
    hits = []
    for _ in range(60):
        mu, k = 15.0, 8.0
        y = rng.negative_binomial(k, k / (k + mu), size=126)
        df = _daily_frame(y)
        fc = SeasonalNaive().fit(df.iloc[:112]).forecast(14)
        actual = y[112:126]
        hits.extend((actual >= fc["low"].to_numpy()) & (actual <= fc["high"].to_numpy()))
    coverage = np.mean(hits)
    assert 0.70 <= coverage <= 0.90, f"80% band covered {coverage:.3f}"


def test_bracket_band_matches_ts_semantics():
    """Hand-checkable port of lib/engine/bands.ts: 28-day window, dow mean
    shrunk with prior strength 2, sd = sqrt(max(sample_var, expected))."""
    df = _daily_frame([10.0] * 28)  # constant series
    fc = BracketBand().fit(df).forecast(1)
    # constant history: overall = dow = expected = 10; var 0 -> sd sqrt(10)
    assert fc["expected"].iloc[0] == pytest.approx(10.0)
    assert fc["low"].iloc[0] == pytest.approx(10.0 - 1.2816 * np.sqrt(10.0), abs=1e-3)
    assert fc["high"].iloc[0] == pytest.approx(10.0 + 1.2816 * np.sqrt(10.0), abs=1e-3)


def test_bracket_band_dow_shrinkage_weighting():
    # 28 days ending Sunday 2026-02-01; forecast Monday 2026-02-02.
    dates = pd.date_range("2026-01-05", periods=28, freq="D")
    units = np.full(28, 7.0)
    units[dates.weekday == 0] = 21.0  # Mondays triple
    df = pd.DataFrame({"date": dates, "units": units, "stockout": False})
    fc = BracketBand().fit(df).forecast(1)
    assert pd.Timestamp(fc["date"].iloc[0]).weekday() == 0
    overall = units.mean()
    n_mon = int((dates.weekday == 0).sum())
    w = n_mon / (n_mon + 2)  # DOW_PRIOR_STRENGTH = 2
    assert fc["expected"].iloc[0] == pytest.approx(w * 21.0 + (1 - w) * overall)


def test_bracket_band_low_volume_floor():
    df = _daily_frame([0, 1, 0, 0, 1, 0, 0] * 4)  # expected < 3 units
    fc = BracketBand().fit(df).forecast(7)
    assert (fc["low"] == 0).all()  # floored: a plausible zero is not a breach
    assert (fc["high"] > 0).all()


def test_bracket_elasticity_is_fixed_assumption():
    df = _daily_frame([1, 2, 3])
    df["price_cents"] = [5000, 5000, 4000]
    est = BracketElasticity().estimate(df, fitted_at="2026-07-29T00:00:00Z")
    # Mirrors lib/engine/forecast.ts DEFAULT_ELASTICITY (app is canonical)
    assert est["elasticity"] == -1.5
    assert est["low"] < est["elasticity"] < est["high"]
    assert est["confidence"] == "assumption"
    assert est["model_version"].startswith("bracket-v0")
    # elasticity_fit contract fields (BUILD_BRIEF §3)
    assert est["n_obs"] == 3
    assert est["price_variation_pct"] == pytest.approx(1000 / (14000 / 3) * 100)
    assert est["fitted_at"] == "2026-07-29T00:00:00Z"
