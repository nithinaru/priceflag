"""Synthetic golden-data generator with known ground truth.

Produces daily order aggregates for a simulated store where the true
elasticity, seasonality, promo uplift, trend, and noise process of every SKU
are known exactly. This is the ground truth the eval harness scores models
against (PRD R28: no model ships unless it beats the incumbent here and on
backtests).

Design notes
------------
- Demand model per SKU and day::

      mu = base_units
           * dow[weekday]
           * (1 + annual_amp * sin(2*pi*(day_index + annual_phase)/365))
           * (1 + trend_daily)^day_index
           * promo_uplift^is_promo
           * (price / base_price)^elasticity

  Units are drawn from a negative binomial with mean ``mu`` and dispersion
  ``k`` (var = mu + mu^2/k), which matches the overdispersion of real daily
  retail order counts far better than Poisson.

- Promos deliberately confound price and demand: most promo windows include a
  temporary price cut *and* a non-price uplift (email/traffic). A naive
  regression of units on price will therefore overestimate |elasticity|;
  a correct estimator must control for the promo flag. This is intentional —
  it is the main trap in real store data.

- Some SKUs have 0 permanent price changes (thin history — the norm), some
  have 1-3. Elasticity estimators must degrade honestly on the former.

- Stockout gaps set units to 0 with ``stockout=True`` so downstream code can
  exclude them instead of learning from them.

- Everything is deterministic given ``GoldenConfig.seed``. No wall-clock
  dependence: the date range is anchored at ``end_date``.

This generator is a Python port-in-spirit of v0's `lib/demo-data.ts`
(not yet committed to the repo — see contracts/requests-lane-c.md); parameters
were chosen from the PRD's stated scope: 12-500 SKUs, 90-180 days of daily
aggregates, DTC volume ranges.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

DOW_BASE = np.array([0.95, 0.90, 0.95, 1.00, 1.10, 1.25, 1.15])  # Mon..Sun


@dataclass(frozen=True)
class SkuTruth:
    """Ground-truth parameters for one SKU."""

    sku: str
    base_units: float  # mean daily units at base price, no promo, dow=1
    base_price_cents: int
    cogs_cents: int
    elasticity: float  # true constant elasticity (negative)
    dow: np.ndarray  # 7 multipliers, Mon..Sun
    annual_amp: float
    annual_phase: float  # days
    trend_daily: float  # multiplicative daily drift
    promo_uplift: float  # non-price promo multiplier
    dispersion_k: float  # NB dispersion (larger = closer to Poisson)
    n_permanent_levels: int  # permanent price levels, promo cuts NOT counted
    price_cents: np.ndarray = field(repr=False)  # per-day price path
    promo: np.ndarray = field(repr=False)  # per-day bool
    stockout: np.ndarray = field(repr=False)  # per-day bool

    @property
    def n_price_levels(self) -> int:
        """Unique observed prices — includes promo cuts (confounded variation)."""
        return int(len(np.unique(self.price_cents)))

    @property
    def price_variation_pct(self) -> float:
        p = self.price_cents.astype(float)
        return float((p.max() - p.min()) / p.mean() * 100.0)


@dataclass(frozen=True)
class GoldenConfig:
    n_skus: int = 24
    days: int = 180
    seed: int = 7
    end_date: str = "2026-07-01"  # fixed anchor: generator is fully deterministic
    shop_id: str = "golden-store"


@dataclass(frozen=True)
class GoldenStore:
    config: GoldenConfig
    orders: pd.DataFrame  # daily aggregates, order_days-shaped
    truth: pd.DataFrame  # one row per SKU with ground-truth params
    skus: dict[str, SkuTruth]


# Volume archetypes cycled across SKUs: (base daily units, label).
# Mix matters: thin/low-volume SKUs are where interval floors and shrinkage
# earn their keep.
_VOLUME_TIERS = [25.0, 8.0, 2.0, 0.5]


def _make_sku(i: int, cfg: GoldenConfig, rng: np.random.Generator) -> SkuTruth:
    days = cfg.days
    base_units = _VOLUME_TIERS[i % len(_VOLUME_TIERS)] * float(rng.uniform(0.7, 1.4))
    base_price = int(np.round(rng.uniform(1500, 9500) / 50) * 50)  # cents
    cogs = int(base_price * rng.uniform(0.25, 0.6))
    elasticity = float(np.clip(rng.normal(-1.3, 0.6), -3.0, -0.3))
    dow = DOW_BASE * rng.uniform(0.95, 1.05, size=7)
    annual_amp = float(rng.uniform(0.0, 0.25))
    annual_phase = float(rng.uniform(0, 365))
    trend_daily = float(rng.uniform(-0.0015, 0.002))
    promo_uplift = float(rng.uniform(1.4, 2.4))
    dispersion_k = float(rng.uniform(4.0, 12.0))

    # Permanent price levels. Weighted so that "no historical price change"
    # (the thin-history norm) is the most common case.
    n_changes = int(rng.choice([0, 0, 1, 1, 2, 3]))
    change_window = np.arange(30, days - 21)  # changes need >=30d before and >=21d after
    n_changes = min(n_changes, len(change_window))
    price = np.full(days, base_price, dtype=float)
    change_days = np.sort(rng.choice(change_window, size=n_changes, replace=False)) if n_changes else []
    for cd in change_days:
        pct = float(rng.uniform(0.05, 0.20)) * float(rng.choice([-1.0, 1.0]))
        price[cd:] = np.round(price[cd] * (1 + pct) / 50) * 50

    # Promo windows: 3-7 days, non-price uplift, usually with a temporary
    # price cut (the price/demand confound).
    promo = np.zeros(days, dtype=bool)
    n_promos = int(rng.poisson(1.5))
    for _ in range(n_promos):
        start = int(rng.integers(0, max(1, days - 8)))
        length = int(rng.integers(3, 8))
        promo[start : start + length] = True
        if rng.random() < 0.7:
            disc = float(rng.uniform(0.10, 0.25))
            price[start : start + length] = np.round(price[start : start + length] * (1 - disc) / 50) * 50

    # Stockout gaps: 2-5 days of zero units that are NOT demand signal.
    stockout = np.zeros(days, dtype=bool)
    if rng.random() < 0.3:
        for _ in range(int(rng.integers(1, 3))):
            start = int(rng.integers(0, max(1, days - 6)))
            stockout[start : start + int(rng.integers(2, 6))] = True

    return SkuTruth(
        sku=f"SKU-{i + 1:03d}",
        base_units=base_units,
        base_price_cents=base_price,
        cogs_cents=cogs,
        elasticity=elasticity,
        dow=dow,
        annual_amp=annual_amp,
        annual_phase=annual_phase,
        trend_daily=trend_daily,
        promo_uplift=promo_uplift,
        dispersion_k=dispersion_k,
        n_permanent_levels=n_changes + 1,
        price_cents=np.maximum(price, 100).astype(int),
        promo=promo,
        stockout=stockout,
    )


def expected_units(truth: SkuTruth, day_index: np.ndarray, weekday: np.ndarray) -> np.ndarray:
    """True mean daily units (the latent mu) for the given day indices."""
    price_ratio = truth.price_cents[day_index] / truth.base_price_cents
    mu = (
        truth.base_units
        * truth.dow[weekday]
        * (1 + truth.annual_amp * np.sin(2 * np.pi * (day_index + truth.annual_phase) / 365))
        * (1 + truth.trend_daily) ** day_index
        * np.where(truth.promo[day_index], truth.promo_uplift, 1.0)
        * price_ratio**truth.elasticity
    )
    return np.where(truth.stockout[day_index], 0.0, np.maximum(mu, 0.0))


def simulate_sku(truth: SkuTruth, dates: pd.DatetimeIndex, rng: np.random.Generator) -> pd.DataFrame:
    """Draw one realized daily series for a SKU (negative-binomial noise)."""
    day_index = np.arange(len(dates))
    weekday = dates.weekday.to_numpy()
    mu = expected_units(truth, day_index, weekday)
    k = truth.dispersion_k
    p = k / (k + np.maximum(mu, 1e-9))
    units = np.where(mu > 0, rng.negative_binomial(k, np.clip(p, 1e-9, 1.0)), 0)
    price = truth.price_cents[day_index]
    return pd.DataFrame(
        {
            "sku": truth.sku,
            "date": dates,
            "units": units.astype(int),
            "price_cents": price,
            "revenue_cents": (units * price).astype(int),
            "promo": truth.promo[day_index],
            "stockout": truth.stockout[day_index],
        }
    )


def generate_store(cfg: GoldenConfig | None = None) -> GoldenStore:
    """Generate a full golden store: daily aggregates + ground truth."""
    cfg = cfg or GoldenConfig()
    end = pd.Timestamp(cfg.end_date)
    dates = pd.date_range(end=end, periods=cfg.days, freq="D")

    # Each SKU gets its own RNG streams (seeded by (store seed, sku index)),
    # so adding/removing a SKU or changing one SKU's draw count never
    # regenerates the rest of the universe.
    skus = {
        t.sku: t
        for t in (_make_sku(i, cfg, np.random.default_rng([cfg.seed, i, 0])) for i in range(cfg.n_skus))
    }
    frames = [
        simulate_sku(t, dates, np.random.default_rng([cfg.seed, i, 1])) for i, t in enumerate(skus.values())
    ]
    orders = pd.concat(frames, ignore_index=True)
    orders.insert(0, "shop_id", cfg.shop_id)

    truth = pd.DataFrame(
        [
            {
                "sku": t.sku,
                "elasticity": t.elasticity,
                "base_units": t.base_units,
                "base_price_cents": t.base_price_cents,
                "cogs_cents": t.cogs_cents,
                "promo_uplift": t.promo_uplift,
                "trend_daily": t.trend_daily,
                "annual_amp": t.annual_amp,
                "dispersion_k": t.dispersion_k,
                "n_price_levels": t.n_price_levels,
                "n_permanent_levels": t.n_permanent_levels,
                "price_variation_pct": t.price_variation_pct,
            }
            for t in skus.values()
        ]
    )
    return GoldenStore(config=cfg, orders=orders, truth=truth, skus=skus)
