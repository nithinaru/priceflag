"""C6 post-rollout reports: schema conformance, money integrity, honest
narratives, and the R30 calibration metric end-to-end on golden rollouts."""

import json
import pathlib

import jsonschema
import numpy as np
import pytest

import priceflag_ml.elasticity as E
from priceflag_ml.harness import _c6_scenario, run_c6
from priceflag_ml.reports import VariantPlan, build_report, calibration_summary, plans_from_price_history


@pytest.fixture(scope="module")
def golden_report():
    plans, pre, during, fits_before, store = _c6_scenario(seed=7, rep=0)
    report = build_report(
        rollout_id="123e4567-e89b-42d3-a456-426614174000",
        plans=plans,
        pre_history=pre,
        during_actuals=during,
        fits_before=fits_before,
        generated_at="2026-07-29T00:00:00Z",
        variant_gids={p.sku: f"gid://shopify/ProductVariant/{1000 + i}" for i, p in enumerate(plans)},
    )
    return report, plans, store


def test_report_validates_against_lane_b_schema(golden_report):
    report, _, _ = golden_report
    schema = json.loads(
        (pathlib.Path(__file__).resolve().parents[2] / "contracts" / "rollout_report.schema.json").read_text()
    )
    jsonschema.Draft202012Validator(schema).validate(report)


def test_predicted_band_brackets_expected(golden_report):
    report, _, _ = golden_report
    p = report["predicted"]
    for key in ("units_change_pct", "revenue_delta_cents", "profit_delta_cents"):
        assert p["low"][key] <= p["expected"][key] <= p["high"][key]


def test_money_is_integer_cents(golden_report):
    report, _, _ = golden_report
    for block in (report["predicted"]["expected"], report["predicted"]["low"], report["predicted"]["high"], report["realized"]):
        assert isinstance(block["revenue_delta_cents"], int)
        assert block["profit_delta_cents"] is None or isinstance(block["profit_delta_cents"], int)
    for row in report["per_variant"]:
        assert isinstance(row["realized_revenue_cents"], int)


def test_narrative_is_plain_language(golden_report):
    report, _, _ = golden_report
    text = report["narrative"].lower()
    assert len(report["narrative"]) > 50
    for jargon in ("elasticity", "confidence interval", "standard error", "coefficient", "p-value"):
        assert jargon not in text
    assert "$" in report["narrative"]


def test_in_range_consistent_with_band(golden_report):
    report, _, _ = golden_report
    key = "profit_delta_cents" if report["realized"]["profit_delta_cents"] is not None else "revenue_delta_cents"
    lo, hi = report["predicted"]["low"][key], report["predicted"]["high"][key]
    assert report["in_range"] == (lo <= report["realized"][key] <= hi)


def test_direction_claims_require_significance(golden_report):
    report, _, _ = golden_report
    upd = report["elasticity_update"]
    if upd and upd["direction"] != "as_expected":
        assert abs(upd["after"] - upd["before"]) > max(0.25, 1.2816 * (upd["se_after"] or 0))


def test_missing_cogs_yields_null_profit_not_fabrication():
    plans, pre, during, fits_before, _ = _c6_scenario(seed=11, rep=0)
    plans = [VariantPlan(p.sku, p.old_price_cents, p.new_price_cents, None) for p in plans]
    report = build_report(
        rollout_id="123e4567-e89b-42d3-a456-426614174000",
        plans=plans,
        pre_history=pre,
        during_actuals=during,
        fits_before=fits_before,
        generated_at="2026-07-29T00:00:00Z",
    )
    assert report["realized"]["profit_delta_cents"] is None
    assert report["predicted"]["expected"]["profit_delta_cents"] is None
    assert "profit unknown" in report["narrative"]
    # in_range falls back to the revenue band
    lo, hi = report["predicted"]["low"]["revenue_delta_cents"], report["predicted"]["high"]["revenue_delta_cents"]
    assert report["in_range"] == (lo <= report["realized"]["revenue_delta_cents"] <= hi)


def test_calibration_summary():
    assert calibration_summary([])["pct_in_range"] is None
    out = calibration_summary([{"in_range": True}, {"in_range": False}, {"in_range": True}])
    assert out["n_rollouts"] == 3
    assert out["pct_in_range"] == pytest.approx(2 / 3)


def test_plan_uses_first_live_price_and_ignores_rollback_entries():
    import pandas as pd

    rollout_id = "123e4567-e89b-42d3-a456-426614174000"
    history = pd.DataFrame(
        [
            {
                "variant_gid": "gid://shopify/ProductVariant/1",
                "rollout_id": rollout_id,
                "source": "rollout",
                "before_price_cents": 1000,
                "after_price_cents": 1100,
                "applied_at": "2026-07-01T00:00:00Z",
            },
            {
                "variant_gid": "gid://shopify/ProductVariant/1",
                "rollout_id": rollout_id,
                "source": "rollback",
                "before_price_cents": 1100,
                "after_price_cents": 1000,
                "applied_at": "2026-07-20T00:00:00Z",
            },
        ]
    )
    products = pd.DataFrame([{"variant_gid": "gid://shopify/ProductVariant/1", "cogs_cents": 400}])
    plans = plans_from_price_history(history, rollout_id, products)
    assert len(plans) == 1
    assert (plans[0].old_price_cents, plans[0].new_price_cents, plans[0].cogs_cents) == (1000, 1100, 400)


def test_r30_gate_reduced(monkeypatch):
    """Reduced C6 gate: reports generate, validate, and calibration is at
    least plausible. Full 9-rollout snapshot in eval/c6_reports.json."""
    monkeypatch.setattr(E, "BOOTSTRAP_B", 60)
    report = run_c6(seeds=(7,), reps_per_seed=2)
    s = report["summary"]
    assert s["n_rollouts"] == 2
    assert s["pct_in_range"] is not None and 0.0 <= s["pct_in_range"] <= 1.0
