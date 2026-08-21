import json

import httpx
import pandas as pd
import pytest

from priceflag_ml.data import (
    CANONICAL_COLUMNS,
    PriceflagApiSource,
    SourceIdentity,
    densify_daily,
    load_golden,
)

PROJECT_REF = "abcdefghijklmnopqrst"
SHOP = "coffee.myshopify.com"


def response(body, status=200):
    return httpx.Response(status, json=body)


def source_with(handler):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return PriceflagApiSource("https://priceflag-app.vercel.app", "test-secret", client=client)


def attestation(**overrides):
    body = {
        "schema_version": 1,
        "source": "priceflag-ml-export",
        "project_ref": PROJECT_REF,
        "environment": "production",
        "shops": [SHOP],
    }
    body.update(overrides)
    return body


def test_golden_shape_and_densification():
    frame = load_golden()
    assert list(frame.columns) == CANONICAL_COLUMNS
    tiny = pd.DataFrame(
        [
            {"shop_id": SHOP, "sku": "A", "date": pd.Timestamp("2026-01-01"), "units": 2,
             "price_cents": 1000, "revenue_cents": 2000, "promo": False, "stockout": False},
            {"shop_id": SHOP, "sku": "A", "date": pd.Timestamp("2026-01-03"), "units": 1,
             "price_cents": 1100, "revenue_cents": 1100, "promo": True, "stockout": False},
        ]
    )
    dense = densify_daily(tiny)
    assert len(dense) == 3
    middle = dense[dense["date"] == pd.Timestamp("2026-01-02")].iloc[0]
    assert middle["units"] == 0
    assert middle["price_cents"] == 1000


@pytest.mark.parametrize("origin", ["", "http://priceflag-app.vercel.app", "https://user@priceflag-app.vercel.app", "https://priceflag-app.vercel.app/path"])
def test_source_requires_a_clean_https_origin(origin):
    with pytest.raises(ValueError, match="clean HTTPS origin"):
        PriceflagApiSource(origin, "secret")


def test_source_requires_secret():
    with pytest.raises(ValueError, match="pipeline secret"):
        PriceflagApiSource("https://priceflag-app.vercel.app", "")


def test_source_from_env_is_pinned(monkeypatch):
    for name in (
        "PRICEFLAG_APP_URL",
        "APP_URL",
        "PRICEFLAG_EXPECTED_APP_URL",
        "ML_INGEST_SECRET",
        "VERCEL_TOKEN",
        "PRICEFLAG_EXPECTED_VERCEL_TARGET",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError, match="required for real reads"):
        PriceflagApiSource.from_env()

    monkeypatch.setenv("PRICEFLAG_APP_URL", "https://priceflag-app.vercel.app")
    monkeypatch.setenv("PRICEFLAG_EXPECTED_APP_URL", "https://other.vercel.app")
    monkeypatch.setenv("ML_INGEST_SECRET", "secret")
    monkeypatch.setenv("VERCEL_TOKEN", "token")
    monkeypatch.setenv("PRICEFLAG_EXPECTED_VERCEL_TARGET", "production")
    with pytest.raises(RuntimeError, match="does not match"):
        PriceflagApiSource.from_env()

    monkeypatch.setenv("PRICEFLAG_EXPECTED_APP_URL", "https://priceflag-app.vercel.app")
    assert isinstance(PriceflagApiSource.from_env(client=object()), PriceflagApiSource)


def test_attestation_pins_source_project_environment_and_shop_scope():
    requests = []

    def handler(request):
        requests.append(request)
        return response(attestation())

    source = source_with(handler)
    identity = source.attest(PROJECT_REF, "production")
    assert identity == SourceIdentity(PROJECT_REF, "production", "priceflag-ml-export")
    assert source.list_shops() == [SHOP]
    assert requests[0].headers["authorization"] == "Bearer test-secret"
    assert json.loads(requests[0].content) == {"operation": "attest"}


@pytest.mark.parametrize(
    "override,match",
    [
        ({"source": "other"}, "contract"),
        ({"project_ref": "zyxwvutsrqponmlkjihg"}, "project"),
        ({"environment": "staging"}, "environment"),
        ({"shops": ["not-a-shop"]}, "shop list"),
        ({"shops": [SHOP, SHOP]}, "duplicate shops"),
    ],
)
def test_attestation_rejects_mismatched_identity(override, match):
    source = source_with(lambda _request: response(attestation(**override)))
    with pytest.raises(RuntimeError, match=match):
        source.attest(PROJECT_REF, "production")


