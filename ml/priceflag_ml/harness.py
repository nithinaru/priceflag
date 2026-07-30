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

from .baselines import BracketElasticity, SeasonalNaive
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
    if (fc["low"].to_numpy() > fc["high"].to_numpy()).any():
        raise ValueError(f"SKU {sku}: forecast has low > high.")
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
    report = run_c2() if which == "c2" else run_c1()
    print(json.dumps(_json_safe(report), indent=2))


if __name__ == "__main__":
    main()
