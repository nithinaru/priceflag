"""Elasticity v1: IRLS correctness, honest degradation, contract shape, and
the R28 gate against the bracket incumbent."""

import numpy as np
import pandas as pd
import pytest

import priceflag_ml.elasticity as E
from priceflag_ml.baselines import BRACKET_POINT, BracketElasticity
from priceflag_ml.elasticity import (
    RidgeElasticity,
    _poisson_irls,
    fit_store,
    fits_frame,
)
from priceflag_ml.golden import GoldenConfig, generate_store
from priceflag_ml.harness import evaluate_elasticity


def _sku_frame(days, price, units, promo=None, start="2026-01-05"):
    dates = pd.date_range(start, periods=days, freq="D")
    return pd.DataFrame(
        {
            "sku": "T",
            "date": dates,
            "units": units,
            "price_cents": price,
            "revenue_cents": np.asarray(units) * np.asarray(price),
            "promo": promo if promo is not None else np.zeros(days, bool),
            "stockout": np.zeros(days, bool),
        }
    )


def test_poisson_irls_recovers_known_coefficients():
    rng = np.random.default_rng(5)
    n = 800
    x = rng.normal(size=n)
    X = np.column_stack([np.ones(n), x])
    mu = np.exp(1.0 - 1.5 * x)
    y = rng.poisson(mu).astype(float)
    beta = _poisson_irls(X, y)
    assert beta is not None
    assert beta[0] == pytest.approx(1.0, abs=0.05)
    assert beta[1] == pytest.approx(-1.5, abs=0.05)


def test_no_price_variation_degrades_to_assumption():
    days = 120
    df = _sku_frame(days, np.full(days, 5000), np.random.default_rng(0).poisson(8, days))
    fits = fit_store(df)
    assert len(fits) == 1
    f = fits[0]
    assert f.confidence == "assumption"
    assert f.elasticity == BRACKET_POINT
    assert f.se is None
    assert "assumption" in f.explanation or "can't measure" in f.explanation


def test_promo_only_variation_degrades_to_assumption():
    """Price cuts that only ever happen during promos are confounded — the
    honest answer is `assumption`, not a fake fit."""
    days = 120
    price = np.full(days, 5000)
    promo = np.zeros(days, bool)
    promo[30:37] = True
    promo[80:87] = True
    price[promo] = 4000
    df = _sku_frame(days, price, np.random.default_rng(1).poisson(8, days), promo=promo)
    fits = fit_store(df)
    assert fits[0].confidence == "assumption"
    assert fits[0].elasticity == BRACKET_POINT


def test_fit_store_deterministic():
    store = generate_store(GoldenConfig(n_skus=6, days=120, seed=3))
    a = fits_frame(fit_store(store.orders, seed=0))
    b = fits_frame(fit_store(store.orders, seed=0))
    pd.testing.assert_frame_equal(a, b)


def test_fits_frame_contract_columns():
    store = generate_store(GoldenConfig(n_skus=4, days=100, seed=9))
    df = fits_frame(fit_store(store.orders), fitted_at="2026-07-29T00:00:00Z")
    assert list(df.columns) == [
        "sku",
        "elasticity",
        "low",
        "high",
        "se",
        "n_obs",
        "price_variation_pct",
        "confidence",
        "explanation",
        "model_version",
        "fitted_at",
    ]
    assert df["confidence"].isin(["fitted", "partial", "assumption"]).all()
    assert (df["elasticity"] < 0).all()
    assert (df["low"] <= df["elasticity"]).all()
    assert (df["elasticity"] <= df["high"]).all()
    assert (df["model_version"] == E.MODEL_VERSION).all()
    assert (df["fitted_at"] == "2026-07-29T00:00:00Z").all()
    assert df["explanation"].str.len().gt(20).all()


