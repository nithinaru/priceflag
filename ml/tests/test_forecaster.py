"""C3 baseline forecaster: promo-clean level correctness, floor semantics,
band contract shape, and the R28 gate against both incumbents."""

import json
import pathlib

import jsonschema
import numpy as np
import pandas as pd
import pytest

from priceflag_ml.forecaster import (
    CleanLevelBaseline,
    ETSCandidate,
    LGBMCandidate,
    bands_contract_rows,
)
from priceflag_ml.golden import GoldenConfig, generate_store
from priceflag_ml.harness import rolling_origin_backtest, run_c3


def _frame(units, promo=None, stockout=None, start="2026-01-05"):
    n = len(units)
    return pd.DataFrame(
        {
            "date": pd.date_range(start, periods=n, freq="D"),
            "units": units,
            "promo": promo if promo is not None else np.zeros(n, bool),
            "stockout": stockout if stockout is not None else np.zeros(n, bool),
        }
    )


def test_promo_days_do_not_inflate_the_level():
    """The core win over the incumbent: a big promo spike in the window must
    not raise the expected level for ordinary days."""
    units = np.full(70, 10.0)
    promo = np.zeros(70, bool)
    promo[40:47] = True
    units[40:47] = 30.0  # promo week triples demand
    fc = CleanLevelBaseline().fit(_frame(units, promo=promo)).forecast(7)
    assert fc["expected"].to_numpy() == pytest.approx(np.full(7, 10.0), rel=0.05)


def test_stockout_days_do_not_drag_the_level():
    units = np.full(70, 10.0)
    stockout = np.zeros(70, bool)
    stockout[60:65] = True
    units[60:65] = 0.0
    fc = CleanLevelBaseline().fit(_frame(units, stockout=stockout)).forecast(7)
    assert fc["expected"].to_numpy() == pytest.approx(np.full(7, 10.0), rel=0.05)


def test_dow_profile_carries_into_forecast():
    week = np.array([10.0, 10, 10, 10, 10, 30, 30])  # weekend triple
    fc = CleanLevelBaseline().fit(_frame(np.tile(week, 10))).forecast(7)
    by_dow = dict(zip(pd.DatetimeIndex(fc["date"]).weekday, fc["expected"]))
    assert by_dow[5] > 2 * by_dow[0]  # Saturday >> Monday


def test_low_volume_floor_and_flag():
    fc = CleanLevelBaseline().fit(_frame(np.ones(60))).forecast(7)
    assert (fc["expected"] < 3).all()
    assert fc["is_floored"].all()
    assert (fc["low"] == 0).all()
    assert (fc["high"] > fc["expected"]).all()


def test_all_promo_history_falls_back_to_incumbent():
    units = np.full(60, 12.0)
    fc = CleanLevelBaseline().fit(_frame(units, promo=np.ones(60, bool))).forecast(7)
    assert len(fc) == 7  # served, via the BracketBand fallback
    assert (fc["expected"] >= 0).all()


def test_band_low_never_negative_high_never_below_expected():
    rng = np.random.default_rng(2)
    fc = CleanLevelBaseline().fit(_frame(rng.poisson(6.0, 90))).forecast(14)
    assert (fc["low"] >= 0).all()
    assert (fc["high"] >= fc["expected"]).all()
    assert (fc["low"] <= fc["expected"]).all()


def test_bands_contract_rows_validate_against_schema():
    schema = json.loads(
        (pathlib.Path(__file__).resolve().parents[2] / "contracts" / "expected_band.schema.json").read_text()
    )
    fc = CleanLevelBaseline().fit(_frame(np.random.default_rng(1).poisson(8, 90))).forecast(14)
    rows = bands_contract_rows(
        fc,
        shop_domain="golden.myshopify.com",
        variant_gid="gid://shopify/ProductVariant/123",
        generated_at="2026-07-29T00:00:00Z",
    )
    validator = jsonschema.Draft202012Validator(schema)
    for row in rows:
        validator.validate(row)
    assert len(rows) == 14


def test_challenger_candidates_still_run():
    """ETS and LGBM lost the gate but stay scorable challengers — keep their
    fit/forecast paths from rotting."""
    df = _frame(np.random.default_rng(0).poisson(9, 120))
    for cls in (ETSCandidate, LGBMCandidate):
        fc = cls().fit(df).forecast(7)
        assert list(fc.columns) == ["date", "expected", "low", "high"]
        assert np.isfinite(fc[["expected", "low", "high"]].to_numpy()).all()


def test_backtest_integration_on_golden():
    store = generate_store(GoldenConfig(n_skus=8, days=140, seed=5))
    agg = rolling_origin_backtest(store.orders, CleanLevelBaseline, horizon=7, n_origins=2)["aggregate"]
    assert 0.0 < agg["median_wape"] < 1.5
    assert 0.60 <= agg["pooled_coverage_80"] <= 0.95


def test_r28_gate_beats_both_incumbents_full_verdict():
    """The EXACT shipped 5-seed verdict — and a staleness pin: the committed
    snapshot must match what the code produces today. A model change that
    flips or drifts the verdict fails here, not silently."""
    report = run_c3()
    s = report["summary"]
    assert s["verdict"] == "challenger wins", s
    assert s["win_rate_vs_bracket_band"] > 0.5, s
    assert s["win_rate_vs_seasonal_naive"] >= 0.7, s
    # calibration is gated where rollback can actually fire
    assert abs(s["nonfloored_coverage_80"] - 0.80) <= 0.10, s
    assert s["per_sku_coverage_p10"] >= 0.65, s

    snapshot = json.loads(
        (pathlib.Path(__file__).resolve().parents[1] / "eval" / "c3_baseline.json").read_text()
    )["summary"]
    for key, value in snapshot.items():
        got = s[key]
        if isinstance(value, float):
            assert got == pytest.approx(value, abs=1e-9), f"{key}: snapshot {value} vs current {got}"
        else:
            assert got == value, f"{key}: snapshot {value} vs current {got}"
