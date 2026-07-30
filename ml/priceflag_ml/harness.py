"""Eval harness: rolling-origin backtests + golden-recovery evaluation.

This is the gate from PRD R28: no model ships or replaces another unless it
beats the incumbent here. The harness itself is under test (tests/test_harness.py).

Run the C1 report (records the incumbent scores every challenger must beat)::

    uv run python -m priceflag_ml.harness
"""

from __future__ import annotations

import json
from collections.abc import Callable

import numpy as np
import pandas as pd

from .baselines import BracketBand, BracketElasticity, SeasonalNaive
from .golden import GoldenConfig, GoldenStore, generate_store
from .metrics import elasticity_recovery, interval_coverage, mape, pinball_loss, wape

ForecasterFactory = Callable[[], object]  # -> object with .fit(df) and .forecast(h)
ElasticityEstimator = Callable[[pd.DataFrame], dict]  # sku history -> {"elasticity": ...}


def sku_frames(orders: pd.DataFrame) -> dict[str, pd.DataFrame]:
    return {str(sku): g.sort_values("date").reset_index(drop=True) for sku, g in orders.groupby("sku")}


def _require_daily_contiguity(sku: str, df: pd.DataFrame) -> None:
    """One row per consecutive calendar day, or the positional split/lag logic
    downstream is silently wrong. Real `order_days` pulls must be densified
    first (data.densify_daily)."""
    dates = pd.DatetimeIndex(df["date"])
    gaps = np.diff(dates.to_numpy()) != np.timedelta64(1, "D")
    if gaps.any():
        first = dates[int(np.argmax(gaps))].date()
        raise ValueError(
            f"SKU {sku}: history is not one-row-per-day (gap/duplicate after {first}). "
            "Densify missing days (data.densify_daily) before backtesting."
        )


def _validate_forecast(sku: str, fc: pd.DataFrame, test_dates: pd.DatetimeIndex) -> None:
    """A forecast that is misaligned or non-finite must fail loudly — this
    harness is the R28 ship gate and its bands drive auto-rollback."""
    fc_dates = pd.DatetimeIndex(fc["date"])
    if len(fc) != len(test_dates) or not (fc_dates == test_dates).all():
        raise ValueError(
            f"SKU {sku}: forecast dates {fc_dates[0].date()}..{fc_dates[-1].date()} do not match "
            f"the test window {test_dates[0].date()}..{test_dates[-1].date()} — refusing to score misaligned output."
        )
    vals = fc[["expected", "low", "high"]].to_numpy(dtype=float)
    if not np.isfinite(vals).all():
        raise ValueError(f"SKU {sku}: forecast contains non-finite expected/low/high values.")
    if (fc["low"].to_numpy() > fc["expected"].to_numpy()).any() or (
        fc["expected"].to_numpy() > fc["high"].to_numpy()
    ).any():
        raise ValueError(f"SKU {sku}: forecast violates low <= expected <= high.")
    if (fc["low"].to_numpy() < 0).any():
        raise ValueError(f"SKU {sku}: negative low band for a units forecast.")