def test_contract_rows_validate_against_lane_b_schema():
    """Every emitted row must validate against Lane B's committed
    elasticity_fit.schema.json (additionalProperties: false — a stray field
    or a missing required one fails loudly here, not in Lane B's writer)."""
    import json
    import pathlib

    import jsonschema

    schema = json.loads(
        (pathlib.Path(__file__).resolve().parents[2] / "contracts" / "elasticity_fit.schema.json").read_text()
    )
    store = generate_store(GoldenConfig(n_skus=6, days=120, seed=3))
    fits = fit_store(store.orders, seed=0)
    gids = {f.sku: f"gid://shopify/ProductVariant/{1000 + i}" for i, f in enumerate(fits)}
    rows = E.fits_contract_rows(
        fits,
        shop_domain="golden.myshopify.com",
        fitted_at="2026-07-29T00:00:00Z",
        variant_gids=gids,
        window_start="2026-03-04",
        window_end="2026-07-01",
    )
    assert len(rows) == len(fits)
    validator = jsonschema.Draft202012Validator(schema)
    for row in rows:
        validator.validate(row)
    # Interval bounds ship on every row whose fit has finite bounds (all of
    # them here), together and at the CI80 nominal coverage — Lane B's
    # forecast prefers these verbatim over deriving a range from `se`.
    for row, fit in zip(rows, fits):
        assert "low" in row and "high" in row, "bounds must be sent together"
        assert row["interval"] == 0.80
        assert row["low"] == fit.low
        assert row["high"] == fit.high
        assert row["low"] <= row["elasticity"] <= row["high"]
        assert row["low"] < row["high"]
    tiers = {r["confidence"] for r in rows}
    assert tiers <= {"fitted", "partial", "assumption"}
    shrunk = [r for r in rows if r["confidence"] != "assumption"]
    assert all(0.0 <= r["shrinkage_weight"] <= 1.0 for r in shrunk)


def test_fits_frame_empty_keeps_contract_columns():
    df = fits_frame([])
    assert df.empty
    assert list(df.columns) == E.FITS_FRAME_COLUMNS


def test_estimate_unseen_sku_raises_clearly():
    store = generate_store(GoldenConfig(n_skus=2, days=60, seed=1))
    est = RidgeElasticity(store.orders, seed=0)
    ghost = store.orders.head(3).assign(sku="SKU-999")
    with pytest.raises(ValueError, match="SKU-999"):
        est.estimate(ghost)


def test_all_stockout_sku_degrades_with_honest_reason():
    days = 90
    df = _sku_frame(days, np.full(days, 5000), np.zeros(days, dtype=int))
    df["stockout"] = True
    f = fit_store(df)[0]
    assert f.confidence == "assumption"
    assert f.elasticity == BRACKET_POINT


def test_short_history_gets_history_explanation_not_price_one():
    """A 3-week-old product with a real price change must be told 'not enough
    history yet' — not the false claim that its prices never changed."""
    days = 21
    price = np.full(days, 5000)
    price[10:] = 6000
    df = _sku_frame(days, price, np.random.default_rng(4).poisson(9, days))
    f = fit_store(df)[0]
    assert f.confidence == "assumption"
    assert "enough sales history" in f.explanation
    assert "hasn't changed" not in f.explanation  # the false diagnosis


def test_dead_sku_never_reaches_fitted_tier():
    """All-zero sales with a historical price change: the likelihood is flat
    in price — must degrade to assumption, never claim a measured fit."""
    days = 90
    price = np.full(days, 5000)
    price[45:] = 5500
    df = _sku_frame(days, price, np.zeros(days, dtype=int))
    f = fit_store(df)[0]
    assert f.confidence == "assumption"
    assert "sales" in f.explanation.lower()


@pytest.fixture()
def fast_bootstrap(monkeypatch):
    """Trim the bootstrap for the slow golden-recovery tests (function-scoped
    monkeypatch: cannot leak into other tests)."""
    monkeypatch.setattr(E, "BOOTSTRAP_B", 60)


def test_beats_bracket_incumbent_on_golden(fast_bootstrap):
    """R28 gate: the SAME 5 seeds and win criteria as the shipped verdict
    (harness.run_c2 / eval/c2_elasticity.json), so a verdict-flipping
    regression fails here."""
    from priceflag_ml.harness import run_c2

    report = run_c2()
    s = report["summary"]
    assert s["verdict"] == "challenger wins", s
    assert s["challenger_within_0.3"] > s["incumbent_within_0.3"]
    assert s["challenger_mae"] <= s["incumbent_mae"] * 1.02
    # CI coverage falsifiable on BOTH sides: nominal 80% within +-13pts
    # (5-seed pooled estimate; both over- and under-coverage are defects)
    assert 0.67 <= s["ci80_coverage_of_truth"] <= 0.93, s["ci80_coverage_of_truth"]


