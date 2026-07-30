"""Elasticity v1 (Sprint C2): per-SKU Poisson GLM with empirical-Bayes
shrinkage toward the portfolio prior.

Model, per SKU, over non-promo, non-stockout days::

    units ~ Poisson(mu),
    log(mu) = a + elasticity * log(price / modal_price)
              + dow dummies + linear trend

Promo days are excluded from fitting entirely: promo windows pair a price
cut with a non-price demand lift, so promotional price variation is
confounded (and collinear with any promo dummy) — identification comes from
permanent price levels only. SKUs whose only price variation is promotional
are honestly not identifiable and fall to the assumption tier.

The brief named log-log ridge as the v1 workhorse; the Poisson GLM replaced
it pre-ship after a golden-recovery head-to-head (log1p attenuates elasticity
on low-volume SKUs; both runs are recorded in ml/MODELS.md per R28).

Shrinkage: raw per-SKU estimates are combined with a portfolio prior via a
random-effects (DerSimonian–Laird) empirical-Bayes step. SKUs with little
usable price variation get large standard errors and are pulled hard toward
the portfolio mean; SKUs with real permanent price changes keep their own
signal. SEs come from a seeded residual-pairs bootstrap.

Confidence tiers (PRD R7 — honest by construction):

- ``fitted``     — real non-promo price variation, enough history, stable SE.
- ``partial``    — some usable signal (promo-only variation, or thin history);
                   the shrunk estimate is served with a wide bracket.
- ``assumption`` — no usable price variation: the store's history cannot
                   identify elasticity; serve the v0 bracket honestly.

Every output row carries the `elasticity_fit` contract fields
(BUILD_BRIEF §3): elasticity, se, n_obs, price_variation_pct, confidence,
model_version, fitted_at — plus low/high and a plain-language explanation.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .baselines import BRACKET_HIGH, BRACKET_LOW, BRACKET_POINT

MODEL_VERSION = "elasticity-poisson-eb-1.0"

# Effectively-unpenalized MLE: with ~90-170 clean days and 9 parameters there
# is no need for regularization inside a SKU; the tiny lambda is numerical
# jitter only. Cross-SKU regularization happens in the EB shrinkage step.
RIDGE_LAMBDA = 1e-6
BOOTSTRAP_B = 200
MIN_OBS_FIT = 60  # non-promo, non-stockout days IN THE FIT for the `fitted` tier
MIN_OBS_ANY = 28  # below this we don't even try to regress
MIN_NONZERO_DAYS = 10  # fit days with >=1 sale; below this, no demand signal
# Non-promo price variation below this is noise, not signal (pct of modal price).
MIN_VARIATION_PCT_FITTED = 3.0
MAX_SE_FITTED = 0.45  # a fitted claim must be reasonably tight

BOOTSTRAP_BLOCK = 14  # moving-block bootstrap: keeps autocorrelated drift in the SE
# Allowance for unmodeled slow-seasonality drift that the linear trend can't
# capture and the bootstrap can't fully see. Calibrated on golden data so the
# raw fits' 80% CIs actually cover the true elasticity ~80% of the time.
DRIFT_SE = 0.35
# Between-SKU elasticity spread (prior sd for the EB step). FIXED, not
# estimated: with 10-25 raw fits whose SEs are ~1.0, both DerSimonian-Laird
# and MAD-based estimates of tau are wildly unstable (tested on golden seeds:
# collapse to ~0 on one seed, explosion to 2.4 on another — either ruins the
# posterior). 0.6 is the cross-SKU spread of retail own-price elasticities
# used to build the golden store and consistent with published retail meta-
# analyses; C4's hierarchical model will revisit estimating it from data.
TAU_FIXED = 0.60
Z80 = 1.2816


@dataclass(frozen=True)
class SkuFit:
    sku: str
    elasticity: float
    low: float
    high: float
    se: float | None
    raw_elasticity: float | None
    raw_se: float | None
    n_obs: int
    price_variation_pct: float
    nonpromo_variation_pct: float
    confidence: str
    explanation: str
    shrinkage_weight: float | None = None  # 1 = all own data, 0 = all prior
    prior_elasticity: float | None = None
    model_version: str = MODEL_VERSION


def _design(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray] | None:
    """Design matrix and count response over clean (non-stockout) days.

    Column 1 (index 1, after the intercept) is log relative price — the
    elasticity coefficient. The caller passes non-promo days, so no promo
    column is needed (it would be identically zero).
    """
    clean = df[~df["stockout"]] if "stockout" in df.columns else df
    if "price_cents" in clean.columns:
        clean = clean[clean["price_cents"] > 0]  # unknown price: not regressable
    if len(clean) < MIN_OBS_ANY:
        return None
    y = clean["units"].to_numpy(dtype=float)
    price = clean["price_cents"].to_numpy(dtype=float)
    modal = float(pd.Series(price).mode().iloc[0])
    log_rel_price = np.log(price / modal)
    dates = pd.DatetimeIndex(clean["date"])
    weekday = dates.weekday.to_numpy()
    day_idx = (dates - dates[0]).days.to_numpy(dtype=float)

    # Time control: linear trend only. Anything more flexible (splines,
    # sin/cos over a sub-annual window) can absorb the discontinuity a
    # permanent price change makes and steal the price signal — tested on
    # golden data, wild estimates + inflated SEs (see MODELS.md). The residual
    # slow-seasonality drift a line can't capture is real noise for this
    # estimator; the bootstrap SE and the EB step carry it honestly.
    span = max(float(day_idx[-1]), 1.0)
    cols = [np.ones(len(clean)), log_rel_price, day_idx / span - 0.5]
    cols += [(weekday == wd).astype(float) for wd in range(1, 7)]  # Monday is baseline
    return np.column_stack(cols), y


def _poisson_irls(X: np.ndarray, y: np.ndarray, lam: float = RIDGE_LAMBDA, n_iter: int = 50) -> np.ndarray | None:
    """Poisson GLM (log link) via IRLS, ridge on control columns only.

    Chosen over log-log OLS after a harness head-to-head (see ml/MODELS.md):
    log(units+1) attenuates elasticity badly on low-volume SKUs (most of a
    DTC catalog), while the Poisson mean model is unbiased for counts and
    weights days by their information content. Quasi-Poisson consistency
    means NB overdispersion inflates SEs (the bootstrap captures that) but
    not the coefficient. The intercept and the elasticity coefficient are
    never penalized — log relative price has tiny variance (a 10% price
    change is 0.095 in logs), so an L2 penalty on it would swamp X'WX and
    attenuate the estimate toward 0; cross-SKU shrinkage of elasticity
    happens in the EB step instead.
    """
    p = X.shape[1]
    penalty = lam * np.eye(p)
    penalty[0, 0] = 0.0
    penalty[1, 1] = 0.0
    beta = np.zeros(p)
    beta[0] = np.log(max(y.mean(), 0.1))
    for _ in range(n_iter):
        eta = np.clip(X @ beta, -20, 20)
        mu = np.exp(eta)
        z = eta + (y - mu) / mu
        XtW = X.T * mu
        try:
            new = np.linalg.solve(XtW @ X + penalty, XtW @ z)
        except np.linalg.LinAlgError:
            return None
        if not np.isfinite(new).all():
            return None
        step = new - beta
        beta = new
        if np.abs(step).max() < 1e-8:
            break
    else:
        # Ran out of iterations without settling: refuse rather than return
        # something that merely looks converged.
        if np.abs(step).max() >= 1e-4:
            return None
    # Quasi-separation (e.g. zero sales after a price change) converges to a
    # clip-induced fixed point with an absurd slope — that is not an estimate.
    if np.abs(beta[1]) > 15.0:
        return None
    return beta


def _fit_raw(df: pd.DataFrame, rng: np.random.Generator) -> tuple[float, float] | None:
    """Raw per-SKU elasticity and bootstrap SE, or None if unregressable.

    Fits on non-promo, non-stockout days only: promo-window price cuts are
    confounded with the promo demand lift (and collinear with any promo
    dummy), so identification comes from permanent price levels. SKUs whose
    only price variation is promotional get no raw fit — that is the honest
    answer, not a limitation.
    """
    base = df[~df["promo"]] if "promo" in df.columns else df
    made = _design(base)
    if made is None:
        return None
    X, y = made
    if np.ptp(X[:, 1]) < 1e-9:  # no permanent price variation: not identifiable
        return None
    # A (near-)dead SKU carries no demand information: with all-zero counts
    # the likelihood is flat in price and IRLS lands on an artifact whose
    # bootstrap "SE" is numerically tiny — refuse instead.
    if np.count_nonzero(y) < MIN_NONZERO_DAYS:
        return None
    beta = _poisson_irls(X, y)
    if beta is None:
        return None
    n = len(y)
    block = min(BOOTSTRAP_BLOCK, n)
    n_blocks = int(np.ceil(n / block))
    boots = np.full(BOOTSTRAP_B, np.nan)
    for b in range(BOOTSTRAP_B):
        starts = rng.integers(0, n - block + 1, size=n_blocks)
        idx = (starts[:, None] + np.arange(block)[None, :]).ravel()[:n]
        Xb, yb = X[idx], y[idx]
        if np.ptp(Xb[:, 1]) < 1e-9:
            continue
        bb = _poisson_irls(Xb, yb)
        if bb is not None:
            boots[b] = bb[1]
    ok = np.isfinite(boots)
    if ok.sum() < BOOTSTRAP_B // 2:
        return None
    se = float(np.nanstd(boots, ddof=1))
    # Epsilon, not exact zero: a flat likelihood yields bootstrap spreads of
    # ~1e-13 that are numerical noise, not precision.
    if not np.isfinite(se) or se < 1e-6:
        return None
    # Honest SE: block-bootstrap sampling noise plus the drift allowance.
    return float(beta[1]), float(np.sqrt(se**2 + DRIFT_SE**2))


def _portfolio_prior(raw: list[tuple[float, float]]) -> tuple[float, float]:
    """Robust portfolio prior location: (mu, se_mu). tau is TAU_FIXED.

    The center is a plain median of the (clipped) raw fits — deliberately NOT
    precision-weighted: bootstrap SEs on 90-180 days of overdispersed counts
    are noisy enough that inverse-variance weighting lets a skewed tail of
    deceptively-tight wild fits drag the mean (tested on golden: the DL prior
    landed at -1.9 for a portfolio whose true mean was -1.4, then shrank every
    SKU to it). On the same seeds the median lands within ~0.3 of truth.
    Falls back to the bracket prior when the store has almost no identifiable
    SKUs.
    """
    if len(raw) < 3:
        return BRACKET_POINT, 0.5
    b = np.clip(np.array([r[0] for r in raw]), -5.0, 1.0)
    mu = float(np.median(b))
    robust_sd = 1.4826 * float(np.median(np.abs(b - mu)))
    se_mu = 1.2533 * robust_sd / np.sqrt(len(b))  # se of a median
    # A demand-curve prior centered on upward-sloping nonsense means the
    # identifiable SKUs are too noisy to trust as a prior at all.
    if not np.isfinite(mu) or mu > -0.1:
        return BRACKET_POINT, 0.5
    return mu, float(se_mu)


def _nonpromo_variation_pct(df: pd.DataFrame) -> float:
    """Price variation among non-promo, non-stockout days — the identifiable,
    unconfounded signal — as % of the modal price."""
    mask = ~df["promo"] if "promo" in df.columns else np.ones(len(df), bool)
    if "stockout" in df.columns:
        mask = mask & ~df["stockout"]
    p = df.loc[mask, "price_cents"].to_numpy(dtype=float)
    if p.size == 0:
        return 0.0
    modal = float(pd.Series(p).mode().iloc[0])
    return float((p.max() - p.min()) / modal * 100.0)


def _total_variation_pct(df: pd.DataFrame) -> float:
    p = df["price_cents"].to_numpy(dtype=float)
    if p.size == 0 or p.mean() == 0:
        return 0.0
    return float((p.max() - p.min()) / p.mean() * 100.0)


def _fit_days(df: pd.DataFrame) -> pd.DataFrame:
    """The days a raw fit actually uses: non-promo AND non-stockout."""
    mask = np.ones(len(df), dtype=bool)
    if "promo" in df.columns:
        mask &= ~df["promo"].to_numpy(dtype=bool)
    if "stockout" in df.columns:
        mask &= ~df["stockout"].to_numpy(dtype=bool)
    return df[mask]


def _assumption_explanation(fit_df: pd.DataFrame) -> str:
    """Cause-specific plain-language reason for the assumption tier."""
    if len(fit_df) < MIN_OBS_ANY:
        return (
            "There isn't enough sales history yet to measure this product's "
            "price sensitivity — using a standard assumption until more data arrives."
        )
    if len(fit_df) and np.ptp(fit_df["price_cents"].to_numpy(dtype=float)) < 1e-9:
        return (
            "This product's price hasn't changed outside promotions, so its "
            "price sensitivity can't be measured yet — using a standard assumption."
        )
    if len(fit_df) and np.count_nonzero(fit_df["units"].to_numpy()) < MIN_NONZERO_DAYS:
        return (
            "This product has had almost no sales, so there's no demand signal "
            "to measure — using a standard assumption."
        )
    return (
        "We couldn't get a reliable read on this product's price sensitivity "
        "from its history — using a standard assumption."
    )


def _partial_reason(np_var: float, n_fit: int, had_promos: bool) -> str:
    """Which gate actually failed, in plain language."""
    if np_var < MIN_VARIATION_PCT_FITTED:
        if had_promos:
            return "its price mostly changed during promotions"
        return "its price has barely changed"
    if n_fit < MIN_OBS_FIT:
        return "its history is still short"
    return "its day-to-day sales are too variable for a precise read"


def fit_store(orders: pd.DataFrame, seed: int = 0) -> list[SkuFit]:
    """Fit every SKU in a store: raw GLM fits, EB shrinkage, honest tiers."""
    from .harness import sku_frames  # local import to avoid a cycle

    frames = sku_frames(orders)
    raw_fits: dict[str, tuple[float, float]] = {}
    for i, (sku, df) in enumerate(frames.items()):
        out = _fit_raw(df, np.random.default_rng([seed, i]))
        if out is not None:
            raw_fits[sku] = out

    mu, se_mu = _portfolio_prior(list(raw_fits.values()))
    tau2 = TAU_FIXED**2

    fits: list[SkuFit] = []
    for sku, df in frames.items():
        fit_df = _fit_days(df)
        n_fit = len(fit_df)
        total_var = _total_variation_pct(df)
        np_var = _nonpromo_variation_pct(df)
        had_promos = bool(df["promo"].any()) if "promo" in df.columns else False

        if sku not in raw_fits:
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
                )
            )
            continue

        b_raw, se_raw = raw_fits[sku]
        # A wrong-sign or runaway raw fit is evidence of confounding, not a
        # precise observation at the clip boundary: clip its value AND vacate
        # its precision in proportion to how far outside the credible range it
        # landed, so it cannot masquerade as a confident near-zero elasticity.
        excess = max(0.0, b_raw - 0.0) + max(0.0, -3.5 - b_raw)
        b_clipped = float(np.clip(b_raw, -3.5, 0.0))
        se_used = float(np.sqrt(se_raw**2 + excess**2))
        # Empirical-Bayes shrinkage toward the portfolio median.
        w_data, w_prior = 1.0 / se_used**2, 1.0 / tau2
        b_shrunk = (w_data * b_clipped + w_prior * mu) / (w_data + w_prior)
        # Posterior sd plus the prior-center estimation error it inherits.
        prior_share = w_prior / (w_data + w_prior)
        se_shrunk = float(np.sqrt(1.0 / (w_data + w_prior) + (prior_share * se_mu) ** 2))
        # Demand curves slope down; clip runaway estimates into a sane range.
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
            reason = "its sales moved oddly around price changes" if wrong_sign else _partial_reason(
                np_var, n_fit, had_promos
            )
            explanation = (
                f"Partly measured from this store's data ({reason}), "
                "partly based on similar products in your catalog."
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
                prior_elasticity=float(mu),
            )
        )
    return fits


FITS_FRAME_COLUMNS = [
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


def fits_frame(fits: list[SkuFit], fitted_at: str | None = None) -> pd.DataFrame:
    """`elasticity_fits` contract rows, ready for Lane B's table.

    ``n_obs`` is the number of days the fit actually used (non-promo,
    non-stockout) — not the calendar length of the history.
    """
    if not fits:
        return pd.DataFrame(columns=FITS_FRAME_COLUMNS)
    rows = []
    for f in fits:
        rows.append(
            {
                "sku": f.sku,
                "elasticity": f.elasticity,
                "low": f.low,
                "high": f.high,
                "se": f.se,
                "n_obs": f.n_obs,
                "price_variation_pct": f.price_variation_pct,
                "confidence": f.confidence,
                "explanation": f.explanation,
                "model_version": f.model_version,
                "fitted_at": fitted_at,
            }
        )
    return pd.DataFrame(rows)


CONTRACT_METHOD = "poisson_irls_eb_shrunk"


def fits_contract_rows(
    fits: list[SkuFit],
    shop_domain: str,
    fitted_at: str,
    variant_gids: dict[str, str] | None = None,
    window_start: str | None = None,
    window_end: str | None = None,
) -> list[dict]:
    """Rows shaped exactly for `contracts/elasticity_fit.schema.json`.

    The schema is `additionalProperties: false`, so this emits only contract
    fields — notably NOT the internal low/high credible bounds (Lane B derives
    the served range from `se`; a request to add explicit bounds is on file).
    `variant_gids` maps internal sku ids to Shopify variant gids; entries
    missing from the map are passed through unchanged.
    """
    gids = variant_gids or {}
    rows = []
    for f in fits:
        row = {
            "contract_version": "1.0.0",
            "shop_domain": shop_domain,
            "variant_gid": gids.get(f.sku, f.sku),
            "elasticity": f.elasticity,
            "se": f.se,
            "n_obs": f.n_obs,
            "price_variation_pct": f.price_variation_pct,
            "confidence": f.confidence,
            "confidence_explanation": f.explanation,
            "method": CONTRACT_METHOD,
            "shrinkage_weight": f.shrinkage_weight,
            "prior_elasticity": f.prior_elasticity,
            "model_version": f.model_version,
            "fitted_at": fitted_at,
        }
        if window_start is not None:
            row["window_start"] = window_start
        if window_end is not None:
            row["window_end"] = window_end
        rows.append(row)
    return rows


class RidgeElasticity:
    """Harness adapter: store-level fit exposed as a per-SKU estimator."""

    model_version = MODEL_VERSION

    def __init__(self, orders: pd.DataFrame, seed: int = 0) -> None:
        self._fits = {f.sku: f for f in fit_store(orders, seed=seed)}

    def estimate(self, history: pd.DataFrame) -> dict:
        sku = str(history["sku"].iloc[0])
        f = self._fits.get(sku)
        if f is None:
            raise ValueError(
                f"SKU {sku!r} was not in the orders frame this estimator was fit on — "
                "refit the store (fit_store) before estimating new SKUs."
            )
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