def rolling_origin_backtest(
    orders: pd.DataFrame,
    factory: ForecasterFactory,
    horizon: int = 14,
    n_origins: int = 4,
    stride: int = 7,
    min_train: int = 63,
) -> dict:
    """Rolling-origin backtest of a forecaster over every SKU.

    For each SKU and each origin, fit on data up to the origin and forecast
    ``horizon`` days ahead; score point accuracy (WAPE/MAPE), 80%-interval
    coverage, and pinball loss at q10/q90 (band edges scored as quantile
    forecasts). Stockout days are excluded from scoring — zero units from an
    empty shelf is not forecast error.

    Returns per-SKU scores and pooled aggregates.
    """
    rows: list[pd.DataFrame] = []
    for sku, df in sku_frames(orders).items():
        _require_daily_contiguity(sku, df)
        t_total = len(df)
        for i in range(n_origins):
            origin = t_total - horizon - i * stride
            if origin < min_train:
                continue
            train, test = df.iloc[:origin], df.iloc[origin : origin + horizon]
            model = factory()
            model.fit(train)
            fc = model.forecast(horizon)
            _validate_forecast(sku, fc, pd.DatetimeIndex(test["date"]))
            out = pd.DataFrame(
                {
                    "sku": sku,
                    "origin": origin,
                    "date": test["date"].to_numpy(),
                    "actual": test["units"].to_numpy(dtype=float),
                    "expected": fc["expected"].to_numpy(),
                    "low": fc["low"].to_numpy(),
                    "high": fc["high"].to_numpy(),
                    "stockout": (
                        test["stockout"].to_numpy(dtype=bool)
                        if "stockout" in test.columns
                        else np.zeros(len(test), bool)
                    ),
                }
            )
            rows.append(out)

    if not rows:
        raise ValueError("No (SKU, origin) pair had enough history — lower min_train or n_origins.")

    all_rows = pd.concat(rows, ignore_index=True)
    scored = all_rows[~all_rows["stockout"]]

    per_sku = []
    for sku, g in scored.groupby("sku"):
        per_sku.append(
            {
                "sku": sku,
                "n_days": len(g),
                "wape": wape(g["actual"], g["expected"]),
                "mape": mape(g["actual"], g["expected"]),
                "coverage_80": interval_coverage(g["actual"], g["low"], g["high"]),
                "pinball_q10": pinball_loss(g["actual"], g["low"], 0.10),
                "pinball_q90": pinball_loss(g["actual"], g["high"], 0.90),
            }
        )
    per_sku_df = pd.DataFrame(per_sku)

    aggregate = {
        "n_skus": int(per_sku_df["sku"].nunique()),
        "n_scored_days": int(len(scored)),
        "median_wape": float(per_sku_df["wape"].median()),
        "median_mape": float(per_sku_df["mape"].median()),
        "pooled_coverage_80": interval_coverage(scored["actual"], scored["low"], scored["high"]),
        "pooled_pinball_q10": pinball_loss(scored["actual"], scored["low"], 0.10),
        "pooled_pinball_q90": pinball_loss(scored["actual"], scored["high"], 0.90),
    }
    return {"per_sku": per_sku_df, "aggregate": aggregate, "predictions": all_rows}


def compare_forecasters(
    orders: pd.DataFrame, champion: ForecasterFactory, challenger: ForecasterFactory, **backtest_kw
) -> dict:
    """Head-to-head: fraction of SKUs where the challenger's WAPE beats the champion's.

    This is the C3 acceptance metric ("beats seasonal-naive on >=70% of golden
    SKUs") and the general R28 gate for forecasters.
    """
    a = rolling_origin_backtest(orders, champion, **backtest_kw)["per_sku"].set_index("sku")
    b = rolling_origin_backtest(orders, challenger, **backtest_kw)["per_sku"].set_index("sku")
    joined = a.join(b, lsuffix="_champion", rsuffix="_challenger", how="inner")
    # SKUs unscoreable on either side (NaN WAPE, e.g. all-zero actuals) are
    # excluded from the head-to-head rather than silently counted as losses.
    scoreable = joined[joined["wape_champion"].notna() & joined["wape_challenger"].notna()]
    wins = scoreable["wape_challenger"] < scoreable["wape_champion"]
    return {
        "n_skus": int(len(scoreable)),
        "n_unscoreable": int(len(joined) - len(scoreable)),
        "challenger_win_rate": float(wins.mean()) if len(scoreable) else float("nan"),
        "median_wape_champion": float(scoreable["wape_champion"].median()),
        "median_wape_challenger": float(scoreable["wape_challenger"].median()),
    }


def evaluate_elasticity(estimator: ElasticityEstimator, store: GoldenStore, tol: float = 0.3) -> dict:
    """Score an elasticity estimator against golden truth.

    Reports overall recovery and the identifiable slice (SKUs with >=2
    *permanent* price levels — the C2 acceptance slice: +-0.3 recovery is only
    a fair ask where the history contains real, non-promo price variation).
    """
    estimates: dict[str, float] = {}
    for sku, df in sku_frames(store.orders).items():
        est = estimator(df)
        estimates[sku] = float(est["elasticity"])

    truth_all = dict(zip(store.truth["sku"], store.truth["elasticity"]))
    rich_skus = set(store.truth.loc[store.truth["n_permanent_levels"] >= 2, "sku"])
    truth_rich = {k: v for k, v in truth_all.items() if k in rich_skus}

    return {
        "all_skus": elasticity_recovery(estimates, truth_all, tol=tol),
        "identifiable_skus": elasticity_recovery(
            {k: v for k, v in estimates.items() if k in rich_skus}, truth_rich, tol=tol
        ),
    }