@pytest.mark.parametrize("coverage", [0.66, 0.94])
def test_r28_promotion_rejects_miscalibrated_elasticity_intervals(coverage):
    """Accuracy cannot promote a model whose stated 80% range is dishonest."""
    from priceflag_ml.harness import elasticity_challenger_wins

    assert not elasticity_challenger_wins(
        {
            "challenger_within_0.3": 0.50,
            "incumbent_within_0.3": 0.30,
            "challenger_mae": 0.40,
            "incumbent_mae": 0.50,
            "ci80_coverage_of_truth": coverage,
        }
    )


def test_ci_coverage_at_production_bootstrap():
    """One seed at the shipped BOOTSTRAP_B=200: the coverage the product
    actually serves, not just the trimmed test configuration."""
    store = generate_store(GoldenConfig(seed=11))
    truth = dict(zip(store.truth["sku"], store.truth["elasticity"]))
    fits = fit_store(store.orders, seed=0)
    ci = [f.low <= truth[f.sku] <= f.high for f in fits if f.confidence != "assumption"]
    assert 0.6 <= np.mean(ci) <= 1.0, f"production-config CI coverage {np.mean(ci):.2f}"


def test_estimates_differentiate_skus(fast_bootstrap):
    """The whole point over the bracket: different SKUs get different numbers
    (the bracket gives everyone -1.2 forever)."""
    store = generate_store(GoldenConfig(seed=11))
    non_assumption = [f.elasticity for f in fit_store(store.orders, seed=0) if f.confidence != "assumption"]
    assert len(set(np.round(non_assumption, 3))) > 3


def _strong_signal_store(n_periphery=6):
    """A store engineered to earn the fitted tier honestly: high volume,
    two big permanent price changes, long clean history."""
    rng = np.random.default_rng(17)
    days = 180
    dates = pd.date_range("2026-01-05", periods=days, freq="D")
    frames = []
    price = np.full(days, 5000.0)
    price[60:] = 6000.0
    price[120:] = 4500.0
    mu = 40.0 * (price / 5000.0) ** -1.5
    units = rng.poisson(mu)
    frames.append(
        pd.DataFrame(
            {
                "sku": "HERO",
                "date": dates,
                "units": units,
                "price_cents": price.astype(int),
                "revenue_cents": (units * price).astype(int),
                "promo": False,
                "stockout": False,
            }
        )
    )
    for i in range(n_periphery):
        p = np.full(days, 4000.0)
        p[90:] = 4600.0
        m = 20.0 * (p / 4000.0) ** -1.4
        u = rng.poisson(m)
        frames.append(
            pd.DataFrame(
                {
                    "sku": f"P{i}",
                    "date": dates,
                    "units": u,
                    "price_cents": p.astype(int),
                    "revenue_cents": (u * p).astype(int),
                    "promo": False,
                    "stockout": False,
                }
            )
        )
    return pd.concat(frames, ignore_index=True)


def test_fitted_tier_reachable_and_accurate(fast_bootstrap):
    """The fitted tier must actually occur for a strong-signal SKU and its
    estimate must be close to truth — otherwise the tier is dead code."""
    fits = {f.sku: f for f in fit_store(_strong_signal_store(), seed=0)}
    hero = fits["HERO"]
    assert hero.confidence == "fitted", (hero.confidence, hero.explanation, hero.se)
    assert hero.elasticity == pytest.approx(-1.5, abs=0.4)
    assert "Measured" in hero.explanation


def test_wrong_sign_raw_fit_cannot_be_fitted_tier(fast_bootstrap):
    """A price change coinciding with an unflagged demand surge produces a
    wrong-sign raw fit. It must be served as partial (with vacated precision),
    never as a confident 'measured' near-zero elasticity."""
    days = 180
    dates = pd.date_range("2026-01-05", periods=days, freq="D")
    rng = np.random.default_rng(3)
    price = np.full(days, 5000.0)
    price[90:] = 5750.0
    mu = 15.0 * (price / 5000.0) ** -1.2
    mu[90:] *= 2.0  # unflagged marketing surge exactly at the price change
    units = rng.poisson(mu)
    surge = pd.DataFrame(
        {
            "sku": "SURGE",
            "date": dates,
            "units": units,
            "price_cents": price.astype(int),
            "revenue_cents": (units * price).astype(int),
            "promo": False,
            "stockout": False,
        }
    )
    store = pd.concat([surge, _strong_signal_store(4)], ignore_index=True)
    f = {x.sku: x for x in fit_store(store, seed=0)}["SURGE"]
    if f.raw_elasticity is not None and f.raw_elasticity > 0:
        assert f.confidence != "fitted"
        assert f.low <= -1.2 <= f.high or f.se is None or f.se > 0.4
