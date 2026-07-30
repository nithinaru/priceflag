"""The harness itself is under test: plumbing correctness (an oracle scores
perfectly), score sanity on golden data, and the head-to-head comparator."""

import numpy as np
import pandas as pd
import pytest

from priceflag_ml.baselines import BracketElasticity, SeasonalNaive
from priceflag_ml.golden import GoldenConfig, generate_store
from priceflag_ml.harness import (
    compare_forecasters,
    evaluate_elasticity,
    rolling_origin_backtest,
    run_c1,
    sku_frames,
)

CFG = GoldenConfig(n_skus=12, days=140, seed=11)


@pytest.fixture(scope="module")
def store():
    return generate_store(CFG)


def test_sku_frames_partition(store):
    frames = sku_frames(store.orders)
    assert len(frames) == CFG.n_skus
    assert sum(len(f) for f in frames.values()) == len(store.orders)
    for f in frames.values():
        assert f["date"].is_monotonic_increasing


def test_backtest_structure_and_sanity(store):
    out = rolling_origin_backtest(store.orders, SeasonalNaive, horizon=7, n_origins=3)
    agg = out["aggregate"]
    assert agg["n_skus"] == CFG.n_skus
    assert 0.0 < agg["median_wape"] < 2.0
    # Calibration gate (R29 / C3 acceptance): the 80% band must land within
    # +-10pts of nominal on golden data. This is the safety property that
    # drives auto-rollback — a vacuous bound here lets a mis-calibrated
    # incumbent set a mis-calibrated bar.
    assert 0.70 <= agg["pooled_coverage_80"] <= 0.90
    assert agg["pooled_pinball_q10"] >= 0.0
    assert agg["pooled_pinball_q90"] >= 0.0
    # stockout days are never scored
    scored_days = agg["n_scored_days"]
    total_days = len(out["predictions"])
    n_stockout = int(out["predictions"]["stockout"].sum())
    assert scored_days == total_days - n_stockout


def test_backtest_raises_when_no_history():
    tiny = generate_store(GoldenConfig(n_skus=2, days=30, seed=1))
    with pytest.raises(ValueError):
        rolling_origin_backtest(tiny.orders, SeasonalNaive, horizon=14, min_train=63)


class _OracleForecaster:
    """Knows the actuals ahead of time — must score (near) perfectly.

    Proves the harness aligns forecasts with the right actuals by date.
    """

    def __init__(self, lookup):
        self._lookup = lookup
        self._last = None

    def fit(self, history):
        self._last = pd.Timestamp(history["date"].iloc[-1])
        self._sku = str(history["sku"].iloc[0])
        return self

    def forecast(self, horizon):
        dates = pd.date_range(self._last + pd.Timedelta(days=1), periods=horizon, freq="D")
        actual = np.array([self._lookup[(self._sku, d)] for d in dates], dtype=float)
        return pd.DataFrame(
            {"date": dates, "expected": actual, "low": np.maximum(0.0, actual - 0.5), "high": actual + 0.5}
        )


def test_oracle_scores_perfectly(store):
    lookup = {(r.sku, pd.Timestamp(r.date)): float(r.units) for r in store.orders.itertuples()}
    out = rolling_origin_backtest(store.orders, lambda: _OracleForecaster(lookup), horizon=7, n_origins=2)
    agg = out["aggregate"]
    assert agg["median_wape"] == pytest.approx(0.0)
    assert agg["pooled_coverage_80"] == pytest.approx(1.0)


def test_compare_forecasters_oracle_beats_naive(store):
    lookup = {(r.sku, pd.Timestamp(r.date)): float(r.units) for r in store.orders.itertuples()}
    res = compare_forecasters(
        store.orders, SeasonalNaive, lambda: _OracleForecaster(lookup), horizon=7, n_origins=2
    )
    assert res["challenger_win_rate"] == pytest.approx(1.0)
    assert res["median_wape_challenger"] < res["median_wape_champion"]


class _MisalignedForecaster(SeasonalNaive):
    """Classic off-by-one: forecast dates start AT the origin day."""

    def forecast(self, horizon):
        fc = super().forecast(horizon)
        fc["date"] = fc["date"] - pd.Timedelta(days=1)
        return fc


def test_backtest_rejects_misaligned_forecast_dates(store):
    with pytest.raises(ValueError, match="do not match"):
        rolling_origin_backtest(store.orders, _MisalignedForecaster, horizon=7, n_origins=1)


class _NaNBandForecaster(SeasonalNaive):
    def forecast(self, horizon):
        fc = super().forecast(horizon)
        fc.loc[fc.index[0], "high"] = float("nan")
        return fc


def test_backtest_rejects_nonfinite_bands(store):
    """NaN bands must never flow into the ship gate (they drive rollback)."""
    with pytest.raises(ValueError, match="non-finite"):
        rolling_origin_backtest(store.orders, _NaNBandForecaster, horizon=7, n_origins=1)


def test_backtest_rejects_gapped_history(store):
    gapped = store.orders[store.orders["units"] > 0]  # real order_days shape: no zero rows
    if len(gapped) == len(store.orders):  # pragma: no cover — golden always has zero days
        pytest.skip("no zero-unit days in this store")
    with pytest.raises(ValueError, match="one-row-per-day"):
        rolling_origin_backtest(gapped, SeasonalNaive, horizon=7, n_origins=1)


def test_evaluate_elasticity_oracle_recovers_exactly(store):
    truth = dict(zip(store.truth["sku"], store.truth["elasticity"]))

    def oracle(history: pd.DataFrame) -> dict:
        return {"elasticity": truth[str(history["sku"].iloc[0])]}

    out = evaluate_elasticity(oracle, store)
    assert out["all_skus"]["mae"] == pytest.approx(0.0)
    assert out["all_skus"]["pct_within_0.3"] == 1.0
    assert out["identifiable_skus"]["n"] >= 1


def test_evaluate_elasticity_bracket_baseline(store):
    out = evaluate_elasticity(BracketElasticity().estimate, store)
    assert out["all_skus"]["n"] == CFG.n_skus
    assert out["all_skus"]["mae"] > 0.0  # a constant guess cannot be perfect


def test_run_c1_report_shape():
    report = run_c1(GoldenConfig(n_skus=8, days=120, seed=5))
    inc = report["incumbents"]
    assert "seasonal_naive_backtest" in inc
    assert "bracket_elasticity_recovery" in inc
    assert 0.0 <= inc["seasonal_naive_backtest"]["pooled_coverage_80"] <= 1.0
    assert np.isfinite(inc["bracket_elasticity_recovery"]["all_skus"]["mae"])
