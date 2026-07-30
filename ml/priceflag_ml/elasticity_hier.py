"""C4: hierarchical elasticity (v2) — partial pooling across categories.

Two-level empirical Bayes fitted by EM ("fast empirical-Bayes equivalent" per
the brief; a full PyMC hierarchical model remains an untried challenger,
recorded in MODELS.md):

    stage 1 (unchanged from C2):  b_i ~ N(theta_i, s_i^2)   per-SKU GLM fit
    stage 2 (new):                theta_i ~ N(mu_{c(i)}, tau^2)

where c(i) is the SKU's category (Shopify `product_type` on real data). The
EM step estimates the category means mu_c AND the between-SKU-within-category
spread tau from the data jointly — replacing C2's fixed global tau=0.6 and
single global median. Categories with fewer than ``MIN_CAT_FITS`` identifiable
members collapse into a global pool (no pretend category signal).

What thin-history SKUs get: a SKU with NO identifiable price variation cannot
be regressed, but if its *category* has enough identifiable members, it is
served the category posterior mean with sd sqrt(tau^2 + se(mu_c)^2) at
``partial`` confidence — borrowing strength instead of falling all the way to
the global assumption bracket. With no usable category, behavior is identical
to C2 (assumption).

Ships only if it beats C2 on the harness (run_c4): not worse on the
identifiable slice AND better on thin-data cases in category-structured
golden universes. R28 as always.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .baselines import BRACKET_HIGH, BRACKET_LOW, BRACKET_POINT
from .elasticity import (
    MIN_OBS_FIT,
    MIN_VARIATION_PCT_FITTED,
    MAX_SE_FITTED,
    Z80,
    SkuFit,
    _fit_days,
    _fit_raw,
    _nonpromo_variation_pct,
    _total_variation_pct,
    _assumption_explanation,
)

MODEL_VERSION = "elasticity-hier-em-1.0"
CONTRACT_METHOD = "poisson_irls_hier_em"

MIN_CAT_FITS = 3  # identifiable members a category needs to have its own mean
TAU_BOUNDS = (0.20, 1.50)
EM_ITERS = 100


def _em_pool(
    b: np.ndarray, s2: np.ndarray, groups: np.ndarray
) -> tuple[dict[int, float], dict[int, float], float]:
    """EM for the two-level normal model. Returns (mu_by_group,
    se_mu_by_group, tau). Group -1 is the global pool."""
    uniq = np.unique(groups)
    mu = {g: float(np.median(b[groups == g])) for g in uniq}
    tau2 = 0.6**2
    for _ in range(EM_ITERS):
        # E-step: posterior mean/var per SKU given current (mu, tau)
        w_data = 1.0 / s2
        w_prior = 1.0 / tau2
        mu_vec = np.array([mu[g] for g in groups])
        post_var = 1.0 / (w_data + w_prior)
        post_mean = post_var * (w_data * b + w_prior * mu_vec)
        # M-step
        new_mu = {g: float(post_mean[groups == g].mean()) for g in uniq}
        tau2_new = float(np.mean(post_var + (post_mean - np.array([new_mu[g] for g in groups])) ** 2))
        tau2_new = float(np.clip(tau2_new, TAU_BOUNDS[0] ** 2, TAU_BOUNDS[1] ** 2))
        moved = max(abs(new_mu[g] - mu[g]) for g in uniq) + abs(np.sqrt(tau2_new) - np.sqrt(tau2))
        mu, tau2 = new_mu, tau2_new
        if moved < 1e-8:
            break
    se_mu = {
        g: float(np.sqrt(1.0 / np.sum(1.0 / (s2[groups == g] + tau2))))
        for g in uniq
    }
    return mu, se_mu, float(np.sqrt(tau2))


def fit_store_hier(
    orders: pd.DataFrame,
    categories: dict[str, str] | None = None,
    seed: int = 0,
) -> list[SkuFit]:
    """Hierarchical fit for every SKU. `categories` maps sku -> category name
    (real data: `product_type` from ml_products); missing/None -> global pool.
    """
    from .harness import sku_frames  # local import to avoid a cycle

    categories = categories or {}
    frames = sku_frames(orders)

    raw: dict[str, tuple[float, float]] = {}
    for i, (sku, df) in enumerate(frames.items()):
        out = _fit_raw(df, np.random.default_rng([seed, i]))
        if out is not None:
            raw[sku] = out

    # Group assignment: category id if it has enough identifiable members,
    # else the global pool (-1).
    cat_counts: dict[str, int] = {}
    for sku in raw:
        c = categories.get(sku)
        if c is not None:
            cat_counts[c] = cat_counts.get(c, 0) + 1
    usable_cats = {c for c, n in cat_counts.items() if n >= MIN_CAT_FITS}
    cat_ids = {c: k for k, c in enumerate(sorted(usable_cats))}

    def group_of(sku: str) -> int:
        c = categories.get(sku)
        return cat_ids.get(c, -1) if c is not None else -1

    fits: list[SkuFit] = []
    if len(raw) >= 3:
        skus_r = list(raw)
        b = np.clip(np.array([raw[s][0] for s in skus_r]), -3.5, 0.5)
        s2 = np.array([raw[s][1] for s in skus_r]) ** 2
        groups = np.array([group_of(s) for s in skus_r])
        mu_by_g, se_mu_by_g, tau = _em_pool(b, s2, groups)
    else:
        skus_r, mu_by_g, se_mu_by_g, tau = [], {-1: BRACKET_POINT}, {-1: 0.5}, 0.6

    tau2 = tau**2

    for sku, df in frames.items():
        fit_df = _fit_days(df)
        n_fit = len(fit_df)
        total_var = _total_variation_pct(df)
        np_var = _nonpromo_variation_pct(df)
        g = group_of(sku)
        mu_g = mu_by_g.get(g, mu_by_g.get(-1, BRACKET_POINT))
        se_mu_g = se_mu_by_g.get(g, se_mu_by_g.get(-1, 0.5))

        if sku not in raw:
            if g >= 0:
                # Borrow strength: the category posterior IS the estimate.
                est = float(np.clip(mu_g, -4.0, -0.05))
                sd = float(np.sqrt(tau2 + se_mu_g**2))
                fits.append(
                    SkuFit(
                        sku=sku,
                        elasticity=est,
                        low=float(min(est - Z80 * sd, est - 0.1)),
                        high=float(min(np.clip(est + Z80 * sd, None, -0.05), -0.05)),
                        se=sd,
                        raw_elasticity=None,
                        raw_se=None,
                        n_obs=n_fit,
                        price_variation_pct=total_var,
                        nonpromo_variation_pct=np_var,
                        confidence="partial",
                        explanation=(
                            "This product's own price history can't be measured yet, so this "
                            "is based on similar products in its category."
                        ),
                        shrinkage_weight=0.0,
                        prior_elasticity=float(mu_g),
                        model_version=MODEL_VERSION,
                    )
                )
            else:
                fits.append(
                    SkuFit(
                        sku=sku,
                        elasticity=BRACKET_POINT,
                        low=BRACKET_LOW,
                        high=BRACKET_HIGH,
                        se=None,
                        raw_elasticity=None,
                        raw_se=None,
                        n_obs=n_fit,
                        price_variation_pct=total_var,
                        nonpromo_variation_pct=np_var,
                        confidence="assumption",
                        explanation=_assumption_explanation(fit_df),
                        model_version=MODEL_VERSION,
                    )
                )
            continue

        b_raw, se_raw = raw[sku]
        excess = max(0.0, b_raw - 0.0) + max(0.0, -3.5 - b_raw)
        b_clipped = float(np.clip(b_raw, -3.5, 0.0))
        se_used = float(np.sqrt(se_raw**2 + excess**2))
        w_data, w_prior = 1.0 / se_used**2, 1.0 / tau2
        b_shrunk = (w_data * b_clipped + w_prior * mu_g) / (w_data + w_prior)
        prior_share = w_prior / (w_data + w_prior)
        se_shrunk = float(np.sqrt(1.0 / (w_data + w_prior) + (prior_share * se_mu_g) ** 2))
        b_shrunk = float(np.clip(b_shrunk, -4.0, -0.05))

        wrong_sign = b_raw > 0.0
        if (
            np_var >= MIN_VARIATION_PCT_FITTED
            and n_fit >= MIN_OBS_FIT
            and se_shrunk <= MAX_SE_FITTED
            and not wrong_sign
        ):
            confidence = "fitted"
            explanation = (
                "Measured from this product's own price changes "
                f"({np_var:.0f}% price variation across {n_fit} days of usable history)."
            )
        else:
            confidence = "partial"
            explanation = (
                "Partly measured from this product's own price changes, partly "
                "based on similar products in "
                + ("its category." if g >= 0 else "your catalog.")
            )

        fits.append(
            SkuFit(
                sku=sku,
                elasticity=b_shrunk,
                low=float(min(b_shrunk - Z80 * se_shrunk, b_shrunk - 0.1)),
                high=float(min(np.clip(b_shrunk + Z80 * se_shrunk, None, -0.05), -0.05)),
                se=se_shrunk,
                raw_elasticity=b_raw,
                raw_se=se_raw,
                n_obs=n_fit,
                price_variation_pct=total_var,
                nonpromo_variation_pct=np_var,
                confidence=confidence,
                explanation=explanation,
                shrinkage_weight=float(w_data / (w_data + w_prior)),
                prior_elasticity=float(mu_g),
                model_version=MODEL_VERSION,
            )
        )
    return fits


class HierElasticity:
    """Harness adapter mirroring RidgeElasticity's interface."""

    model_version = MODEL_VERSION

    def __init__(self, orders: pd.DataFrame, categories: dict[str, str] | None = None, seed: int = 0) -> None:
        self._fits = {f.sku: f for f in fit_store_hier(orders, categories=categories, seed=seed)}

    def estimate(self, history: pd.DataFrame) -> dict:
        sku = str(history["sku"].iloc[0])
        f = self._fits.get(sku)
        if f is None:
            raise ValueError(f"SKU {sku!r} was not in the orders frame this estimator was fit on.")
        return {
            "elasticity": f.elasticity,
            "low": f.low,
            "high": f.high,
            "se": f.se,
            "n_obs": f.n_obs,
            "price_variation_pct": f.price_variation_pct,
            "confidence": f.confidence,
            "explanation": f.explanation,
            "model_version": f.model_version,
        }