def run_c1(cfg: GoldenConfig | None = None) -> dict:
    """C1 report: incumbent scores on golden data — the bar for every challenger."""
    store = generate_store(cfg)
    naive = rolling_origin_backtest(store.orders, SeasonalNaive)
    band = rolling_origin_backtest(store.orders, BracketBand)
    bracket = evaluate_elasticity(BracketElasticity().estimate, store)
    return {
        "golden_config": {
            "n_skus": store.config.n_skus,
            "days": store.config.days,
            "seed": store.config.seed,
            "end_date": store.config.end_date,
        },
        "incumbents": {
            "seasonal_naive_backtest": naive["aggregate"],
            "bracket_band_backtest": band["aggregate"],
            "bracket_elasticity_recovery": bracket,
        },
    }


def run_c2(seeds: tuple[int, ...] = (7, 11, 42, 99, 123)) -> dict:
    """C2 report: EB-Poisson elasticity challenger vs bracket incumbent,
    averaged over several golden universes (single-seed verdicts are noisy).
    Also reports CI coverage of the true elasticity — the honesty metric."""
    from .elasticity import MODEL_VERSION, RidgeElasticity, fit_store

    per_seed = []
    for seed in seeds:
        store = generate_store(GoldenConfig(seed=seed))
        truth = dict(zip(store.truth["sku"], store.truth["elasticity"]))
        challenger = evaluate_elasticity(RidgeElasticity(store.orders, seed=0).estimate, store)
        incumbent = evaluate_elasticity(BracketElasticity().estimate, store)
        fits = fit_store(store.orders, seed=0)
        ci = [f.low <= truth[f.sku] <= f.high for f in fits if f.confidence != "assumption"]
        tiers = pd.Series([f.confidence for f in fits]).value_counts().to_dict()
        per_seed.append(
            {
                "seed": seed,
                "challenger_identifiable": challenger["identifiable_skus"],
                "incumbent_identifiable": incumbent["identifiable_skus"],
                "ci80_coverage_of_truth": float(np.mean(ci)) if ci else float("nan"),
                "tiers": tiers,
            }
        )

    def _mean(path_a: str, path_b: str) -> float:
        return float(np.mean([s[path_a][path_b] for s in per_seed]))

    summary = {
        "model_version": MODEL_VERSION,
        "n_seeds": len(seeds),
        "challenger_mae": _mean("challenger_identifiable", "mae"),
        "incumbent_mae": _mean("incumbent_identifiable", "mae"),
        "challenger_within_0.3": _mean("challenger_identifiable", "pct_within_0.3"),
        "incumbent_within_0.3": _mean("incumbent_identifiable", "pct_within_0.3"),
        "ci80_coverage_of_truth": float(np.mean([s["ci80_coverage_of_truth"] for s in per_seed])),
    }
    summary["verdict"] = (
        "challenger wins"
        if summary["challenger_within_0.3"] > summary["incumbent_within_0.3"]
        and summary["challenger_mae"] <= summary["incumbent_mae"] * 1.02
        else "incumbent stays"
    )
    return {"summary": summary, "per_seed": per_seed}


def run_c4(seeds: tuple[int, ...] = (7, 11, 42, 99, 123)) -> dict:
    """C4 report: hierarchical (category-pooled) elasticity challenger vs the
    C2 champion, on category-structured golden universes. Scores both the
    thin slice (1 permanent price level — where category borrowing is
    supposed to help) and the identifiable slice (where it must not hurt)."""
    from .elasticity import fit_store
    from .elasticity_hier import MODEL_VERSION as HIER_VERSION
    from .elasticity_hier import fit_store_hier

    per_seed = []
    for seed in seeds:
        store = generate_store(GoldenConfig(seed=seed, n_categories=4))
        truth = dict(zip(store.truth["sku"], store.truth["elasticity"]))
        cats = dict(zip(store.truth["sku"], store.truth["category"]))
        thin = set(store.truth.loc[store.truth["n_permanent_levels"] == 1, "sku"])
        ident = set(store.truth["sku"]) - thin
        champ = {f.sku: f.elasticity for f in fit_store(store.orders, seed=0)}
        chall = {f.sku: f.elasticity for f in fit_store_hier(store.orders, categories=cats, seed=0)}
        per_seed.append(
            {
                "seed": seed,
                "thin_mae_champion": float(np.mean([abs(champ[s] - truth[s]) for s in thin])),
                "thin_mae_challenger": float(np.mean([abs(chall[s] - truth[s]) for s in thin])),
                "ident_mae_champion": float(np.mean([abs(champ[s] - truth[s]) for s in ident])),
                "ident_mae_challenger": float(np.mean([abs(chall[s] - truth[s]) for s in ident])),
            }
        )

    summary = {
        "challenger_version": HIER_VERSION,
        "champion_version": "elasticity-poisson-eb-1.0",
        "n_seeds": len(seeds),
        "thin_mae_champion": float(np.mean([s["thin_mae_champion"] for s in per_seed])),
        "thin_mae_challenger": float(np.mean([s["thin_mae_challenger"] for s in per_seed])),
        "ident_mae_champion": float(np.mean([s["ident_mae_champion"] for s in per_seed])),
        "ident_mae_challenger": float(np.mean([s["ident_mae_challenger"] for s in per_seed])),
    }
    summary["verdict"] = (
        "challenger wins"
        if summary["thin_mae_challenger"] < summary["thin_mae_champion"]
        and summary["ident_mae_challenger"] <= summary["ident_mae_champion"] * 1.03
        else "incumbent stays"
    )
    return {"summary": summary, "per_seed": per_seed}


