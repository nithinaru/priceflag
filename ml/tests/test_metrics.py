"""Hand-computed cases for every scoring function — the harness is only as
trustworthy as its metrics."""

import numpy as np
import pytest

from priceflag_ml.metrics import (
    elasticity_recovery,
    interval_coverage,
    mape,
    pinball_loss,
    wape,
)


def test_interval_coverage_hand_case():
    y = [1, 2, 3, 4]
    lo = [0, 3, 2, 5]
    hi = [2, 4, 4, 6]
    # inside: 1 in [0,2] yes; 2 in [3,4] no; 3 in [2,4] yes; 4 in [5,6] no
    assert interval_coverage(y, lo, hi) == 0.5


def test_interval_coverage_bounds_are_inclusive():
    """Closed interval: an actual sitting exactly on a band edge counts as
    covered. With integer daily units, edge hits are common — the semantics
    must be pinned, not incidental."""
    assert interval_coverage([2, 4], [2, 3], [3, 4]) == 1.0


def test_interval_coverage_empty_is_nan():
    assert np.isnan(interval_coverage([], [], []))


def test_pinball_loss_hand_case():
    # q=0.9: under-forecast (y=10, f=8) costs 0.9*2=1.8; over (y=6, f=8) costs 0.1*2=0.2
    assert pinball_loss([10, 6], [8, 8], 0.9) == pytest.approx(1.0)
    # q=0.1 mirrors: under costs 0.1*2=0.2, over costs 0.9*2=1.8
    assert pinball_loss([10, 6], [8, 8], 0.1) == pytest.approx(1.0)
    # perfect forecast: zero loss
    assert pinball_loss([5, 5], [5, 5], 0.5) == 0.0


def test_pinball_loss_rejects_bad_q():
    with pytest.raises(ValueError):
        pinball_loss([1], [1], 1.0)


def test_pinball_asymmetry_penalizes_correct_side():
    # A q90 forecast should hurt more when it is BELOW the actual.
    below = pinball_loss([10], [8], 0.9)
    above = pinball_loss([10], [12], 0.9)
    assert below > above


def test_wape_hand_case():
    assert wape([10, 0], [8, 1]) == pytest.approx(0.3)  # (2+1)/10
    assert np.isnan(wape([0, 0], [1, 1]))


def test_mape_masks_zero_days():
    assert mape([10, 0], [8, 1]) == pytest.approx(0.2)  # only the y=10 day scores
    assert np.isnan(mape([0], [1]))


def test_elasticity_recovery_hand_case():
    est = {"A": -1.0, "B": -2.0, "C": -0.5}
    tru = {"A": -1.2, "B": -1.0, "D": -3.0}  # C and D unmatched
    out = elasticity_recovery(est, tru, tol=0.3)
    assert out["n"] == 2
    assert out["mae"] == pytest.approx((0.2 + 1.0) / 2)
    assert out["rmse"] == pytest.approx(np.sqrt((0.04 + 1.0) / 2))
    assert out["pct_within_0.3"] == pytest.approx(0.5)


def test_elasticity_recovery_no_overlap():
    out = elasticity_recovery({"A": -1.0}, {"B": -1.0})
    assert out["n"] == 0
    assert np.isnan(out["mae"])
