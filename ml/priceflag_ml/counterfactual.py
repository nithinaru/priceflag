"""C5: rollout counterfactual monitor.

During a rollout, the question is not "are sales below a line?" but "what
would these SKUs have sold WITHOUT the price change, and how sure are we
that the change is hurting more than the merchant agreed to tolerate?"

Approach (CausalImpact-flavored, sized for this data):

1. Fit the C3 champion (`CleanLevelBaseline`) per treated SKU on PRE-change
   days only — including post-change days would let the counterfactual drift
   toward the very effect it must detect.
2. Project per-SKU counterfactual bands over the monitoring window and
   aggregate to the rollout cohort (means add; independent variances add —
   the cohort band is proportionally tighter than any single SKU's, which is
   what makes 2-day detection possible at all on DTC volumes).
3. Cumulative effect: observed vs counterfactual cumulative units, with the
   ratio's uncertainty via the delta method on the log scale.
4. **Breach probability** instead of raw threshold crossing:
   P(true demand ratio < 1 - guardrail_drop | data). The evaluator fires at
   >= 0.8 (Lane B has this wired already) — a probability accumulates
   evidence smoothly instead of whipsawing on single noisy days (R29).

Emitted rows are `expected_band.schema.json` with band_kind=counterfactual,
`rollout_id`, and `breach_probability`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .baselines import Z80
from .forecaster import CleanLevelBaseline

MODEL_VERSION = "counterfactual-cleanlevel-1.0"

MAX_MONITOR_DAYS = 90  # beyond this the pre-change counterfactual is stale


@dataclass(frozen=True)
class DailyAssessment:
    date: pd.Timestamp
    expected: float  # cohort counterfactual for the day
    low: float
    high: float
    actual: float
    cum_expected: float
    cum_actual: float
    effect_ratio: float  # cum_actual / cum_expected
    ratio_low: float  # 80% CI on the true demand ratio
    ratio_high: float
    breach_probability: float


class CounterfactualMonitor:
    """Cohort-level counterfactual monitoring for one rollout."""

    model_version = MODEL_VERSION

    def __init__(self, guardrail_drop_pct: float) -> None:
        if not 0.0 < guardrail_drop_pct < 1.0:
            raise ValueError("guardrail_drop_pct must be a fraction in (0, 1), e.g. 0.30")
        self._drop = guardrail_drop_pct
        self._models: dict[str, CleanLevelBaseline] = {}
        self._pre_end: pd.Timestamp | None = None

    def fit(self, pre_history: pd.DataFrame) -> "CounterfactualMonitor":
        """`pre_history`: canonical daily frame for the treated SKUs, strictly
        BEFORE the price change went live."""
        if len(pre_history) == 0:
            raise ValueError("CounterfactualMonitor.fit: empty pre-change history")
        self._pre_end = pd.Timestamp(pre_history["date"].max())
        for sku, g in pre_history.groupby("sku"):
            self._models[str(sku)] = CleanLevelBaseline().fit(g.sort_values("date"))
        return self

    def _cohort_band(self, horizon: int) -> pd.DataFrame:
        per_sku = []
        for sku, model in self._models.items():
            fc = model.forecast(horizon)
            sd = (fc["high"].to_numpy() - fc["low"].to_numpy()) / (2 * Z80)
            per_sku.append((fc["date"], fc["expected"].to_numpy(), sd))
        dates = per_sku[0][0]
        expected = np.sum([p[1] for p in per_sku], axis=0)
        sd = np.sqrt(np.sum([p[2] ** 2 for p in per_sku], axis=0))
        return pd.DataFrame(
            {
                "date": dates,
                "expected": expected,
                "low": np.maximum(0.0, expected - Z80 * sd),
                "high": expected + Z80 * sd,
                "sd": sd,
            }
        )

    def assess(self, actuals: pd.DataFrame) -> list[DailyAssessment]:
        """`actuals`: canonical daily frame for the treated SKUs DURING the
        rollout (days after fit's pre-change history). Returns one assessment
        per monitored day, in order — `breach_probability` on day k uses all
        evidence through day k."""
        if not self._models:
            raise RuntimeError("fit() before assess()")
        daily = (
            actuals[~actuals["stockout"]]
            .groupby("date", as_index=False)["units"]
            .sum()
            .sort_values("date")
            .reset_index(drop=True)
            if "stockout" in actuals.columns
            else actuals.groupby("date", as_index=False)["units"].sum().sort_values("date").reset_index(drop=True)
        )
        if len(daily) == 0:
            return []
        horizon = int((pd.Timestamp(daily["date"].max()) - self._pre_end).days)
        if horizon <= 0:
            raise ValueError("actuals must be dated after the pre-change history")
        if horizon > MAX_MONITOR_DAYS:
            raise ValueError(
                f"monitoring window of {horizon} days exceeds {MAX_MONITOR_DAYS} — a counterfactual "
                "projected that far from pre-change data is stale; refit on fresher data."
            )
        band = self._cohort_band(horizon).set_index("date")

        out: list[DailyAssessment] = []
        cum_a = cum_e = cum_var = 0.0
        for rec in daily.itertuples():
            day = pd.Timestamp(rec.date)
            if day not in band.index:
                raise ValueError(f"actuals contain day {day.date()} outside the projected window")
            b = band.loc[day]
            cum_a += float(rec.units)
            cum_e += float(b["expected"])
            cum_var += float(b["sd"]) ** 2
            if cum_e <= 0:
                ratio, se_log = 1.0, 1.0
            else:
                ratio = max(cum_a / cum_e, 1e-6)
                se_log = max(np.sqrt(cum_var) / cum_e, 1e-6) / max(ratio, 0.05)
            z = (np.log(1.0 - self._drop) - np.log(ratio)) / se_log
            from math import erf

            breach_p = 0.5 * (1.0 + erf(z / np.sqrt(2.0)))
            out.append(
                DailyAssessment(
                    date=day,
                    expected=float(b["expected"]),
                    low=float(b["low"]),
                    high=float(b["high"]),
                    actual=float(rec.units),
                    cum_expected=cum_e,
                    cum_actual=cum_a,
                    effect_ratio=ratio,
                    ratio_low=float(np.exp(np.log(ratio) - Z80 * se_log)),
                    ratio_high=float(np.exp(np.log(ratio) + Z80 * se_log)),
                    breach_probability=float(breach_p),
                )
            )
        return out

    def contract_rows(
        self,
        assessments: list[DailyAssessment],
        shop_domain: str,
        variant_gid: str,
        rollout_id: str,
        generated_at: str,
    ) -> list[dict]:
        """`expected_band` rows, band_kind=counterfactual. NOTE: cohort-level
        numbers stamped per variant row is Lane B's current expectation for
        rollout-scope guardrails; per-variant splitting is a C6+ refinement."""
        rows = []
        for a in assessments:
            rows.append(
                {
                    "contract_version": "1.0.0",
                    "shop_domain": shop_domain,
                    "variant_gid": variant_gid,
                    "day": str(a.date.date()),
                    "expected_units": a.expected,
                    "low": a.low,
                    "high": a.high,
                    "interval": 0.8,
                    "band_kind": "counterfactual",
                    "rollout_id": rollout_id,
                    "breach_probability": a.breach_probability,
                    "is_floored": False,
                    "model_version": self.model_version,
                    "generated_at": generated_at,
                }
            )
        return rows
