"""C7: lattice price optimizer — constrained argmax of expected daily profit.

For each SKU with a usable elasticity fit, search a *rounding lattice* of
candidate prices around the current price and pick the candidate that
maximizes expected daily profit under the same demand model the app's
forecast uses::

    units1 = units0 * (P1 / P0) ** elasticity
    profit/day = units1 * (P1 * realization - cogs)

`realization` is the revenue realization rate (net revenue after discounts /
gross revenue at list price), mirroring `lib/engine/forecast.ts`'s
`revenueRealizationRate` — the daily aggregates expose `revenue_cents`
(net) and `price_cents` (list), so the rate is
``sum(revenue_cents) / sum(units * price_cents)`` over the baseline window,
clamped to [0, 1] exactly like the app. Baseline units/day is the mean of
clean (non-promo, non-stockout) days inside the trailing 28-day window
(`BASELINE_WINDOW_DAYS`, mirroring lib/contracts.ts) — promo days inflate
and stockout days deflate the at-current-price demand level, so the clean
mean is the honest baseline for a permanent price change.

Honesty rules (CLAUDE.md): money is integer cents everywhere; SKUs the data
cannot support are *skipped with a reason*, never recommended on vibes:

- no cogs (or cogs <= 0): daily profit is undefined — no recommendation.
- confidence == "assumption": the fit carries no store signal.
- elasticity >= 0: an upward-sloping demand estimate would tell the
  optimizer "raise the price forever" — that is confounding, not signal, so
  the SKU is skipped rather than clamped (documented decision, tested).
- zero baseline demand: nothing to scale, nothing to optimize.
- no credible bounds AND no se: the robust evaluation is impossible, and a
  recommendation without a cautious check is a black box.

Robustness — the pessimistic bound (comment carried into `_worst_elasticity`):
for a price INCREASE the worst case is customers being MOST price-sensitive
(the most-negative bound: demand falls hardest), while for a CUT the worst
case is customers being LEAST price-sensitive (the bound nearest zero: you
give up margin without buying the volume). Each candidate is re-scored at
the bound that hurts *its* direction; `robust_price_cents` is the argmax of
that worst-case profit. When the fit lacks `low`/`high`, bounds fall back to
``elasticity ± 1.2816 * se`` (CI80, matching the fits' Z80 convention) and
the recommendation notes it.

Determinism: no ``datetime.now()``/randomness in here — `computed_at` is
passed by the caller (same convention as `elasticity.fits_contract_rows`).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

MODEL_VERSION = "optimizer-lattice-1.0"
CONTRACT_VERSION = "1.0.0"

Z80 = 1.2816  # two-sided 80% normal quantile (matches elasticity.py / baselines.py)
BASELINE_WINDOW_DAYS = 28  # lib/contracts.ts BASELINE_WINDOW_DAYS
INVENTORY_HORIZON_DAYS = 30  # inventory_quantity / 30 caps servable daily units
# 'none' rounding means a grid of cent steps; an uncapped grid over a wide
# price would evaluate tens of thousands of candidates for no extra insight,
# so the grid is thinned to at most this many (endpoints always kept).
MAX_NONE_CANDIDATES = 201
# When the caller sets no max-change cap the lattice still needs a finite
# span; an optimum pressed against THIS edge is a search-grid artifact
# ("lattice_edge"), not a merchant constraint ("max_change").
DEFAULT_SPAN_PCT = 30.0

ROUNDINGS = ("none", "end_99", "end_95", "end_00")
# Schema bounds for the elasticity fields (contracts/price_recommendation).
_SCHEMA_E_MIN, _SCHEMA_E_MAX = -12.0, 2.0


@dataclass(frozen=True)
class OptimizerConfig:
    """Constraint knobs for one optimizer run (v1 constraint set)."""

    rounding: str = "end_99"
    # Cap on |price change| from current, in percent. None = uncapped: the
    # lattice then spans DEFAULT_SPAN_PCT and edge-pressed optima report
    # "lattice_edge" instead of "max_change".
    max_change_pct: float | None = 15.0
    # Minimum gross margin over cogs, percent: price >= cogs * (1 + floor/100).
    # None = no floor.
    margin_floor_pct: float | None = 20.0
    # When True and inventory_quantity is a finite non-negative number, the
    # objective caps servable daily units at inventory / horizon days.
    inventory_aware: bool = True
    inventory_horizon_days: int = INVENTORY_HORIZON_DAYS

    def __post_init__(self) -> None:
        if self.rounding not in ROUNDINGS:
            raise ValueError(f"rounding must be one of {ROUNDINGS}, got {self.rounding!r}")
        if self.max_change_pct is not None and not (0.0 < self.max_change_pct <= 400.0):
            raise ValueError("max_change_pct must be in (0, 400] or None")
        if self.margin_floor_pct is not None and not (0.0 <= self.margin_floor_pct <= 95.0):
            raise ValueError("margin_floor_pct must be in [0, 95] or None")
        if self.inventory_horizon_days < 1:
            raise ValueError("inventory_horizon_days must be >= 1")


@dataclass(frozen=True)
class SkuRecommendation:
    sku: str
    current_price_cents: int
    recommended_price_cents: int  # nominal argmax (point-estimate elasticity)
    robust_price_cents: int  # argmax of worst-case profit
    rounding: str
    elasticity: float
    elasticity_low: float  # bounds actually used in the robust evaluation
    elasticity_high: float
    bounds_from_se: bool  # True when low/high were rebuilt from se (CI80)
    confidence: str  # inherited from the fit ('fitted' | 'partial')
    fit_model_version: str | None
    baseline_units_per_day: float
    realization_rate: float
    # All four deltas are evaluated AT recommended_price_cents (schema:
    # "expected" describes the nominal recommendation; the robust numbers show
    # what caution says about that same price — they may be negative).
    nominal_profit_delta_cents_per_day: int
    robust_profit_delta_cents_per_day: int
    nominal_revenue_delta_cents_per_day: int
    robust_revenue_delta_cents_per_day: int
    margin_floor_pct: float | None
    max_change_pct: float | None
    inventory_cap_applied: bool
    binding: tuple[str, ...]
    candidates_evaluated: int
    rationale: str


@dataclass(frozen=True)
class SkuSkip:
    sku: str
    reason: str  # machine-readable, stable
    detail: str  # plain-language sentence for logs


@dataclass(frozen=True)
class PortfolioResult:
    recommendations: list[SkuRecommendation]
    skips: list[SkuSkip]


# ---------------------------------------------------------------------------
# candidate lattice
# ---------------------------------------------------------------------------


def candidate_lattice(price_cents: int, rounding: str, span_pct: float) -> list[int]:
    """Candidate prices within [P0*(1-span), P0*(1+span)] on the ending lattice.

    Mirrors `lib/money.ts applyRounding` semantics: for 'end_99'/'end_95'/
    'end_00' each whole-dollar block d contributes its ending candidate
    ``d*100 + ending`` (0 for end_00); 'none' is a bounded grid of cent
    steps. Integer cents only, ascending, all >= 1.
    """
    if rounding not in ROUNDINGS:
        raise ValueError(f"rounding must be one of {ROUNDINGS}, got {rounding!r}")
    lo = max(1, math.ceil(price_cents * (1.0 - span_pct / 100.0)))
    hi = math.floor(price_cents * (1.0 + span_pct / 100.0))
    if hi < lo:
        return []
    if rounding == "none":
        n = hi - lo + 1
        if n <= MAX_NONE_CANDIDATES:
            return list(range(lo, hi + 1))
        step = math.ceil((hi - lo) / (MAX_NONE_CANDIDATES - 1))
        out = list(range(lo, hi + 1, step))
        if out[-1] != hi:
            out.append(hi)  # the cap edge itself is always a candidate
        return out
    ending = {"end_99": 99, "end_95": 95, "end_00": 0}[rounding]
    out = []
    for dollars in range(lo // 100, hi // 100 + 1):
        cand = dollars * 100 + ending
        if lo <= cand <= hi and cand >= 1:
            out.append(cand)
    return out


# ---------------------------------------------------------------------------
# baseline demand + realization from the canonical daily frame
# ---------------------------------------------------------------------------


def baseline_stats(frame: pd.DataFrame | None, window_days: int = BASELINE_WINDOW_DAYS) -> tuple[float, float]:
    """(units_per_day, realization_rate) for one SKU's canonical daily frame.

    Clean-day mean over the trailing `window_days` calendar days, anchored at
    the last observed day (like the app, a sync that finished yesterday must
    not read as zero-sale days). Realization = net revenue_cents / gross
    (units * list price_cents) over the same clean days, clamped to [0, 1]
    exactly as `lib/engine/forecast.ts` clamps `revenueRealizationRate`;
    falls back to 1.0 when gross is zero.
    """
    if frame is None or len(frame) == 0:
        return 0.0, 1.0
    df = frame.sort_values("date")
    last = pd.Timestamp(df["date"].max())
    window = df[pd.to_datetime(df["date"]) > last - pd.Timedelta(days=window_days)]
    mask = np.ones(len(window), dtype=bool)
    if "promo" in window.columns:
        mask &= ~window["promo"].to_numpy(dtype=bool)
    if "stockout" in window.columns:
        mask &= ~window["stockout"].to_numpy(dtype=bool)
    clean = window[mask]
    if len(clean) == 0:
        return 0.0, 1.0
    units = clean["units"].to_numpy(dtype=float)
    units_per_day = float(units.mean())
    price = clean["price_cents"].to_numpy(dtype=float) if "price_cents" in clean.columns else np.zeros(len(clean))
    gross = float((units * price).sum())
    if gross <= 0 or "revenue_cents" not in clean.columns:
        return units_per_day, 1.0
    net = float(clean["revenue_cents"].to_numpy(dtype=float).sum())
    return units_per_day, float(min(1.0, max(0.0, net / gross)))


# ---------------------------------------------------------------------------
# objective
# ---------------------------------------------------------------------------


def _deltas(
    p1: int,
    p0: int,
    elasticity: float,
    units0: float,
    cogs: int,
    realization: float,
    cap_units: float | None,
) -> tuple[float, float, bool]:
    """(profit_delta, revenue_delta, inventory_capped) per day, float cents.

    Demand model identical to the app's forecast: units1 = units0*(P1/P0)^e.
    When an inventory cap applies, BOTH sides are capped at the servable
    daily rate so the comparison is between what the store could actually
    sell at each price, not fiction vs fiction.
    """
    units1 = units0 * (p1 / p0) ** elasticity
    capped = cap_units is not None and units1 > cap_units + 1e-12
    if capped:
        units1 = cap_units
    units0_served = min(units0, cap_units) if cap_units is not None else units0
    profit_delta = units1 * (p1 * realization - cogs) - units0_served * (p0 * realization - cogs)
    revenue_delta = units1 * p1 * realization - units0_served * p0 * realization
    return profit_delta, revenue_delta, capped


def _worst_elasticity(p1: int, p0: int, e_point: float, e_low: float, e_high: float) -> float:
    """The credible bound that hurts THIS candidate's direction.

    A price INCREASE is hurt most when customers are most price-sensitive —
    demand falls hardest — so its worst case is the most-negative bound
    (`e_low`). A price CUT is hurt most when customers barely respond — the
    merchant gives up margin without buying volume — so its worst case is
    the least-elastic bound (`e_high`, nearest zero). At P1 == P0 the deltas
    are zero under any elasticity.
    """
    if p1 > p0:
        return e_low
    if p1 < p0:
        return e_high
    return e_point


# ---------------------------------------------------------------------------
# per-SKU optimization
# ---------------------------------------------------------------------------


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    try:
        return not math.isfinite(float(value))
    except (TypeError, ValueError):
        return True


def _money(cents: float) -> str:
    """Display-only formatting; all arithmetic stays in integer cents."""
    whole = abs(int(round(cents)))
    sign = "-" if round(cents) < 0 else ""
    return f"{sign}${whole // 100:,}.{whole % 100:02d}"


_BINDING_SENTENCES = {
    "margin_floor": "The suggestion stops at your minimum-margin floor.",
    "max_change": "The suggestion stops at your maximum price-change limit.",
    "inventory": "Available inventory limits how many extra sales a lower price could serve.",
    "lattice_edge": "The suggestion reached the edge of the price range we searched.",
}


def _rationale(
    p0: int,
    rec: int,
    robust: int,
    nominal_delta: int,
    binding: tuple[str, ...],
    bounds_from_se: bool,
) -> str:
    if rec == p0:
        head = (
            f"Keeping the price at {_money(p0)} looks best right now — "
            "no nearby price beats it within your limits."
        )
    else:
        verb = "Raising" if rec > p0 else "Lowering"
        if nominal_delta >= 0:
            head = (
                f"{verb} the price from {_money(p0)} to {_money(rec)} could add about "
                f"{_money(nominal_delta)} a day in profit."
            )
        else:
            head = (
                f"{verb} the price from {_money(p0)} to {_money(rec)} is expected to cost about "
                f"{_money(-nominal_delta)} a day, but keeps the price within your limits."
            )
    parts = [head]
    parts += [_BINDING_SENTENCES[b] for b in binding if b in _BINDING_SENTENCES]
    if robust != rec:
        parts.append(f"A more cautious read of your sales history favors {_money(robust)}.")
    else:
        parts.append("A cautious read of your sales history agrees with this price.")
    if bounds_from_se:
        parts.append("The cautious check used an estimated range for how shoppers may respond.")
    return " ".join(parts)[:500]


def optimize_sku(
    fit: Any,
    price_cents: Any,
    cogs_cents: Any,
    inventory_quantity: Any,
    baseline_units_per_day: float,
    realization_rate: float,
    config: OptimizerConfig = OptimizerConfig(),
) -> SkuRecommendation | SkuSkip:
    """Optimize one SKU, or explain why it can't be optimized.

    `fit` is duck-typed (needs .sku/.elasticity/.low/.high/.se/.confidence,
    optionally .model_version) so this module doesn't pin the SkuFit class
    while the elasticity lane is mid-flight.
    """
    sku = str(fit.sku)

    if _is_missing(price_cents) or int(price_cents) < 1:
        return SkuSkip(sku, "no_price", "No live price is known for this product.")
    p0 = int(price_cents)

    # cogs <= 0 is treated as missing: Shopify reports unset cost as 0, and a
    # profit objective over free goods would just say "raise forever".
    if _is_missing(cogs_cents) or int(cogs_cents) <= 0:
        return SkuSkip(sku, "no_cogs", "No cost is recorded, so profit per sale is undefined.")
    cogs = int(cogs_cents)

    confidence = str(getattr(fit, "confidence", "assumption"))
    if confidence == "assumption":
        return SkuSkip(sku, "no_fit", "Price sensitivity for this product is an assumption, not a measurement.")

    if _is_missing(fit.elasticity):
        return SkuSkip(sku, "no_fit", "The price-sensitivity estimate for this product is unusable.")
    e_point = float(fit.elasticity)
    if e_point >= 0.0:
        # Documented decision: skip, don't clamp — a non-negative elasticity
        # estimate means the history is confounded, and clamping it to "just
        # barely elastic" would manufacture a recommendation from noise.
        return SkuSkip(
            sku,
            "positive_elasticity",
            "Sales for this product moved oddly around past price changes, so no suggestion is safe.",
        )

    e_low, e_high = getattr(fit, "low", None), getattr(fit, "high", None)
    bounds_from_se = False
    if _is_missing(e_low) or _is_missing(e_high):
        se = getattr(fit, "se", None)
        if _is_missing(se) or float(se) <= 0:
            return SkuSkip(
                sku,
                "no_uncertainty",
                "The fit carries no uncertainty range, so the cautious check is impossible.",
            )
        # CI80 fallback, matching the fits' Z80 bound convention.
        e_low, e_high = e_point - Z80 * float(se), e_point + Z80 * float(se)
        bounds_from_se = True
    e_low, e_high = float(min(e_low, e_high)), float(max(e_low, e_high))
    e_low, e_high = min(e_low, e_point), max(e_high, e_point)  # bounds must bracket the point

    if not math.isfinite(baseline_units_per_day) or baseline_units_per_day <= 0:
        return SkuSkip(sku, "zero_baseline", "No recent clean-day sales to measure demand from.")
    units0 = float(baseline_units_per_day)

    realization = realization_rate if math.isfinite(realization_rate) and 0.0 < realization_rate <= 1.0 else 1.0

    span = config.max_change_pct if config.max_change_pct is not None else DEFAULT_SPAN_PCT
    cap_label = "max_change" if config.max_change_pct is not None else "lattice_edge"
    lattice = candidate_lattice(p0, config.rounding, span)

    floor_min: int | None = None
    if config.margin_floor_pct is not None:
        floor_min = math.ceil(cogs * (1.0 + config.margin_floor_pct / 100.0))
    feasible = [c for c in lattice if floor_min is None or c >= floor_min]
    floor_removed_below = len(feasible) < len(lattice)

    # The current price is always a legal "recommendation" (staying put) as
    # long as it doesn't violate the margin floor; including it means the
    # optimizer never recommends a move its own model scores below doing
    # nothing. When P0 itself is under the floor, staying is NOT offered —
    # the floor is precisely a request to move up.
    p0_allowed = floor_min is None or p0 >= floor_min
    eval_prices = ([p0] if p0_allowed else []) + [c for c in feasible if c != p0 or not p0_allowed]
    if not eval_prices:
        return SkuSkip(
            sku,
            "infeasible_constraints",
            "No candidate price satisfies the margin floor within the allowed change range.",
        )

    cap_units: float | None = None
    if config.inventory_aware and not _is_missing(inventory_quantity) and float(inventory_quantity) >= 0:
        cap_units = float(inventory_quantity) / float(config.inventory_horizon_days)

    def score(p1: int) -> tuple[float, float, bool, float, float]:
        nom_profit, nom_rev, capped = _deltas(p1, p0, e_point, units0, cogs, realization, cap_units)
        e_worst = _worst_elasticity(p1, p0, e_point, e_low, e_high)
        worst_profit, worst_rev, _ = _deltas(p1, p0, e_worst, units0, cogs, realization, cap_units)
        return nom_profit, nom_rev, capped, worst_profit, worst_rev

    scored = {p: score(p) for p in eval_prices}
    # Strict improvement over a deterministic order (P0 first, then ascending
    # lattice): ties keep the earlier candidate, so "stay" wins a dead heat.
    best_nominal = eval_prices[0]
    best_robust = eval_prices[0]
    for p in eval_prices[1:]:
        if scored[p][0] > scored[best_nominal][0]:
            best_nominal = p
        if scored[p][3] > scored[best_robust][3]:
            best_robust = p

    nom_profit, nom_rev, capped_at_best, worst_profit, worst_rev = scored[best_nominal]

    binding: list[str] = []
    if feasible:
        if best_nominal == feasible[0]:
            # Pressed against the low end: the floor if it truncated the
            # lattice there, otherwise the change-cap (or search) edge.
            binding.append("margin_floor" if floor_removed_below else cap_label)
        if best_nominal == feasible[-1]:
            binding.append(cap_label)
    if capped_at_best:
        binding.append("inventory")
    # canonical order, deduped; ["none"] means the optimum is interior.
    order = ["margin_floor", "max_change", "inventory", "lattice_edge"]
    binding = [b for b in order if b in binding] or ["none"]

    rationale = _rationale(
        p0,
        best_nominal,
        best_robust,
        int(round(nom_profit)),
        tuple(binding),
        bounds_from_se,
    )

    return SkuRecommendation(
        sku=sku,
        current_price_cents=p0,
        recommended_price_cents=best_nominal,
        robust_price_cents=best_robust,
        rounding=config.rounding,
        elasticity=e_point,
        elasticity_low=e_low,
        elasticity_high=e_high,
        bounds_from_se=bounds_from_se,
        confidence=confidence,
        fit_model_version=getattr(fit, "model_version", None),
        baseline_units_per_day=units0,
        realization_rate=realization,
        nominal_profit_delta_cents_per_day=int(round(nom_profit)),
        robust_profit_delta_cents_per_day=int(round(worst_profit)),
        nominal_revenue_delta_cents_per_day=int(round(nom_rev)),
        robust_revenue_delta_cents_per_day=int(round(worst_rev)),
        margin_floor_pct=config.margin_floor_pct,
        max_change_pct=config.max_change_pct,
        inventory_cap_applied=capped_at_best,
        binding=tuple(binding),
        candidates_evaluated=len(eval_prices),
        rationale=rationale,
    )


# ---------------------------------------------------------------------------
# portfolio
# ---------------------------------------------------------------------------


def _product_lookup(products: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Index the products frame by its variant key.

    Real exports key products by `variant_gid` (which is also what the
    canonical daily frame calls `sku`); golden/synthetic frames may use
    `sku`. `excluded_from_pricing` is honored when present.
    """
    if len(products) == 0:
        return {}
    key = "variant_gid" if "variant_gid" in products.columns else "sku"
    out: dict[str, dict[str, Any]] = {}
    for row in products.to_dict("records"):
        out[str(row[key])] = row
    return out


