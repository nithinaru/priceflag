"""Golden generator: determinism, shape, and — critically — that the data
actually embodies its own ground truth (elasticity, promos, stockouts)."""

import numpy as np
import pandas as pd
import pytest

from priceflag_ml.golden import (
    DOW_BASE,
    GoldenConfig,
    SkuTruth,
    expected_units,
    generate_store,
    simulate_sku,
)

CFG = GoldenConfig(n_skus=12, days=140, seed=42)


@pytest.fixture(scope="module")
def store():
    return generate_store(CFG)


def test_deterministic(store):
    again = generate_store(CFG)
    pd.testing.assert_frame_equal(store.orders, again.orders)
    pd.testing.assert_frame_equal(store.truth, again.truth)


# SHA256 of the default-config golden orders CSV. The committed incumbent bar
# (ml/eval/c1_incumbents.json) is only meaningful against THIS exact data. If
# this test fails after a numpy/pandas bump or a generator edit, the golden
# universe changed: re-run `python -m priceflag_ml.harness`, re-baseline
# eval/c1_incumbents.json + MODELS.md, and update this hash in the same commit.
GOLDEN_SNAPSHOT_SHA256 = "a733babfb9ec7f0c75c17ccb205c17b08c20f70ee3669fa8e1233bc969eacd7a"


def test_golden_snapshot_pinned():
    import hashlib

    default = generate_store()
    digest = hashlib.sha256(default.orders.to_csv(index=False).encode()).hexdigest()
    assert digest == GOLDEN_SNAPSHOT_SHA256, (
        "Default golden store changed — the committed incumbent scores no longer "
        "describe this data. Re-baseline (see comment above) deliberately."
    )


def test_shape_and_columns(store):
    assert list(store.orders.columns) == [
        "shop_id",
        "sku",
        "date",
        "units",
        "price_cents",
        "revenue_cents",
        "promo",
        "stockout",
    ]
    assert len(store.orders) == CFG.n_skus * CFG.days
    assert store.orders["units"].min() >= 0
    assert (store.orders["revenue_cents"] == store.orders["units"] * store.orders["price_cents"]).all()
    assert store.truth["elasticity"].between(-3.0, -0.3).all()


def test_stockout_days_have_zero_units(store):
    so = store.orders[store.orders["stockout"]]
    assert len(so) > 0, "golden store must contain stockout gaps (the harness must handle them)"
    assert (so["units"] == 0).all()


def test_promo_price_confound_present(store):
    """The generator's core trap: most promo windows cut price WHILE demand is
    lifted, so naive price regressions overestimate |elasticity|. At least
    some SKUs must show a promo-day price strictly below that SKU's modal
    (permanent) price — if this disappears, the trap is gone and C2's
    promo-control requirement is untested."""
    confounded = 0
    for sku, g in store.orders.groupby("sku"):
        on = g[g["promo"]]
        if len(on) == 0:
            continue
        modal_price = g["price_cents"].mode().iloc[0]
        if (on["price_cents"] < modal_price).any():
            confounded += 1
    assert confounded >= 2, "expected multiple SKUs with promo price cuts (price/demand confound)"


def _flat_sku(elasticity: float, price: np.ndarray, days: int, base_units: float = 300.0) -> SkuTruth:
    """A SKU with no seasonality/promo/trend/noise-confounds: isolates price effect."""
    return SkuTruth(
        sku="TEST",
        base_units=base_units,
        base_price_cents=5000,
        cogs_cents=2000,
        elasticity=elasticity,
        dow=np.ones(7),
        annual_amp=0.0,
        annual_phase=0.0,
        trend_daily=0.0,
        promo_uplift=1.0,
        dispersion_k=50.0,
        n_permanent_levels=int(len(np.unique(price))),
        price_cents=price.astype(int),
        promo=np.zeros(days, bool),
        stockout=np.zeros(days, bool),
    )


def test_price_change_moves_demand_by_true_elasticity():
    """After a +20% price step, realized mean units must shift by ~1.2^elasticity."""
    days = 400  # long series + high base volume so sampling noise is small
    price = np.full(days, 5000.0)
    price[days // 2 :] = 6000.0
    truth = _flat_sku(elasticity=-1.5, price=price, days=days)
    dates = pd.date_range("2025-01-01", periods=days, freq="D")
    df = simulate_sku(truth, dates, np.random.default_rng(0))

    before = df["units"][: days // 2].mean()
    after = df["units"][days // 2 :].mean()
    expected_ratio = 1.2**-1.5
    assert after / before == pytest.approx(expected_ratio, rel=0.05)


def test_expected_units_matches_formula():
    days = 14
    price = np.full(days, 5000.0)
    truth = _flat_sku(elasticity=-1.0, price=price, days=days, base_units=10.0)
    mu = expected_units(truth, np.arange(days), np.zeros(days, dtype=int))
    np.testing.assert_allclose(mu, 10.0)


def test_promo_days_lift_demand(store):
    """Across the store, promo days should show materially higher units than
    same-SKU non-promo days (uplift and usually a price cut both push up)."""
    orders = store.orders[~store.orders["stockout"]]
    promo_skus = orders.loc[orders["promo"], "sku"].unique()
    assert len(promo_skus) > 0, "golden store should contain promos"
    ratios = []
    for sku in promo_skus:
        g = orders[orders["sku"] == sku]
        on, off = g[g["promo"]], g[~g["promo"]]
        if len(on) >= 3 and off["units"].mean() > 0:
            ratios.append(on["units"].mean() / off["units"].mean())
    assert np.median(ratios) > 1.2


def test_history_richness_mix(store):
    """Both regimes must be represented: thin-history SKUs (one permanent
    price level — where estimators must degrade to `assumption` honestly)
    and SKUs with real permanent price variation (the identifiable slice)."""
    assert (store.truth["n_permanent_levels"] == 1).any()
    assert (store.truth["n_permanent_levels"] >= 2).any()