def _c5_scenario(seed: int, rep: int, effect_ratio: float, monitor_days: int = 14, n_treated: int = 8):
    """One golden rollout: treated SKUs re-simulated with a KNOWN effect from
    the change day. Returns (pre_history, during_actuals, treated_skus)."""
    from .golden import GoldenConfig, generate_store, simulate_sku

    cfg = GoldenConfig(seed=seed)
    store = generate_store(cfg)
    dates = pd.date_range(end=pd.Timestamp(cfg.end_date), periods=cfg.days, freq="D")
    change_idx = cfg.days - monitor_days
    treated = list(store.truth["sku"])[::3][:n_treated]
    frames = []
    for i, sku in enumerate(treated):
        truth = store.skus[sku]
        df = simulate_sku(
            truth,
            dates,
            np.random.default_rng([seed, 5000 + rep, i]),
            effect_ratio=effect_ratio,
            effect_start_idx=change_idx,
        )
        frames.append(df)
    panel = pd.concat(frames, ignore_index=True)
    cut = dates[change_idx]
    return panel[panel["date"] < cut], panel[panel["date"] >= cut], treated


def run_c5(
    seeds: tuple[int, ...] = (7, 11, 42),
    reps_per_seed: int = 10,
    guardrail_drop: float = 0.20,
) -> dict:
    """C5 report: counterfactual breach probability vs the raw-threshold rule,
    across an effect-size grid (all vs a 20% guardrail on an 8-SKU cohort):

    - null (ratio 1.0): false-positive rate over a 14-day window
    - catastrophic (0.50): must flag within 2 days (the brief's bar)
    - moderate (0.65): must flag reliably, median <= 4 days
    - boundary (0.75): barely past the guardrail — slow/partial detection is
      CORRECT behavior here, reported but not gated

    Verdict also requires dominating the raw 2-consecutive-days-below-low
    incumbent rule (R29: breach probability replaces thresholds only once it
    beats them on the harness).
    """
    from .counterfactual import MODEL_VERSION as CF_VERSION
    from .counterfactual import CounterfactualMonitor

    def run_one(seed: int, rep: int, ratio: float) -> dict:
        pre, during, _ = _c5_scenario(seed, rep, ratio)
        monitor = CounterfactualMonitor(guardrail_drop_pct=guardrail_drop).fit(pre)
        days = monitor.assess(during)
        probs = [a.breach_probability for a in days]
        below_low = [a.actual < a.low for a in days]
        # counterfactual rule: breach prob >= 0.8 (Lane B's wired threshold)
        cf_day = next((i + 1 for i, p in enumerate(probs) if p >= 0.8), None)
        # incumbent raw rule: 2 consecutive cohort days below the band low
        raw_day = next(
            (i + 1 for i in range(1, len(below_low)) if below_low[i] and below_low[i - 1]), None
        )
        return {"cf_day": cf_day, "raw_day": raw_day}

    def sweep(ratio: float) -> dict:
        cf_days, raw_days, n = [], [], 0
        cf_within2 = raw_within2 = cf_hit = raw_hit = 0
        for seed in seeds:
            for rep in range(reps_per_seed):
                r = run_one(seed, rep, ratio)
                n += 1
                if r["cf_day"] is not None:
                    cf_hit += 1
                    cf_days.append(r["cf_day"])
                    cf_within2 += r["cf_day"] <= 2
                if r["raw_day"] is not None:
                    raw_hit += 1
                    raw_days.append(r["raw_day"])
                    raw_within2 += r["raw_day"] <= 2
        return {
            "n": n,
            "cf_flag_rate": cf_hit / n,
            "cf_within_2_days": cf_within2 / n,
            "cf_median_day": float(np.median(cf_days)) if cf_days else None,
            "raw_flag_rate": raw_hit / n,
            "raw_within_2_days": raw_within2 / n,
            "raw_median_day": float(np.median(raw_days)) if raw_days else None,
        }

    grid = {
        "null_1.00": sweep(1.0),
        "catastrophic_0.50": sweep(0.50),
        "moderate_0.65": sweep(0.65),
        "boundary_0.75": sweep(0.75),
    }
    fpr_cf = grid["null_1.00"]["cf_flag_rate"]
    fpr_raw = grid["null_1.00"]["raw_flag_rate"]
    cat, mod = grid["catastrophic_0.50"], grid["moderate_0.65"]
    summary = {
        "model_version": CF_VERSION,
        "guardrail_drop": guardrail_drop,
        "n_per_cell": grid["null_1.00"]["n"],
        "grid": grid,
        "false_positive_rate": fpr_cf,
        "incumbent_false_positive_rate": fpr_raw,
        "acceptance_met": (
            fpr_cf <= 0.10 and cat["cf_within_2_days"] >= 0.75 and mod["cf_flag_rate"] >= 0.90 and (mod["cf_median_day"] or 99) <= 4
        ),
    }
    dominates = fpr_cf <= fpr_raw and cat["cf_within_2_days"] >= cat["raw_within_2_days"]
    summary["verdict"] = "challenger wins" if summary["acceptance_met"] and dominates else "incumbent stays"
    return {"summary": summary}


