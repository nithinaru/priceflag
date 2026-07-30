"""Data access: golden loader shape, densification, and the Supabase source
(pagination + parsing) against a mock transport — no live network."""

import httpx
import numpy as np
import pandas as pd
import pytest

import priceflag_ml.data as data
from priceflag_ml.data import CANONICAL_COLUMNS, SupabaseSource, densify_daily, load_golden
from priceflag_ml.golden import GoldenConfig


def test_load_golden_canonical_shape():
    df = load_golden(GoldenConfig(n_skus=4, days=60, seed=2))
    assert list(df.columns) == CANONICAL_COLUMNS
    assert len(df) == 4 * 60


def test_supabase_source_requires_credentials():
    with pytest.raises(ValueError):
        SupabaseSource(url="", key="")


def test_supabase_from_env_message_without_keys(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_ML_READONLY_KEY", raising=False)
    with pytest.raises(RuntimeError, match="load_golden"):
        SupabaseSource.from_env()


def test_densify_daily_fills_missing_days():
    df = pd.DataFrame(
        {
            "shop_id": "s1",
            "sku": "A",
            "date": pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-05"]),  # 2 missing days
            "units": [3, 2, 4],
            "price_cents": [5000, 5000, 4500],
            "revenue_cents": [15000, 10000, 18000],
            "promo": [False, False, True],
            "stockout": [False, False, False],
        }
    )
    out = densify_daily(df)
    assert len(out) == 5
    assert pd.DatetimeIndex(out["date"]).is_monotonic_increasing
    filled = out[out["date"].isin(pd.to_datetime(["2026-01-03", "2026-01-04"]))]
    assert (filled["units"] == 0).all()
    assert (filled["revenue_cents"] == 0).all()
    assert (~filled["promo"]).all() and (~filled["stockout"]).all()
    assert (filled["price_cents"] == 5000).all()  # forward-filled posted price


def test_densify_daily_noop_on_contiguous():
    df = load_golden(GoldenConfig(n_skus=2, days=30, seed=3))
    out = densify_daily(df)
    assert len(out) == len(df)


def _mock_source(rows: list[dict], page_size: int) -> tuple[SupabaseSource, list[dict]]:
    """SupabaseSource over a MockTransport serving `rows` in pages, recording requests."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        seen.append(params)
        offset, limit = int(params["offset"]), int(params["limit"])
        return httpx.Response(200, json=rows[offset : offset + limit])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return SupabaseSource("https://example.supabase.co", "test-key", client=client), seen


def test_supabase_order_days_paginates_past_server_cap(monkeypatch):
    """PostgREST caps responses at max-rows; a single GET silently truncates.
    The client must page until a short page arrives."""
    monkeypatch.setattr(data, "_PAGE_SIZE", 3)
    dates = pd.date_range("2026-01-01", periods=7, freq="D")
    rows = [
        {
            "shop_id": "s1",
            "sku": "A",
            "date": str(d.date()),
            "units": i + 1,
            "revenue_cents": (i + 1) * 5000,
            "price_cents": 5000,
            "promo": False,
            "stockout": False,
        }
        for i, d in enumerate(dates)
    ]
    src, seen = _mock_source(rows, page_size=3)
    out = src.order_days("s1")
    assert len(out) == 7  # 3 + 3 + 1 across three pages
    assert len(seen) == 3
    assert [p["offset"] for p in seen] == ["0", "3", "6"]
    assert out["units"].tolist() == [1, 2, 3, 4, 5, 6, 7]


def test_supabase_order_days_fills_missing_optional_columns(monkeypatch):
    monkeypatch.setattr(data, "_PAGE_SIZE", 100)
    rows = [
        {"shop_id": "s1", "sku": "A", "date": "2026-01-01", "units": 2, "revenue_cents": 10000},
        {"shop_id": "s1", "sku": "A", "date": "2026-01-03", "units": 1, "revenue_cents": 5000},
    ]
    src, _ = _mock_source(rows, page_size=100)
    out = src.order_days("s1")
    assert list(out.columns) == CANONICAL_COLUMNS
    # missing day densified, optional columns defaulted
    assert len(out) == 3
    assert out["promo"].dtype == bool and not out["promo"].any()
    assert out["stockout"].dtype == bool and not out["stockout"].any()
    assert np.issubdtype(out["date"].dtype, np.datetime64)


def test_supabase_order_days_empty_result(monkeypatch):
    monkeypatch.setattr(data, "_PAGE_SIZE", 100)
    src, _ = _mock_source([], page_size=100)
    out = src.order_days("nope")
    assert out.empty
    assert list(out.columns) == CANONICAL_COLUMNS
