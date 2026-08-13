"""C7 lattice optimizer: analytic sanity, constraints, robustness, contract."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import jsonschema
import numpy as np
import pandas as pd
import pytest

from priceflag_ml.optimize import (
    MODEL_VERSION,
    OptimizerConfig,
    SkuRecommendation,
    SkuSkip,
    Z80,
    baseline_stats,
    candidate_lattice,
    contract_rows,
    optimize_sku,
    optimize_store,
    top_n,
)

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "contracts" / "price_recommendation.schema.json"


@dataclass(frozen=True)
class FakeFit:
    sku: str
    elasticity: float
    low: float
    high: float
    se: float | None = 0.3
    confidence: str = "fitted"
    model_version: str = "elasticity-test-1.0"


def fit(sku="sku-1", e=-2.0, low=None, high=None, se=0.3, confidence="fitted"):
    return FakeFit(
        sku=sku,
        elasticity=e,
        low=e - 0.5 if low is None else low,
        high=e + 0.5 if high is None else high,
        se=se,
        confidence=confidence,
    )


def rec_of(out):
    assert isinstance(out, SkuRecommendation), f"expected a recommendation, got {out}"
    return out


def skip_of(out):
    assert isinstance(out, SkuSkip), f"expected a skip, got {out}"
    return out


def run(f, p0, cogs, inventory=None, baseline=5.0, realization=1.0, **cfg):
    return optimize_sku(f, p0, cogs, inventory, baseline, realization, OptimizerConfig(**cfg))


def daily_frame(sku="sku-1", days=40, price=2000, units=5, realization=1.0):
    dates = pd.date_range("2026-06-01", periods=days, freq="D")
    return pd.DataFrame(
        {
            "shop_id": "s1",
            "sku": sku,
            "date": dates,
            "units": units,
            "price_cents": price,
            "revenue_cents": int(units * price * realization),
            "promo": False,
            "stockout": False,
        }
    )


# ---------------------------------------------------------------------------
# lattice construction
# ---------------------------------------------------------------------------


def test_end99_lattice_mirrors_apply_rounding_blocks():
    # P0 = $19.90, 15% span -> [1692, 2288]; dollar blocks 16..22 contribute
    # d*100+99 candidates that fall inside the span.
    cands = candidate_lattice(1990, "end_99", 15.0)
    assert cands == [1699, 1799, 1899, 1999, 2099, 2199]
    assert candidate_lattice(1990, "end_95", 15.0) == [1695, 1795, 1895, 1995, 2095, 2195]
    assert candidate_lattice(1990, "end_00", 15.0) == [1700, 1800, 1900, 2000, 2100, 2200]


def test_none_lattice_is_bounded_and_keeps_cap_edges():
    cands = candidate_lattice(100_000, "none", 20.0)
    assert len(cands) <= 202  # thinned grid + the exact hi edge
    assert cands[0] == 80_000 and cands[-1] == 120_000
    assert all(isinstance(c, int) for c in cands)
    # narrow ranges are exhaustive cent steps
    assert candidate_lattice(100, "none", 10.0) == list(range(90, 111))


def test_lattice_never_emits_prices_below_one_cent():
    assert all(c >= 1 for c in candidate_lattice(40, "none", 95.0))
    assert all(c >= 1 for c in candidate_lattice(120, "end_00", 95.0))


# ---------------------------------------------------------------------------
# analytic sanity: continuous optimum P* = c*e/(1+e) for e < -1 (r = 1)
# ---------------------------------------------------------------------------


def test_unconstrained_argmax_lands_on_lattice_point_nearest_analytic_optimum():
    # e=-2, c=$10 -> P* = 2c = $20.00. Wide cap, fine grid.
    out = rec_of(run(fit(e=-2.0), p0=1900, cogs=1000, max_change_pct=50.0, margin_floor_pct=None, rounding="none"))
    cands = candidate_lattice(1900, "none", 50.0)
    step = max(b - a for a, b in zip(cands, cands[1:]))
    assert abs(out.recommended_price_cents - 2000) <= step
    assert out.binding == ("none",)


def test_end99_argmax_picks_the_better_neighbor_of_the_analytic_optimum():
    # P* = 2000 exactly; on the .99 lattice the true profit at 1999 beats 2099.
    out = rec_of(run(fit(e=-2.0), p0=1900, cogs=1000, max_change_pct=50.0, margin_floor_pct=None, rounding="end_99"))
    assert out.recommended_price_cents == 1999


def test_realization_rate_shifts_the_optimum():
    # With realization r, P* = (c/r)*e/(1+e): e=-2, c=$10, r=0.8 -> $25.00.
    out = rec_of(
        run(fit(e=-2.0), p0=2400, cogs=1000, realization=0.8, max_change_pct=50.0, margin_floor_pct=None, rounding="none")
    )
    cands = candidate_lattice(2400, "none", 50.0)
    step = max(b - a for a, b in zip(cands, cands[1:]))
    assert abs(out.recommended_price_cents - 2500) <= step
    assert out.realization_rate == 0.8


# ---------------------------------------------------------------------------
# constraints
# ---------------------------------------------------------------------------


def test_max_change_cap_binds_for_inelastic_sku():
    # e=-0.5: profit increases with price across the span, so the cap binds.
    out = rec_of(run(fit(e=-0.5, low=-0.9, high=-0.2), p0=2000, cogs=500, max_change_pct=10.0, rounding="none"))
    assert out.recommended_price_cents == 2200  # floor(2000 * 1.10)
    assert "max_change" in out.binding
    assert out.nominal_profit_delta_cents_per_day > 0


def test_uncapped_run_reports_lattice_edge_not_max_change():
    out = rec_of(run(fit(e=-0.5, low=-0.9, high=-0.2), p0=2000, cogs=500, max_change_pct=None, rounding="none"))
    assert "lattice_edge" in out.binding
    assert "max_change" not in out.binding
    assert out.max_change_pct is None


def test_margin_floor_binds_when_analytic_optimum_is_below_it():
    # e=-3, c=$10 -> P* = 1.5c = $15.00; floor 80% -> min price $18.00.
    out = rec_of(run(fit(e=-3.0), p0=2000, cogs=1000, max_change_pct=50.0, margin_floor_pct=80.0, rounding="none"))
    assert out.recommended_price_cents == 1800
    assert "margin_floor" in out.binding


def test_current_price_below_floor_forces_a_raise():
    # P0 $10.00 with cogs $9.00 and a 20% floor -> min price $10.80; staying
    # is not offered because the floor is a request to move up. e=-8 puts the
    # analytic optimum (c*e/(1+e) = $10.29) below the floor, so the argmax
    # presses against it.
    out = rec_of(run(fit(e=-8.0, low=-9.0, high=-7.0), p0=1000, cogs=900, max_change_pct=15.0, margin_floor_pct=20.0, rounding="none"))
    assert out.recommended_price_cents == 1080
    assert "margin_floor" in out.binding


def test_infeasible_constraints_skip():
    # Floor requires $18.00 but the cap tops out at $11.00 -> nothing feasible.
    out = skip_of(run(fit(e=-2.0), p0=1000, cogs=1500, max_change_pct=10.0, margin_floor_pct=20.0))
    assert out.reason == "infeasible_constraints"


def test_inventory_cap_changes_the_argmax():
    # e=-3, c=$2, P0=$10: unconstrained, a deep cut wins (P* = $3 is below the
    # span so the cut presses the low edge). With 60 units on hand (2/day
    # servable) the cut can't serve its demand and a raise wins instead.
    f = fit(e=-3.0, low=-3.5, high=-2.5)
    without = rec_of(run(f, p0=1000, cogs=200, inventory=None, max_change_pct=30.0, margin_floor_pct=None, rounding="none"))
    with_inv = rec_of(run(f, p0=1000, cogs=200, inventory=60, max_change_pct=30.0, margin_floor_pct=None, rounding="none"))
    assert without.recommended_price_cents < 1000  # cut
    assert with_inv.recommended_price_cents > 1000  # raise
    assert with_inv.inventory_cap_applied
    assert "inventory" in with_inv.binding
    assert not without.inventory_cap_applied


def test_inventory_cap_ignored_when_disabled_or_untracked():
    f = fit(e=-3.0, low=-3.5, high=-2.5)
    disabled = rec_of(
        run(f, p0=1000, cogs=200, inventory=60, inventory_aware=False, max_change_pct=30.0, margin_floor_pct=None, rounding="none")
    )
    untracked = rec_of(
        run(f, p0=1000, cogs=200, inventory=float("nan"), max_change_pct=30.0, margin_floor_pct=None, rounding="none")
    )
    negative = rec_of(run(f, p0=1000, cogs=200, inventory=-1, max_change_pct=30.0, margin_floor_pct=None, rounding="none"))
    for out in (disabled, untracked, negative):
        assert out.recommended_price_cents < 1000
        assert not out.inventory_cap_applied


# ---------------------------------------------------------------------------
# skips: no recommendations on vibes
# ---------------------------------------------------------------------------


def test_missing_or_zero_cogs_skips():
    assert skip_of(run(fit(), p0=2000, cogs=None)).reason == "no_cogs"
    assert skip_of(run(fit(), p0=2000, cogs=float("nan"))).reason == "no_cogs"
    assert skip_of(run(fit(), p0=2000, cogs=0)).reason == "no_cogs"


def test_assumption_confidence_skips():
    assert skip_of(run(fit(confidence="assumption"), p0=2000, cogs=1000)).reason == "no_fit"


def test_positive_elasticity_skips_rather_than_clamps():
    assert skip_of(run(fit(e=0.5, low=0.1, high=0.9), p0=2000, cogs=1000)).reason == "positive_elasticity"
    assert skip_of(run(fit(e=0.0, low=-0.2, high=0.2), p0=2000, cogs=1000)).reason == "positive_elasticity"


def test_zero_baseline_skips():
    assert skip_of(run(fit(), p0=2000, cogs=1000, baseline=0.0)).reason == "zero_baseline"


def test_missing_bounds_and_missing_se_skips():
    f = FakeFit(sku="s", elasticity=-2.0, low=float("nan"), high=float("nan"), se=None)
    assert skip_of(run(f, p0=2000, cogs=1000)).reason == "no_uncertainty"


def test_invalid_price_skips():
    assert skip_of(run(fit(), p0=0, cogs=1000)).reason == "no_price"


# ---------------------------------------------------------------------------
# robustness
# ---------------------------------------------------------------------------


def test_missing_bounds_fall_back_to_ci80_from_se():
    f = FakeFit(sku="s", elasticity=-2.0, low=float("nan"), high=float("nan"), se=0.3)
    out = rec_of(run(f, p0=1900, cogs=1000, max_change_pct=50.0, margin_floor_pct=None, rounding="none"))
    assert out.bounds_from_se
    assert out.elasticity_low == pytest.approx(-2.0 - Z80 * 0.3)
    assert out.elasticity_high == pytest.approx(-2.0 + Z80 * 0.3)


def test_robust_uses_pessimistic_bound_per_direction():
    # Inelastic point estimate says raise to the cap; the most-elastic bound
    # (low=-11, with a thin $2 margin on $20) makes EVERY raise worst-case
    # negative, and the least-elastic bound (high=-0.2) makes every cut
    # worst-case negative — so the robust choice is to stay.
    out = rec_of(run(fit(e=-0.5, low=-11.0, high=-0.2), p0=2000, cogs=1800, max_change_pct=10.0, margin_floor_pct=None, rounding="none"))
    assert out.recommended_price_cents == 2200
    assert out.robust_price_cents == 2000
    # The robust delta reported for the nominal price is its worst case,
    # which here is negative even though the nominal is positive.
    assert out.nominal_profit_delta_cents_per_day > 0
    assert out.robust_profit_delta_cents_per_day < 0


def test_robust_delta_evaluated_at_recommended_price_matches_low_bound():
    out = rec_of(run(fit(e=-0.5, low=-11.0, high=-0.2), p0=2000, cogs=1800, max_change_pct=10.0, margin_floor_pct=None, rounding="none"))
    p1, p0, units0 = out.recommended_price_cents, 2000, 5.0
    worst_units = units0 * (p1 / p0) ** -11.0  # increase -> most-elastic bound
    expected = worst_units * (p1 - 1800) - units0 * (p0 - 1800)
    assert out.robust_profit_delta_cents_per_day == int(round(expected))


def test_robust_and_nominal_agree_when_bounds_are_degenerate():
    # With low == high == the point estimate, the worst case IS the nominal
    # case, so the two argmaxes coincide exactly.
    out = rec_of(run(fit(e=-2.0, low=-2.0, high=-2.0), p0=1900, cogs=1000, max_change_pct=50.0, margin_floor_pct=None, rounding="none"))
    assert out.robust_price_cents == out.recommended_price_cents


def test_asymmetric_rule_blocks_cuts_the_cautious_bound_rejects():
    # Point estimate e=-3 says cut hard (P* = c*e/(1+e) = $15 on $10 cogs),
    # but the cautious end (high=-0.4, near-inelastic) says every cut just
    # gives away margin. The asymmetric rule scores cuts at that cautious
    # bound, and raises at the point estimate (where they also lose, since
    # P* < P0) — so the only honest recommendation is to stay.
    out = rec_of(run(fit(e=-3.0, low=-3.5, high=-0.4), p0=2000, cogs=1000, max_change_pct=15.0, margin_floor_pct=None, rounding="none"))
    assert out.recommended_price_cents == 2000
    assert out.nominal_profit_delta_cents_per_day == 0


def test_asymmetric_rule_still_cuts_when_the_cautious_bound_agrees():
    # Same point estimate, but now even the least-elastic bound (-2.5) puts
    # the optimum well below P0 (P*(-2.5) = $16.67) — the cautious read
    # agrees the cut wins, so the cut goes through.
    out = rec_of(run(fit(e=-3.0, low=-3.5, high=-2.5), p0=2000, cogs=1000, max_change_pct=15.0, margin_floor_pct=None, rounding="none"))
    assert out.recommended_price_cents < 2000
    assert out.nominal_profit_delta_cents_per_day > 0
    assert out.robust_profit_delta_cents_per_day >= 0


# ---------------------------------------------------------------------------
# baselines from the canonical frame
# ---------------------------------------------------------------------------


def test_baseline_stats_clean_day_mean_and_realization():
    frame = daily_frame(units=5, price=2000, realization=0.8)
    units, realization = baseline_stats(frame)
    assert units == pytest.approx(5.0)
    assert realization == pytest.approx(0.8)


def test_baseline_stats_excludes_promo_and_stockout_days():
    frame = daily_frame(units=5, price=2000)
    frame.loc[frame.index[-3:], ["units", "promo"]] = [50, True]  # promo spike must not inflate
    units, _ = baseline_stats(frame)
    assert units == pytest.approx(5.0)
    assert baseline_stats(None) == (0.0, 1.0)
    assert baseline_stats(frame.iloc[0:0]) == (0.0, 1.0)


# ---------------------------------------------------------------------------
# portfolio + contract rows
# ---------------------------------------------------------------------------


def portfolio():
    fits = [
        fit(sku="gid://shopify/ProductVariant/1", e=-2.0),
        fit(sku="gid://shopify/ProductVariant/2", e=-0.6, low=-1.1, high=-0.3, confidence="partial"),
        fit(sku="gid://shopify/ProductVariant/3", e=-1.8, confidence="assumption"),
        fit(sku="gid://shopify/ProductVariant/4", e=-1.5),  # no cogs
    ]
    products = pd.DataFrame(
        [
            {"variant_gid": "gid://shopify/ProductVariant/1", "price_cents": 1900, "cogs_cents": 1000, "inventory_quantity": 900},
            {"variant_gid": "gid://shopify/ProductVariant/2", "price_cents": 2500, "cogs_cents": 800, "inventory_quantity": 900},
            {"variant_gid": "gid://shopify/ProductVariant/3", "price_cents": 1500, "cogs_cents": 700, "inventory_quantity": 900},
            {"variant_gid": "gid://shopify/ProductVariant/4", "price_cents": 1200, "cogs_cents": None, "inventory_quantity": 900},
        ]
    )
    orders = pd.concat(
        [daily_frame(sku=f"gid://shopify/ProductVariant/{i}", price=p, units=5) for i, p in ((1, 1900), (2, 2500), (3, 1500), (4, 1200))],
        ignore_index=True,
    )
    return fits, products, orders


def test_optimize_store_partitions_recommendations_and_skips():
    fits, products, orders = portfolio()
    result = optimize_store(fits, products, orders)
    assert {r.sku for r in result.recommendations} == {
        "gid://shopify/ProductVariant/1",
        "gid://shopify/ProductVariant/2",
    }
    reasons = {s.sku: s.reason for s in result.skips}
    assert reasons["gid://shopify/ProductVariant/3"] == "no_fit"
    assert reasons["gid://shopify/ProductVariant/4"] == "no_cogs"


def test_top_n_orders_by_nominal_profit_delta():
    fits, products, orders = portfolio()
    result = optimize_store(fits, products, orders)
    best = top_n(result, 1)
    assert len(best) == 1
    deltas = [r.nominal_profit_delta_cents_per_day for r in top_n(result, 10)]
    assert deltas == sorted(deltas, reverse=True)


def test_contract_rows_validate_against_the_schema():
    fits, products, orders = portfolio()
    result = optimize_store(fits, products, orders)
    rows = contract_rows(
        result.recommendations,
        shop_domain="demo-store.myshopify.com",
        computed_at="2026-08-12T04:00:00Z",
        model_run_id="00000000-0000-4000-8000-000000000001",
    )
    assert len(rows) == 2
    schema = json.loads(SCHEMA_PATH.read_text())
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
    for row in rows:
        validator.validate(row)
        assert row["model_version"] == MODEL_VERSION
        assert row["computed_at"] == "2026-08-12T04:00:00Z"
        assert row["rationale"] and len(row["rationale"]) <= 500
        # merchant-facing: no statistics jargon
        for word in ("elasticity", "credible", "confidence interval", "argmax", "sigma"):
            assert word not in row["rationale"].lower()


def test_contract_rows_are_deterministic_and_clockless():
    fits, products, orders = portfolio()
    a = contract_rows(optimize_store(fits, products, orders).recommendations, "demo-store.myshopify.com", "2026-08-12T04:00:00Z")
    b = contract_rows(optimize_store(fits, products, orders).recommendations, "demo-store.myshopify.com", "2026-08-12T04:00:00Z")
    assert a == b


def test_rationale_mentions_the_binding_constraint():
    out = rec_of(run(fit(e=-0.5, low=-0.9, high=-0.2), p0=2000, cogs=500, max_change_pct=10.0, rounding="none"))
    assert "maximum price-change limit" in out.rationale
    floor = rec_of(run(fit(e=-3.0), p0=2000, cogs=1000, max_change_pct=50.0, margin_floor_pct=80.0, rounding="none"))
    assert "minimum-margin floor" in floor.rationale


def test_config_validation():
    with pytest.raises(ValueError):
        OptimizerConfig(rounding="end_49")
    with pytest.raises(ValueError):
        OptimizerConfig(max_change_pct=0.0)
    with pytest.raises(ValueError):
        OptimizerConfig(margin_floor_pct=99.0)