def _c6_scenario(seed: int, rep: int, price_up_pct: float = 0.10, monitor_days: int = 30, n_treated: int = 8):
    """A completed golden rollout: +10% price on the treated SKUs, demand
    responds with each SKU's TRUE elasticity. Returns
    (plans, pre_history, during_actuals, fits_before, store)."""
    from .elasticity import fit_store
    from .golden import GoldenConfig, generate_store, simulate_sku
    from .reports import VariantPlan

    cfg = GoldenConfig(seed=seed)
    store = generate_store(cfg)
    dates = pd.date_range(end=pd.Timestamp(cfg.end_date), periods=cfg.days, freq="D")
    change_idx = cfg.days - monitor_days
    treated = list(store.truth["sku"])[::3][:n_treated]

    plans, frames = [], []
    for i, sku in enumerate(treated):
        truth = store.skus[sku]
        old_price = int(truth.price_cents[change_idx - 1])
        new_price = int(round(old_price * (1 + price_up_pct)))
        ratio = (new_price / old_price) ** truth.elasticity
        df = simulate_sku(
            truth,
            dates,
            np.random.default_rng([seed, 6000 + rep, i]),
            effect_ratio=ratio,
            effect_start_idx=change_idx,
        )
        # During the rollout the shopper pays the NEW price.
        post = df["date"] >= dates[change_idx]
        df.loc[post, "price_cents"] = new_price
        df.loc[post, "revenue_cents"] = (df.loc[post, "units"] * new_price).astype(int)
        frames.append(df)
        plans.append(
            VariantPlan(
                sku=sku, old_price_cents=old_price, new_price_cents=new_price, cogs_cents=truth.cogs_cents
            )
        )
    panel = pd.concat(frames, ignore_index=True)
    cut = dates[change_idx]
    pre, during = panel[panel["date"] < cut], panel[panel["date"] >= cut]
    fits_before = {f.sku: f for f in fit_store(store.orders, seed=0) if f.sku in treated}
    return plans, pre, during, fits_before, store


def run_c6(seeds: tuple[int, ...] = (7, 11, 42), reps_per_seed: int = 3) -> dict:
    """C6 report: end-to-end honesty check of the whole pipeline. For golden
    rollouts whose demand responds with the TRUE elasticities: generate the
    post-rollout report, validate it against the contract, and measure R30
    calibration (% of realized outcomes inside the predicted range) plus the
    updated elasticity's recovery of the cohort truth."""
    from .reports import MODEL_VERSION as RPT_VERSION
    from .reports import build_report, calibration_summary

    reports, eps_errors = [], []
    for seed in seeds:
        for rep in range(reps_per_seed):
            plans, pre, during, fits_before, store = _c6_scenario(seed, rep)
            report = build_report(
                rollout_id="123e4567-e89b-42d3-a456-426614174000",
                plans=plans,
                pre_history=pre,
                during_actuals=during,
                fits_before=fits_before,
                generated_at="2026-07-29T00:00:00Z",
            )
            reports.append(report)
            if report["elasticity_update"]:
                truth = dict(zip(store.truth["sku"], store.truth["elasticity"]))
                w = {p.sku: 1.0 for p in plans}
                cohort_true = float(np.mean([truth[p.sku] for p in plans]))
                eps_errors.append(abs(report["elasticity_update"]["after"] - cohort_true))

    cal = calibration_summary(reports)
    summary = {
        "model_version": RPT_VERSION,
        "n_rollouts": cal["n_rollouts"],
        "pct_in_range": cal["pct_in_range"],
        "elasticity_after_mae_vs_cohort_truth": float(np.mean(eps_errors)) if eps_errors else None,
        "acceptance_met": cal["pct_in_range"] is not None and cal["pct_in_range"] >= 0.7,
    }
    return {"summary": summary}


