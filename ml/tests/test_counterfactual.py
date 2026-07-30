"""C5 counterfactual monitor: mechanics, honesty of breach probabilities on
known effects, contract conformance, and the R29 gate."""

import json
import pathlib

import jsonschema
import numpy as np
import pandas as pd
import pytest

from priceflag_ml.counterfactual import CounterfactualMonitor
from priceflag_ml.harness import _c5_scenario, run_c5


@pytest.fixture(scope="module")
def null_case():
    pre, during, treated = _c5_scenario(seed=7, rep=0, effect_ratio=1.0)
    return pre, during, treated


@pytest.fixture(scope="module")
def crash_case():
    pre, during, treated = _c5_scenario(seed=7, rep=0, effect_ratio=0.45)
    return pre, during, treated


def test_guardrail_validation():
    with pytest.raises(ValueError):
        CounterfactualMonitor(guardrail_drop_pct=30.0)  # percent, not fraction
    with pytest.raises(ValueError):
        CounterfactualMonitor(guardrail_drop_pct=0.2).fit(pd.DataFrame(columns=["sku", "date", "units"]))


def test_null_scenario_stays_quiet(null_case):
    pre, during, _ = null_case
    days = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre).assess(during)
    assert len(days) == 14
    assert max(a.breach_probability for a in days) < 0.8
    # the effect-ratio estimate should hover around 1
    assert days[-1].effect_ratio == pytest.approx(1.0, abs=0.25)


def test_catastrophic_drop_flags_fast(crash_case):
    pre, during, _ = crash_case
    days = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre).assess(during)
    first_flag = next(i + 1 for i, a in enumerate(days) if a.breach_probability >= 0.8)
    assert first_flag <= 2
    # cumulative evidence: by the end the probability is near certainty and
    # the ratio CI sits well below the guardrail line
    assert days[-1].breach_probability > 0.99
    assert days[-1].ratio_high < 0.8


def test_assessments_are_cumulative_and_ordered(crash_case):
    pre, during, _ = crash_case
    days = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre).assess(during)
    cum_e = [a.cum_expected for a in days]
    cum_a = [a.cum_actual for a in days]
    assert all(b > a for a, b in zip(cum_e, cum_e[1:]))
    assert all(b >= a for a, b in zip(cum_a, cum_a[1:]))
    assert all(a.ratio_low <= a.effect_ratio <= a.ratio_high for a in days)


def test_assess_rejects_days_outside_window(null_case):
    pre, during, _ = null_case
    m = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre)
    beyond = during.copy()
    beyond["date"] = beyond["date"] + pd.Timedelta(days=400)
    with pytest.raises(ValueError, match="stale"):
        m.assess(beyond)


def test_contract_rows_validate_against_schema(crash_case):
    pre, during, _ = crash_case
    m = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre)
    days = m.assess(during)
    rows = m.contract_rows(
        days,
        shop_domain="golden.myshopify.com",
        variant_gid="gid://shopify/ProductVariant/1",
        rollout_id="123e4567-e89b-42d3-a456-426614174000",
        generated_at="2026-07-29T00:00:00Z",
    )
    schema = json.loads(
        (pathlib.Path(__file__).resolve().parents[2] / "contracts" / "expected_band.schema.json").read_text()
    )
    validator = jsonschema.Draft202012Validator(schema)
    for row in rows:
        validator.validate(row)
        assert row["band_kind"] == "counterfactual"
        assert 0.0 <= row["breach_probability"] <= 1.0


def test_deterministic(null_case):
    pre, during, _ = null_case
    a = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre).assess(during)
    b = CounterfactualMonitor(guardrail_drop_pct=0.20).fit(pre).assess(during)
    assert [x.breach_probability for x in a] == [x.breach_probability for x in b]


def test_r29_gate_reduced():
    """Reduced-size gate (1 seed): zero false alarms, catastrophic drops flag
    fast, moderate drops flag reliably. Full 3-seed grid is snapshot in
    eval/c5_counterfactual.json."""
    report = run_c5(seeds=(7,), reps_per_seed=5)
    s = report["summary"]
    assert s["false_positive_rate"] == 0.0, s
    cat = s["grid"]["catastrophic_0.50"]
    assert cat["cf_flag_rate"] >= 0.8
    assert cat["cf_median_day"] <= 2
    assert s["grid"]["moderate_0.65"]["cf_flag_rate"] >= 0.8
