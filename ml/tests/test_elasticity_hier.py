"""C4 hierarchical elasticity: the implementation must be demonstrably
CORRECT (EM recovers known hyperparameters; borrowing works mechanically) so
that its recorded loss to C2 on the harness is a property of the data, not a
bug — and the losing verdict itself is pinned so a future flip is deliberate."""

import numpy as np
import pandas as pd
import pytest

import priceflag_ml.elasticity as E
from priceflag_ml.elasticity_hier import HierElasticity, _em_pool, fit_store_hier
from priceflag_ml.golden import GoldenConfig, generate_store
from priceflag_ml.harness import run_c4


def test_em_recovers_known_hyperparameters():
    """On clean two-level Gaussian data the EM must recover group means and
    tau — proving the estimator itself is sound."""
    rng = np.random.default_rng(0)
    n_per, tau = 200, 0.5
    mus = {0: -0.8, 1: -2.0}
    b, s2, groups = [], [], []
    for g, mu in mus.items():
        theta = rng.normal(mu, tau, n_per)
        se = rng.uniform(0.3, 0.6, n_per)
        b.extend(rng.normal(theta, se))
        s2.extend(se**2)
        groups.extend([g] * n_per)
    mu_hat, se_mu, tau_hat = _em_pool(np.array(b), np.array(s2), np.array(groups))
    assert mu_hat[0] == pytest.approx(-0.8, abs=0.1)
    assert mu_hat[1] == pytest.approx(-2.0, abs=0.1)
    assert tau_hat == pytest.approx(0.5, abs=0.12)
    assert se_mu[0] < 0.1  # 200 members: the group mean is well determined


@pytest.fixture()
def fast_bootstrap(monkeypatch):
    monkeypatch.setattr(E, "BOOTSTRAP_B", 60)


def test_thin_sku_borrows_category_strength(fast_bootstrap):
    """A SKU with no price variation in a usable category must be served the
    category posterior at `partial` — not the global assumption bracket."""
    store = generate_store(GoldenConfig(seed=11, n_categories=4))
    cats = dict(zip(store.truth["sku"], store.truth["category"]))
    thin = set(store.truth.loc[store.truth["n_permanent_levels"] == 1, "sku"])
    fits = {f.sku: f for f in fit_store_hier(store.orders, categories=cats, seed=0)}
    borrowed = [fits[s] for s in thin if fits[s].confidence == "partial" and fits[s].raw_elasticity is None]
    assert borrowed, "expected at least one thin SKU to borrow category strength"
    for f in borrowed:
        assert "category" in f.explanation
        assert f.se is not None and f.se > 0
        assert f.low <= f.elasticity <= f.high


def test_without_categories_thin_skus_fall_to_assumption(fast_bootstrap):
    store = generate_store(GoldenConfig(seed=11))
    thin = set(store.truth.loc[store.truth["n_permanent_levels"] == 1, "sku"])
    fits = {f.sku: f for f in fit_store_hier(store.orders, categories=None, seed=0)}
    thin_unfittable = [s for s in thin if fits[s].raw_elasticity is None]
    for s in thin_unfittable:
        assert fits[s].confidence == "assumption"


def test_deterministic(fast_bootstrap):
    store = generate_store(GoldenConfig(n_skus=8, days=120, seed=3, n_categories=2))
    cats = dict(zip(store.truth["sku"], store.truth["category"]))
    a = fit_store_hier(store.orders, categories=cats, seed=0)
    b = fit_store_hier(store.orders, categories=cats, seed=0)
    assert [(f.sku, f.elasticity, f.confidence) for f in a] == [(f.sku, f.elasticity, f.confidence) for f in b]


def test_estimator_adapter(fast_bootstrap):
    store = generate_store(GoldenConfig(n_skus=6, days=120, seed=5, n_categories=2))
    cats = dict(zip(store.truth["sku"], store.truth["category"]))
    est = HierElasticity(store.orders, categories=cats, seed=0)
    sku0 = store.truth["sku"].iloc[0]
    out = est.estimate(store.orders[store.orders["sku"] == sku0])
    assert out["confidence"] in {"fitted", "partial", "assumption"}
    assert out["model_version"] == "elasticity-hier-em-1.0"


def test_c4_verdict_is_recorded_loss(fast_bootstrap):
    """R28: the challenger lost and stays recorded, not deployed. If a future
    change makes it win, this fails — upgrade deliberately (MODELS.md,
    contract emitters, snapshot), don't let it drift in."""
    report = run_c4(seeds=(7, 42))
    assert report["summary"]["verdict"] == "incumbent stays", report["summary"]


def test_golden_categories_do_not_change_default_universe():
    """n_categories is opt-in: the default universe must stay byte-identical
    (the SHA snapshot test guards orders; this guards truth's elasticities)."""
    a = generate_store(GoldenConfig(n_skus=6, days=100, seed=9))
    b = generate_store(GoldenConfig(n_skus=6, days=100, seed=9, n_categories=0))
    pd.testing.assert_frame_equal(a.orders, b.orders)
    assert (a.truth["category"].isna()).all()


def test_golden_categories_cluster_elasticities():
    store = generate_store(GoldenConfig(n_skus=24, days=100, seed=9, n_categories=3))
    t = store.truth
    assert t["category"].notna().all()
    within = t.groupby("category")["elasticity"].std().mean()
    overall = t["elasticity"].std()
    assert within < overall  # clustering is real