def optimize_store(
    fits: list[Any],
    products: pd.DataFrame,
    orders: pd.DataFrame,
    config: OptimizerConfig = OptimizerConfig(),
) -> PortfolioResult:
    """Optimize every fitted SKU in a store.

    `fits` — elasticity fits (duck-typed, see `optimize_sku`); `products` —
    the products surface (price_cents, cogs_cents, inventory_quantity[,
    excluded_from_pricing]); `orders` — canonical daily frame for baselines.
    """
    lookup = _product_lookup(products)
    frames = dict(tuple(orders.groupby("sku"))) if len(orders) else {}
    recs: list[SkuRecommendation] = []
    skips: list[SkuSkip] = []
    for fit in fits:
        sku = str(fit.sku)
        product = lookup.get(sku)
        if product is None:
            skips.append(SkuSkip(sku, "no_product", "This variant is missing from the product catalog export."))
            continue
        if bool(product.get("excluded_from_pricing", False)):
            skips.append(SkuSkip(sku, "excluded_from_pricing", "This product is excluded from pricing."))
            continue
        baseline, realization = baseline_stats(frames.get(sku))
        out = optimize_sku(
            fit,
            product.get("price_cents"),
            product.get("cogs_cents"),
            product.get("inventory_quantity"),
            baseline,
            realization,
            config,
        )
        (recs if isinstance(out, SkuRecommendation) else skips).append(out)  # type: ignore[arg-type]
    return PortfolioResult(recommendations=recs, skips=skips)


