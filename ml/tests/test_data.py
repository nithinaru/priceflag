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


def _view_row(day, units, gid="gid://shopify/ProductVariant/1", **extra):
    row = {
        "shop_domain": "s1.myshopify.com",
        "variant_gid": gid,
        "day": day,
        "units": units,
        "net_revenue_cents": units * 5000,
        "list_price_cents": 5000,
        "on_promo": False,
        "had_stockout": False,
    }
    row.update(extra)
    return row


def test_supabase_order_days_paginates_past_server_cap(monkeypatch):
    """PostgREST caps responses at max-rows; a single GET silently truncates.
    The client must page until a short page arrives."""
    monkeypatch.setattr(data, "_PAGE_SIZE", 3)
    dates = pd.date_range("2026-01-01", periods=7, freq="D")
    rows = [_view_row(str(d.date()), i + 1) for i, d in enumerate(dates)]
    src, seen = _mock_source(rows, page_size=3)
    out = src.order_days("s1.myshopify.com")
    assert len(out) == 7  # 3 + 3 + 1 across three pages
    assert len(seen) == 3
    assert [p["offset"] for p in seen] == ["0", "3", "6"]
    assert out["units"].tolist() == [1, 2, 3, 4, 5, 6, 7]
    assert (out["sku"] == "gid://shopify/ProductVariant/1").all()
    assert (out["price_cents"] == 5000).all()


def test_supabase_order_days_maps_view_columns_and_densifies(monkeypatch):
    monkeypatch.setattr(data, "_PAGE_SIZE", 100)
    rows = [
        _view_row("2026-01-01", 2, on_promo=True),
        _view_row("2026-01-03", 1, had_stockout=True),
    ]
    src, _ = _mock_source(rows, page_size=100)
    out = src.order_days("s1.myshopify.com")
    assert list(out.columns) == CANONICAL_COLUMNS
    assert len(out) == 3  # missing day densified
    assert out["promo"].tolist() == [True, False, False]
    assert out["stockout"].tolist() == [False, False, True]
    assert np.issubdtype(out["date"].dtype, np.datetime64)
    assert out["revenue_cents"].tolist() == [10000, 0, 5000]


def test_supabase_order_days_empty_result(monkeypatch):
    monkeypatch.setattr(data, "_PAGE_SIZE", 100)
    src, _ = _mock_source([], page_size=100)
    out = src.order_days("nope")
    assert out.empty
    assert list(out.columns) == CANONICAL_COLUMNS


def test_list_shops_dedupes_and_pages(monkeypatch):
    """The nightly's enumeration half of request 9. `ml_products` is
    variant-grained, so every shop appears once per variant — the caller needs
    each shop once, and must not stop at the first page."""
    monkeypatch.setattr(data, "_PAGE_SIZE", 2)
    rows = [
        {"shop_domain": "a.myshopify.com"},
        {"shop_domain": "a.myshopify.com"},
        {"shop_domain": "a.myshopify.com"},
        {"shop_domain": "b.myshopify.com"},
        {"shop_domain": "b.myshopify.com"},
    ]
    src, seen = _mock_source(rows, page_size=2)
    assert src.list_shops() == ["a.myshopify.com", "b.myshopify.com"]
    assert [p["offset"] for p in seen] == ["0", "2", "4"]


def test_list_shops_empty_when_rls_hides_everything(monkeypatch):
    """A role with no visible rows must return no shops, not raise — that is
    the state before B6's SELECT policies exist."""
    monkeypatch.setattr(data, "_PAGE_SIZE", 100)
    src, _ = _mock_source([], page_size=100)
    assert src.list_shops() == []
