"""Scoring functions used by the eval harness.

All functions take plain numpy arrays (or things convertible to them) and
return floats. NaNs are the caller's problem — the harness filters stockout
days before scoring.
"""

from __future__ import annotations

import numpy as np


def _arr(x) -> np.ndarray:
    return np.asarray(x, dtype=float)


def interval_coverage(actual, low, high) -> float:
    """Fraction of actuals inside [low, high]. For an 80% band, nominal is 0.8."""
    y, lo, hi = _arr(actual), _arr(low), _arr(high)
    if y.size == 0:
        return float("nan")
    return float(np.mean((y >= lo) & (y <= hi)))


def pinball_loss(actual, pred_quantile, q: float) -> float:
    """Mean pinball (quantile) loss for quantile level ``q`` in (0, 1)."""
    if not 0.0 < q < 1.0:
        raise ValueError(f"q must be in (0,1), got {q}")
    y, f = _arr(actual), _arr(pred_quantile)
    diff = y - f
    return float(np.mean(np.where(diff >= 0, q * diff, (q - 1) * diff)))


def mape(actual, pred) -> float:
    """Mean absolute percentage error over days with actual > 0.

    Zero-sales days are excluded (division by zero); use ``wape`` as the
    primary point metric for low-volume SKUs.
    """
    y, f = _arr(actual), _arr(pred)
    mask = y > 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs((y[mask] - f[mask]) / y[mask])))


def wape(actual, pred) -> float:
    """Weighted absolute percentage error: sum(|err|) / sum(|actual|).

    Robust to zero days; undefined (NaN) if all actuals are zero.
    """
    y, f = _arr(actual), _arr(pred)
    denom = np.sum(np.abs(y))
    if denom == 0:
        return float("nan")
    return float(np.sum(np.abs(y - f)) / denom)


def elasticity_recovery(estimates: dict[str, float], truth: dict[str, float], tol: float = 0.3) -> dict:
    """Compare point elasticity estimates against golden truth.

    Only SKUs present in both mappings are scored. Returns MAE, RMSE, and the
    fraction of estimates within ``tol`` of truth (the C2 acceptance metric).
    """
    common = sorted(set(estimates) & set(truth))
    if not common:
        return {"n": 0, "mae": float("nan"), "rmse": float("nan"), f"pct_within_{tol:g}": float("nan")}
    est = _arr([estimates[k] for k in common])
    tru = _arr([truth[k] for k in common])
    err = est - tru
    return {
        "n": len(common),
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(np.sqrt(np.mean(err**2))),
        f"pct_within_{tol:g}": float(np.mean(np.abs(err) <= tol)),
    }