def test_source_reports_machine_readable_backend_error_code():
    source = source_with(
        lambda _request: response(
            {
                "error": {
                    "code": "backend_unavailable",
                    "message": "The ML export backend is temporarily unavailable.",
                    "retryable": True,
                    "details": None,
                }
            },
            status=503,
        )
    )
    with pytest.raises(RuntimeError, match=r"HTTP 503 \(backend_unavailable\)"):
        source.attest(PROJECT_REF, "production")


def test_reads_are_paginated_and_mapped_to_model_frames():
    seen = []

    def handler(request):
        payload = json.loads(request.content)
        seen.append(payload)
        if payload["operation"] == "attest":
            return response(attestation())
        surface = payload["surface"]
        cursor = payload["cursor"]
        rows = {
            "product_days": [
                {"shop_domain": SHOP, "variant_gid": "gid://shopify/ProductVariant/1", "day": "2026-01-01",
                 "units": 2, "list_price_cents": 1500, "net_revenue_cents": 3000,
                 "on_promo": False, "had_stockout": False},
                {"shop_domain": SHOP, "variant_gid": "gid://shopify/ProductVariant/1", "day": "2026-01-03",
                 "units": 1, "list_price_cents": 1600, "net_revenue_cents": 1600,
                 "on_promo": True, "had_stockout": False},
            ],
            "products": [{"shop_domain": SHOP, "variant_gid": "gid://shopify/ProductVariant/1", "price_cents": 1600, "cogs_cents": 500}],
            "price_history": [{"shop_domain": SHOP, "variant_gid": "gid://shopify/ProductVariant/1", "applied_at": "2026-01-02T00:00:00Z", "before_price_cents": 1500, "after_price_cents": 1600, "source": "manual", "rollout_id": None, "stage_index": None}],
            "rollout_windows": [{"shop_domain": SHOP, "rollout_id": "00000000-0000-4000-8000-000000000001", "status": "completed", "start_day": "2026-01-01", "end_day": "2026-01-03", "variant_gids": ["gid://shopify/ProductVariant/1"]}],
        }[surface]
        if surface == "product_days" and cursor == 0:
            page, next_cursor = rows[:1], 1
        elif surface == "product_days":
            page, next_cursor = rows[1:], None
        else:
            page, next_cursor = rows, None
        return response({"schema_version": 1, "surface": surface, "shop_domain": SHOP, "rows": page, "next_cursor": next_cursor})

    source = source_with(handler)
    source.attest(PROJECT_REF, "production")
    orders = source.order_days(SHOP)
    assert len(orders) == 3
    assert orders.iloc[1]["units"] == 0
    assert orders.iloc[1]["price_cents"] == 1500
    assert source.products(SHOP).iloc[0]["cogs_cents"] == 500
    assert source.price_history(SHOP).iloc[0]["after_price_cents"] == 1600
    assert len(source.rollout_windows(SHOP, status="completed")) == 1
    assert [call["cursor"] for call in seen if call.get("surface") == "product_days"] == [0, 1]


def test_read_rejects_unattested_shop_and_bad_cursor():
    source = source_with(lambda _request: response(attestation()))
    source.attest(PROJECT_REF, "production")
    with pytest.raises(ValueError, match="attested"):
        source.products("foreign.myshopify.com")

    def handler(request):
        payload = json.loads(request.content)
        if payload["operation"] == "attest":
            return response(attestation())
        return response({"schema_version": 1, "surface": payload["surface"], "shop_domain": SHOP, "rows": [], "next_cursor": 1})

    bad = source_with(handler)
    bad.attest(PROJECT_REF, "production")
    with pytest.raises(RuntimeError, match="pagination cursor"):
        bad.products(SHOP)


def test_receipts_are_verified_through_the_attested_shop_api():
    run_id = "00000000-0000-4000-8000-000000000001"
    sha = "a" * 40

    def handler(request):
        payload = json.loads(request.content)
        if payload["operation"] == "attest":
            return response(attestation())
        assert payload == {
            "operation": "verify_receipts",
            "shop_domain": SHOP,
            "receipts": [{"id": run_id, "git_sha": sha, "rows_written": 3}],
        }
        return response({"schema_version": 1, "shop_domain": SHOP, "verified": 1})

    source = source_with(handler)
    source.attest(PROJECT_REF, "production")
    assert source.verify_ingest_receipts([(SHOP, run_id, 3)], sha) == 1
