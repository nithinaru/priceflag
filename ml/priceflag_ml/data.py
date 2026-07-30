"""Read-only data access for Lane C.

Two sources behind one shape:

- ``load_golden`` — the synthetic golden store (always available; what tests
  and the harness run against until Lane B provides real DB access).
- ``SupabaseSource`` — read-only pull from Supabase PostgREST using
  ``SUPABASE_URL`` + ``SUPABASE_ML_READONLY_KEY``. Column names follow the
  draft understanding of Lane B's `order_days` contract; they will be
  reconciled when `contracts/db/` lands (tracked in
  contracts/requests-lane-c.md). Nothing in this module ever writes.

Canonical tidy frame (one row per shop x SKU x *consecutive calendar day* —
the harness enforces contiguity)::

    shop_id, sku, date, units, price_cents, revenue_cents, promo, stockout
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd

from .golden import GoldenConfig, generate_store

CANONICAL_COLUMNS = ["shop_id", "sku", "date", "units", "price_cents", "revenue_cents", "promo", "stockout"]

_PAGE_SIZE = 1000  # stay at PostgREST's default max-rows so paging is explicit


def load_golden(cfg: GoldenConfig | None = None) -> pd.DataFrame:
    """Golden-store daily aggregates in the canonical shape."""
    return generate_store(cfg).orders[CANONICAL_COLUMNS].copy()


def densify_daily(orders: pd.DataFrame) -> pd.DataFrame:
    """Fill missing calendar days per (shop_id, sku) with zero-order rows.

    A real `order_days` table has no row on days with no orders; the harness
    and forecasters require one row per consecutive day. Filled rows get
    units=0, revenue=0, promo=False, stockout=False, and the price
    forward-filled (a day with no orders still had a posted price).
    """
    if orders.empty:
        return orders.copy()
    out = []
    for (shop, sku), g in orders.groupby(["shop_id", "sku"]):
        g = g.sort_values("date").set_index("date")
        full = pd.date_range(g.index.min(), g.index.max(), freq="D")
        g = g.reindex(full)
        g.index.name = "date"
        g["shop_id"] = shop
        g["sku"] = sku
        g["price_cents"] = g["price_cents"].ffill().bfill()
        g["units"] = g["units"].fillna(0)
        g["revenue_cents"] = g["revenue_cents"].fillna(0)
        g["promo"] = g["promo"].fillna(False)
        g["stockout"] = g["stockout"].fillna(False)
        out.append(g.reset_index())
    df = pd.concat(out, ignore_index=True)
    df["units"] = df["units"].astype(int)
    df["revenue_cents"] = df["revenue_cents"].astype(np.int64)
    df["price_cents"] = df["price_cents"].astype(np.int64)
    df["promo"] = df["promo"].astype(bool)
    df["stockout"] = df["stockout"].astype(bool)
    return df[CANONICAL_COLUMNS]


class SupabaseSource:
    """Read-only PostgREST client for the `order_days` table.

    Assumed columns (pending Lane B's committed contract):
    ``shop_id, sku, date, units, revenue_cents, price_cents, promo, stockout``.
    Missing optional columns (`promo`, `stockout`, `price_cents`) are filled
    with safe defaults so the harness can still run. Results are paginated
    (PostgREST caps responses at its max-rows setting; a naive single GET
    silently truncates) and densified to one row per calendar day.
    """

    def __init__(self, url: str, key: str, client=None) -> None:
        if not url or not key:
            raise ValueError("SupabaseSource needs both url and key")
        self._base = url.rstrip("/") + "/rest/v1"
        self._headers = {"apikey": key, "Authorization": f"Bearer {key}"}
        self._client = client  # injectable for tests; lazily created otherwise

    @classmethod
    def from_env(cls) -> "SupabaseSource":
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_ML_READONLY_KEY", "")
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_ML_READONLY_KEY are not set. "
                "Lane B provides these (BUILD_BRIEF B6). Until then, use load_golden()."
            )
        return cls(url, key)

    def _get_client(self):
        if self._client is None:
            import httpx  # lazy: keep golden-only workflows free of network deps

            self._client = httpx.Client(timeout=60.0)
        return self._client

    def order_days(self, shop_id: str) -> pd.DataFrame:
        client = self._get_client()
        pages: list[pd.DataFrame] = []
        offset = 0
        while True:
            resp = client.get(
                f"{self._base}/order_days",
                params={
                    "shop_id": f"eq.{shop_id}",
                    "order": "sku,date",
                    "limit": str(_PAGE_SIZE),
                    "offset": str(offset),
                },
                headers=self._headers,
            )
            resp.raise_for_status()
            batch = resp.json()
            if batch:
                pages.append(pd.DataFrame(batch))
            if len(batch) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE

        if not pages:
            return pd.DataFrame(columns=CANONICAL_COLUMNS)
        df = pd.concat(pages, ignore_index=True)
        df["date"] = pd.to_datetime(df["date"])
        for col, default in (("promo", False), ("stockout", False), ("price_cents", 0)):
            if col not in df.columns:
                df[col] = default
        return densify_daily(df[CANONICAL_COLUMNS])