def top_n(result: PortfolioResult | list[SkuRecommendation], n: int) -> list[SkuRecommendation]:
    """Top recommendations by nominal daily profit delta — for nightly logging."""
    recs = result.recommendations if isinstance(result, PortfolioResult) else result
    return sorted(recs, key=lambda r: r.nominal_profit_delta_cents_per_day, reverse=True)[: max(n, 0)]


# ---------------------------------------------------------------------------
# contract rows
# ---------------------------------------------------------------------------


def contract_rows(
    recommendations: list[SkuRecommendation],
    shop_domain: str,
    computed_at: str,
    variant_gids: dict[str, str] | None = None,
    model_run_id: str | None = None,
) -> list[dict]:
    """Rows shaped exactly for `contracts/price_recommendation.schema.json`.

    The schema is `additionalProperties: false`, so only contract fields are
    emitted. `computed_at` is supplied by the caller (no clock in here).
    `variant_gids` maps internal sku ids to Shopify variant gids; missing
    entries pass through unchanged (real exports already use gids as skus).
    """

    def clip(e: float) -> float:
        return float(min(_SCHEMA_E_MAX, max(_SCHEMA_E_MIN, e)))

    gids = variant_gids or {}
    rows = []
    for r in recommendations:
        row = {
            "contract_version": CONTRACT_VERSION,
            "shop_domain": shop_domain,
            "variant_gid": gids.get(r.sku, r.sku),
            "current_price_cents": r.current_price_cents,
            "recommended_price_cents": r.recommended_price_cents,
            "robust_price_cents": r.robust_price_cents,
            "rounding": r.rounding,
            "elasticity": clip(r.elasticity),
            "elasticity_low": clip(r.elasticity_low),
            "elasticity_high": clip(r.elasticity_high),
            "fit_model_version": r.fit_model_version,
            "confidence": r.confidence,
            "expected": {
                "nominal_profit_delta_cents_per_day": r.nominal_profit_delta_cents_per_day,
                "robust_profit_delta_cents_per_day": r.robust_profit_delta_cents_per_day,
                "nominal_revenue_delta_cents_per_day": r.nominal_revenue_delta_cents_per_day,
                "robust_revenue_delta_cents_per_day": r.robust_revenue_delta_cents_per_day,
            },
            "constraints": {
                "margin_floor_pct": r.margin_floor_pct,
                "max_change_pct": r.max_change_pct,
                "inventory_cap_applied": r.inventory_cap_applied,
                "binding": list(r.binding),
            },
            "candidates_evaluated": r.candidates_evaluated,
            "baseline_units_per_day": r.baseline_units_per_day,
            "rationale": r.rationale,
            "model_version": MODEL_VERSION,
            "computed_at": computed_at,
        }
        if model_run_id is not None:
            row["model_run_id"] = model_run_id
        rows.append(row)
    return rows
