"""C6: post-rollout reports + calibration tracking (R20, R30).

After a completed rollout, the merchant gets: what we predicted, what
actually happened, whether reality landed inside the predicted range
(`in_range` — the honesty metric the PRD calls the moat; it is reported even
when unflattering), an updated elasticity, and a plain-language narrative
(R25: no statistics vocabulary).

Mechanics:

- The counterfactual ("what would have sold without the change") comes from
  the C5 monitor's machinery: the C3 champion fit on pre-change days only.
- The predicted outcome band replays the proposal-time forecast: the
  elasticity fit's point/low/high map the price change onto unit ratios
  (ratio = (new/old)^elasticity), applied to the counterfactual baseline.
- Realized outcomes compare actuals against the counterfactual, so external
  drift doesn't get misattributed to the price change.
- Money is integer cents, always. Missing COGS -> profit fields are null and
  `in_range` falls back to the revenue range (stated in the narrative rather
  than fabricating a profit number — R3).

`calibration_summary` aggregates `in_range` across completed rollouts — the
R30 dashboard number ("% of forecasts landing in range").
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .baselines import BRACKET_HIGH, BRACKET_LOW, BRACKET_POINT, Z80
from .counterfactual import CounterfactualMonitor
from .elasticity import SkuFit

MODEL_VERSION = "rollout-report-1.0"


@dataclass(frozen=True)
class VariantPlan:
    sku: str  # internal key; mapped to variant_gid at emission
    old_price_cents: int
    new_price_cents: int
    cogs_cents: int | None  # None = merchant never provided COGS


def _outcome(units_base: float, units_new: float, plans_units: dict[str, tuple[float, float]], plans: list[VariantPlan]) -> dict:
    """Revenue/profit deltas in integer cents for one scenario."""
    revenue_delta = 0.0
    profit_delta: float | None = 0.0
    for p in plans:
        base_u, new_u = plans_units[p.sku]
        revenue_delta += new_u * p.new_price_cents - base_u * p.old_price_cents
        if profit_delta is not None:
            if p.cogs_cents is None:
                profit_delta = None
            else:
                profit_delta += new_u * (p.new_price_cents - p.cogs_cents) - base_u * (
                    p.old_price_cents - p.cogs_cents
                )
    return {
        "units_change_pct": float((units_new / units_base - 1.0) * 100.0) if units_base > 0 else 0.0,
        "revenue_delta_cents": int(round(revenue_delta)),
        "profit_delta_cents": int(round(profit_delta)) if profit_delta is not None else None,
    }


def _fmt_dollars(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.0f}"


def _narrative(
    price_change_pct: float,
    n_variants: int,
    realized: dict,
    predicted: dict,
    in_range: bool,
    direction: str | None,
    profit_known: bool,
) -> str:
    direction_word = "raised" if price_change_pct > 0 else "lowered"
    s1 = (
        f"You {direction_word} prices about {abs(price_change_pct):.0f}% on {n_variants} products. "
        f"Sales came in {abs(realized['units_change_pct']):.0f}% "
        f"{'lower' if realized['units_change_pct'] < 0 else 'higher'} than they would have been without the change."
    )
    if direction == "less_sensitive":
        s2 = "Your customers were less price-sensitive than we assumed — the change cost fewer sales than predicted."
    elif direction == "more_sensitive":
        s2 = "Your customers were more price-sensitive than we assumed — the change cost more sales than predicted."
    else:
        s2 = "That's close to what we predicted."
    money = realized["profit_delta_cents"] if profit_known else realized["revenue_delta_cents"]
    money_word = "profit" if profit_known else "revenue (profit unknown — add costs to see it)"
    s3 = (
        f"Over this window that worked out to {_fmt_dollars(money)} in {money_word}, "
        f"{'inside' if in_range else 'outside'} the range we predicted."
    )
    return " ".join([s1, s2, s3])


def build_report(
    rollout_id: str,
    plans: list[VariantPlan],
    pre_history: pd.DataFrame,
    during_actuals: pd.DataFrame,
    fits_before: dict[str, SkuFit | None],
    generated_at: str,
    variant_gids: dict[str, str] | None = None,
) -> dict:
    """One `rollout_report.schema.json` row for a completed rollout window."""
    if not plans:
        raise ValueError("build_report: no variants in the plan")
    gids = variant_gids or {}
    plan_by_sku = {p.sku: p for p in plans}
    treated = list(plan_by_sku)

    pre = pre_history[pre_history["sku"].isin(treated)]
    during = during_actuals[during_actuals["sku"].isin(treated)]
    if len(pre) == 0 or len(during) == 0:
        raise ValueError("build_report: empty pre or during window for the treated variants")

    # Counterfactual baseline per variant over the report window.
    monitor = CounterfactualMonitor(guardrail_drop_pct=0.5).fit(pre)
    days = monitor.assess(during)
    if not days:
        raise ValueError("build_report: no assessable days in the window")
    window_dates = pd.DatetimeIndex(sorted(during["date"].unique()))
    horizon = int((window_dates.max() - pd.Timestamp(pre["date"].max())).days)

    per_variant_expected: dict[str, float] = {}
    per_variant_actual: dict[str, float] = {}
    per_variant_revenue: dict[str, int] = {}
    for sku in treated:
        model = monitor._models[sku]
        fc = model.forecast(horizon)
        fc_in = fc[fc["date"].isin(window_dates)]
        per_variant_expected[sku] = float(fc_in["expected"].sum())
        g = during[during["sku"] == sku]
        per_variant_actual[sku] = float(g["units"].sum())
        per_variant_revenue[sku] = int(g["revenue_cents"].sum())

    base_total = sum(per_variant_expected.values())
    actual_total = sum(per_variant_actual.values())

    # Predicted outcome band: proposal-time elasticity scenarios applied to
    # the counterfactual baseline.
    def scenario(eps_of) -> tuple[float, dict[str, tuple[float, float]]]:
        total_new = 0.0
        per: dict[str, tuple[float, float]] = {}
        for sku in treated:
            p = plan_by_sku[sku]
            f = fits_before.get(sku)
            eps = eps_of(f)
            ratio = (p.new_price_cents / p.old_price_cents) ** eps
            new_u = per_variant_expected[sku] * ratio
            per[sku] = (per_variant_expected[sku], new_u)
            total_new += new_u
        return total_new, per

    pt_total, pt_per = scenario(lambda f: f.elasticity if f else BRACKET_POINT)
    lo_total, lo_per = scenario(lambda f: f.low if f else BRACKET_LOW)  # most price-sensitive
    hi_total, hi_per = scenario(lambda f: f.high if f else BRACKET_HIGH)  # least price-sensitive

    predicted_expected = _outcome(base_total, pt_total, pt_per, plans)
    scen_a = _outcome(base_total, lo_total, lo_per, plans)
    scen_b = _outcome(base_total, hi_total, hi_per, plans)

    def band_edge(key: str, pick) -> dict:
        vals = [s[key] for s in (scen_a, scen_b, predicted_expected)]
        if any(v is None for v in vals):
            return None
        return pick(vals)

    predicted_low = {
        "units_change_pct": min(s["units_change_pct"] for s in (scen_a, scen_b, predicted_expected)),
        "revenue_delta_cents": min(s["revenue_delta_cents"] for s in (scen_a, scen_b, predicted_expected)),
        "profit_delta_cents": band_edge("profit_delta_cents", min),
    }
    predicted_high = {
        "units_change_pct": max(s["units_change_pct"] for s in (scen_a, scen_b, predicted_expected)),
        "revenue_delta_cents": max(s["revenue_delta_cents"] for s in (scen_a, scen_b, predicted_expected)),
        "profit_delta_cents": band_edge("profit_delta_cents", max),
    }

    # Realized outcome vs the counterfactual.
    realized_per = {sku: (per_variant_expected[sku], per_variant_actual[sku]) for sku in treated}
    realized = _outcome(base_total, actual_total, realized_per, plans)

    profit_known = all(p.cogs_cents is not None for p in plans)
    key = "profit_delta_cents" if profit_known else "revenue_delta_cents"
    in_range = predicted_low[key] <= realized[key] <= predicted_high[key]

    # Updated elasticity from the realized cohort effect.
    log_price = float(
        np.average(
            [np.log(p.new_price_cents / p.old_price_cents) for p in plans],
            weights=[max(per_variant_expected[p.sku], 1e-9) for p in plans],
        )
    )
    elasticity_update = None
    if abs(log_price) > 1e-6 and base_total > 0 and actual_total > 0:
        after = float(np.log(actual_total / base_total) / log_price)
        after = float(np.clip(after, -6.0, 0.0))
        last = days[-1]
        se_log_ratio = max((np.log(last.ratio_high) - np.log(last.ratio_low)) / (2 * Z80), 1e-6)
        se_after = float(se_log_ratio / abs(log_price))
        befores = [fits_before[s].elasticity for s in treated if fits_before.get(s)]
        before = float(np.mean(befores)) if befores else None
        # A directional claim ("your customers were less price-sensitive than
        # assumed") must clear BOTH a practical gap and the estimate's own
        # noise — a single 30-day window with one ~10% change carries
        # se_after ~ 1.0, and over-claiming direction on noise would be
        # exactly the dishonesty R25/R30 forbid.
        if before is None or abs(after - before) <= max(0.25, Z80 * se_after):
            direction = "as_expected"
        elif abs(after) < abs(before):
            direction = "less_sensitive"
        else:
            direction = "more_sensitive"
        elasticity_update = {"before": before, "after": after, "se_after": se_after, "direction": direction}

    price_change_pct = float(
        np.mean([(p.new_price_cents / p.old_price_cents - 1.0) * 100.0 for p in plans])
    )
    report = {
        "contract_version": "1.0.0",
        "rollout_id": rollout_id,
        "generated_at": generated_at,
        "model_version": MODEL_VERSION,
        "window": {
            "start_day": str(window_dates.min().date()),
            "end_day": str(window_dates.max().date()),
            "days": int(len(window_dates)),
        },
        "predicted": {"expected": predicted_expected, "low": predicted_low, "high": predicted_high},
        "realized": realized,
        "in_range": bool(in_range),
        "elasticity_update": elasticity_update,
        "narrative": _narrative(
            price_change_pct,
            len(plans),
            realized,
            predicted_expected,
            in_range,
            elasticity_update["direction"] if elasticity_update else None,
            profit_known,
        ),
        "per_variant": [
            {
                "variant_gid": gids.get(sku, sku),
                "realized_units": per_variant_actual[sku],
                "expected_units": per_variant_expected[sku],
                "realized_revenue_cents": per_variant_revenue[sku],
                "realized_profit_cents": (
                    int(
                        round(
                            per_variant_actual[sku]
                            * (plan_by_sku[sku].new_price_cents - plan_by_sku[sku].cogs_cents)
                        )
                    )
                    if plan_by_sku[sku].cogs_cents is not None
                    else None
                ),
                "elasticity_after": elasticity_update["after"] if elasticity_update else None,
            }
            for sku in treated
        ],
    }
    return report


def calibration_summary(reports: list[dict]) -> dict:
    """R30 dashboard data: % of completed rollouts whose realized outcome
    landed inside the predicted range. Measuring it at all is the moat."""
    n = len(reports)
    if n == 0:
        return {"n_rollouts": 0, "pct_in_range": None}
    return {
        "n_rollouts": n,
        "pct_in_range": float(np.mean([r["in_range"] for r in reports])),
    }


def plans_from_price_history(
    history: pd.DataFrame,
    rollout_id: str,
    products: pd.DataFrame | None = None,
) -> list[VariantPlan]:
    """Recover a completed rollout's plan from the price journal (D-17).

    The journal is the record of what was actually *written to the storefront*,
    so a report built from it describes the prices shoppers really saw — not
    the prices a proposal intended, which can differ if a stage was interrupted
    or a variant was excluded at write time (R22). Every price write is
    journaled (R14), which is what makes that substitution safe.

    Per variant: `old_price_cents` is the `before_price_cents` of its earliest
    entry in this rollout, `new_price_cents` the `after_price_cents` of its
    latest. The earliest "before" is the pre-rollout price by construction —
    the same value the rollback path treats as the single source of truth.

    Restores are excluded. A `source='rollback'` entry is the *undoing* of the
    change; folding it in would make new_price equal old_price and report a
    completed rollout as having changed nothing. A rollout that was rolled back
    needs a different report, and this function is not it.

    `products` supplies `cogs_cents`; without it (or where COGS is null) the
    plan carries None and `build_report` states units and revenue but not
    profit, rather than inventing a margin (R3).
    """
    if len(history) == 0:
        return []

    rows = history[history["rollout_id"] == rollout_id]
    if "source" in rows.columns:
        rows = rows[rows["source"] != "rollback"]
    if len(rows) == 0:
        return []

    cogs: dict[str, int | None] = {}
    if products is not None and len(products) > 0 and "cogs_cents" in products.columns:
        for rec in products.itertuples():
            value = getattr(rec, "cogs_cents", None)
            cogs[str(rec.variant_gid)] = None if value is None or pd.isna(value) else int(value)

    plans: list[VariantPlan] = []
    for gid, group in rows.sort_values("applied_at").groupby("variant_gid", sort=True):
        old = group["before_price_cents"].iloc[0]
        new = group["after_price_cents"].iloc[-1]
        if pd.isna(old) or pd.isna(new):
            continue
        old, new = int(old), int(new)
        if old <= 0 or new <= 0 or old == new:
            # A no-op or an unusable price is not a plan. Skipped rather than
            # reported, so a zero never reaches the ratio arithmetic.
            continue
        plans.append(
            VariantPlan(sku=str(gid), old_price_cents=old, new_price_cents=new, cogs_cents=cogs.get(str(gid)))
        )
    return plans


def reports_contract_rows(reports: list[dict]) -> list[dict]:
    """Reports as they go over the wire. `build_report` already emits
    `rollout_report.schema.json` shape; this is the seam where a transport
    concern (ordering, stability) lives instead of leaking into the model."""
    return sorted(reports, key=lambda r: (r.get("rollout_id", ""), r.get("generated_at", "")))