def run_c3(seeds: tuple[int, ...] = (7, 11, 42, 99, 123)) -> dict:
    """C3 report: CleanLevel baseline challenger vs the bracket band (the
    band the evaluator actually ships) and vs seasonal-naive (the brief's
    named acceptance), averaged over several golden universes."""
    from .forecaster import MODEL_VERSION, CleanLevelBaseline

    per_seed = []
    per_sku_coverage: list[float] = []
    nonfloored_cov: list[float] = []
    for seed in seeds:
        store = generate_store(GoldenConfig(seed=seed))
        out = rolling_origin_backtest(store.orders, CleanLevelBaseline)
        agg = out["aggregate"]
        pred = out["predictions"]
        pred = pred[~pred["stockout"]]
        # Auto-rollback fires per SKU, and floored days (expected < 3, low=0)
        # structurally over-cover — so calibration must be checked where it
        # can actually bite: non-floored days, and the worst SKUs.
        nf = pred[pred["expected"] >= 3.0]
        if len(nf):
            nonfloored_cov.append(interval_coverage(nf["actual"], nf["low"], nf["high"]))
        for _, g in pred.groupby("sku"):
            per_sku_coverage.append(interval_coverage(g["actual"], g["low"], g["high"]))
        vs_band = compare_forecasters(store.orders, BracketBand, CleanLevelBaseline)
        vs_naive = compare_forecasters(store.orders, SeasonalNaive, CleanLevelBaseline)
        per_seed.append(
            {
                "seed": seed,
                "challenger": agg,
                "win_rate_vs_bracket_band": vs_band["challenger_win_rate"],
                "win_rate_vs_seasonal_naive": vs_naive["challenger_win_rate"],
                "median_wape_bracket_band": vs_band["median_wape_champion"],
            }
        )

    summary = {
        "model_version": MODEL_VERSION,
        "n_seeds": len(seeds),
        "median_wape": float(np.mean([s["challenger"]["median_wape"] for s in per_seed])),
        "median_wape_bracket_band": float(np.mean([s["median_wape_bracket_band"] for s in per_seed])),
        "pooled_coverage_80": float(np.mean([s["challenger"]["pooled_coverage_80"] for s in per_seed])),
        "nonfloored_coverage_80": float(np.mean(nonfloored_cov)),
        "per_sku_coverage_p10": float(np.quantile(per_sku_coverage, 0.10)),
        "win_rate_vs_bracket_band": float(np.mean([s["win_rate_vs_bracket_band"] for s in per_seed])),
        "win_rate_vs_seasonal_naive": float(np.mean([s["win_rate_vs_seasonal_naive"] for s in per_seed])),
    }
    summary["verdict"] = (
        "challenger wins"
        if summary["win_rate_vs_bracket_band"] > 0.5
        and summary["win_rate_vs_seasonal_naive"] >= 0.7
        and abs(summary["nonfloored_coverage_80"] - 0.80) <= 0.10
        and summary["per_sku_coverage_p10"] >= 0.65
        else "incumbent stays"
    )
    return {"summary": summary, "per_seed": per_seed}


def _json_safe(obj):
    """Replace NaN/inf with None so the report is always valid JSON."""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, float) and not np.isfinite(obj):
        return None
    return obj


def main() -> None:
    import sys

    which = sys.argv[1] if len(sys.argv) > 1 else "c1"
    report = {"c1": run_c1, "c2": run_c2, "c3": run_c3, "c4": run_c4, "c5": run_c5, "c6": run_c6}[which]()
    print(json.dumps(_json_safe(report), indent=2))


if __name__ == "__main__":
    main()
