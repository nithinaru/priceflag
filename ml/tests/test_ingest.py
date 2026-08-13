import json

import httpx
import pytest

from priceflag_ml.ingest import IngestClient


# Satisfies every `required` field of contracts/price_recommendation.schema.json.
RECOMMENDATION_ROW = {
    "contract_version": "1.0.0",
    "shop_domain": "shop.myshopify.com",
    "variant_gid": "gid://shopify/ProductVariant/1234567890",
    "current_price_cents": 2500,
    "recommended_price_cents": 2699,
    "robust_price_cents": 2599,
    "rounding": "end_99",
    "elasticity": -1.4,
    "confidence": "fitted",
    "expected": {
        "nominal_profit_delta_cents_per_day": 320,
        "robust_profit_delta_cents_per_day": -40,
        "nominal_revenue_delta_cents_per_day": 510,
        "robust_revenue_delta_cents_per_day": 120,
    },
    "constraints": {"binding": ["none"]},
    "candidates_evaluated": 48,
    "rationale": "A small increase to $26.99 should add profit; demand looks steady near this price.",
    "model_version": "optimizer-1.0",
    "computed_at": "2026-08-11T00:00:00Z",
}


def _client(response_body):
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json=response_body)

    transport = httpx.Client(transport=httpx.MockTransport(handler))
    return IngestClient("https://app.example", "secret", client=transport), seen


def test_acceptance_requires_exact_per_surface_and_total_counts():
    client, _ = _client(
        {
            "accepted": True,
            "model_run_id": "run",
            "fits_written": 1,
            "bands_written": 0,
            "reports_written": 0,
            "rows_written": 1,
        }
    )
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="elasticity",
        model_version="fit-1.0",
        gate_passed=True,
        fits=[{"variant_gid": "fit"}],
    )
    assert result.accepted and not result.is_error


@pytest.mark.parametrize(
    "response",
    [
        {"accepted": True, "fits_written": 1, "bands_written": 0, "rows_written": 1},
        {"accepted": True, "reports_written": 1, "rows_written": 0},
        {"accepted": True, "reports_written": 0, "rows_written": 0},
    ],
)
def test_missing_or_inconsistent_acknowledgements_turn_the_nightly_red(response):
    client, _ = _client(response)
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="report",
        model_version="rollout-report-1.0",
        gate_passed=True,
        reports=[{"rollout_id": "report"}],
    )
    assert result.is_error and result.dropped


def test_losing_run_is_recorded_without_model_rows():
    client, seen = _client({"accepted": False, "reason": "gate_not_passed", "rows_written": 0})
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="baseline",
        model_version="challenger",
        gate_passed=False,
        bands=[{"variant_gid": "x", "day": "2026-08-01", "band_kind": "baseline"}],
    )
    assert seen[0]["bands"] == [] and seen[0]["reports"] == []
    assert not result.is_error


def test_recommendation_kind_rides_its_own_payload_key():
    client, seen = _client(
        {
            "accepted": True,
            "model_run_id": "run",
            "fits_written": 0,
            "bands_written": 0,
            "reports_written": 0,
            "recommendations_written": 1,
            "rows_written": 1,
        }
    )
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="recommendation",
        model_version="optimizer-1.0",
        gate_passed=True,
        recommendations=[RECOMMENDATION_ROW],
    )
    assert result.accepted and not result.is_error
    assert seen[0]["recommendations"] == [RECOMMENDATION_ROW]
    assert seen[0]["fits"] == [] and seen[0]["bands"] == [] and seen[0]["reports"] == []
    assert seen[0]["model_run"]["kind"] == "recommendation"


def test_recommendation_rows_cannot_cross_model_surfaces():
    client, seen = _client({"accepted": True})
    with pytest.raises(ValueError, match="different model surface"):
        client.post_run(
            shop_domain="shop.myshopify.com",
            kind="elasticity",
            model_version="fit-1.0",
            gate_passed=True,
            fits=[{"variant_gid": "fit"}],
            recommendations=[RECOMMENDATION_ROW],
        )
    with pytest.raises(ValueError, match="different model surface"):
        client.post_run(
            shop_domain="shop.myshopify.com",
            kind="recommendation",
            model_version="optimizer-1.0",
            gate_passed=True,
            fits=[{"variant_gid": "fit"}],
            recommendations=[RECOMMENDATION_ROW],
        )
    assert seen == []


def test_losing_recommendation_run_sends_no_rows():
    client, seen = _client({"accepted": False, "reason": "gate_not_passed", "rows_written": 0})
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="recommendation",
        model_version="optimizer-challenger",
        gate_passed=False,
        recommendations=[RECOMMENDATION_ROW],
    )
    assert seen[0]["recommendations"] == []
    assert not result.is_error


def test_unacknowledged_recommendations_turn_the_nightly_red():
    # An endpoint that accepts but does not account for the recommendation rows
    # (e.g. one deployed before the recommendations surface) must read as a drop.
    client, _ = _client(
        {
            "accepted": True,
            "model_run_id": "run",
            "fits_written": 0,
            "bands_written": 0,
            "reports_written": 0,
            "rows_written": 0,
        }
    )
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="recommendation",
        model_version="optimizer-1.0",
        gate_passed=True,
        recommendations=[RECOMMENDATION_ROW],
    )
    assert result.is_error and result.dropped


def test_duplicate_bands_never_reach_the_endpoint():
    client, seen = _client({"accepted": True})
    band = {"variant_gid": "x", "day": "2026-08-01", "band_kind": "baseline"}
    with pytest.raises(ValueError, match="duplicate band"):
        client.post_run(
            shop_domain="shop.myshopify.com",
            kind="baseline",
            model_version="baseline",
            gate_passed=True,
            bands=[band, band],
        )
    assert seen == []


def test_ingest_target_requires_a_clean_https_origin():
    with pytest.raises(ValueError, match="clean HTTPS origin"):
        IngestClient("http://app.example", "secret")
    with pytest.raises(ValueError, match="clean HTTPS origin"):
        IngestClient("https://app.example/path", "secret")


def test_from_env_requires_the_protected_exact_target(monkeypatch):
    monkeypatch.setenv("PRICEFLAG_APP_URL", "https://attacker.vercel.app")
    monkeypatch.setenv("PRICEFLAG_EXPECTED_APP_URL", "https://priceflag-app.vercel.app")
    monkeypatch.setenv("ML_INGEST_SECRET", "secret")
    monkeypatch.setenv("VERCEL_TOKEN", "vercel-token")
    monkeypatch.setenv("PRICEFLAG_EXPECTED_VERCEL_TARGET", "production")
    with pytest.raises(RuntimeError, match="does not match"):
        IngestClient.from_env()


def test_vercel_attestation_precedes_secret_bearing_ingest():
    app_requests = []
    attestation_requests = []

    def app_handler(request):
        app_requests.append(request)
        return httpx.Response(
            200,
            json={
                "accepted": True,
                "model_run_id": "00000000-0000-4000-8000-000000000001",
                "fits_written": 1,
                "bands_written": 0,
                "reports_written": 0,
                "rows_written": 1,
            },
        )

    def attestation_handler(request):
        attestation_requests.append(request)
        return httpx.Response(
            200,
            json={
                "projectId": "prj_RU8NlBDoR7t89BNqn5BagOpmpnmm",
                "url": "generated-priceflag.vercel.app",
                "alias": ["priceflag-app.vercel.app"],
                "readyState": "READY",
                "target": "production",
            },
        )

    client = IngestClient(
        "https://priceflag-app.vercel.app",
        "secret",
        client=httpx.Client(transport=httpx.MockTransport(app_handler)),
        vercel_token="vercel-token",
        expected_target="production",
        attestation_client=httpx.Client(transport=httpx.MockTransport(attestation_handler)),
    )
    result = client.post_run(
        shop_domain="shop.myshopify.com",
        kind="elasticity",
        model_version="fit-1.0",
        gate_passed=True,
        fits=[{"variant_gid": "fit"}],
    )
    assert result.accepted
    assert len(attestation_requests) == 1 and len(app_requests) == 1
    assert "vercel-token" in attestation_requests[0].headers["authorization"]
    assert "secret" not in attestation_requests[0].headers.get("authorization", "")
    assert "secret" in app_requests[0].headers["authorization"]


def test_failed_vercel_attestation_never_sends_the_ingest_secret():
    app_requests = []
    app = httpx.Client(
        transport=httpx.MockTransport(lambda request: app_requests.append(request) or httpx.Response(500))
    )
    attestation = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "projectId": "prj_attacker",
                    "url": "priceflag-app.vercel.app",
                    "readyState": "READY",
                    "target": "production",
                },
            )
        )
    )
    client = IngestClient(
        "https://priceflag-app.vercel.app",
        "secret",
        client=app,
        vercel_token="vercel-token",
        expected_target="production",
        attestation_client=attestation,
    )
    with pytest.raises(RuntimeError, match="outside the pinned"):
        client.post_run(
            shop_domain="shop.myshopify.com",
            kind="elasticity",
            model_version="fit-1.0",
            gate_passed=True,
            fits=[{"variant_gid": "fit"}],
        )
    assert app_requests == []


def test_result_description_never_logs_run_ids_or_endpoint_messages():
    client, _ = _client(
        {
            "accepted": True,
            "model_run_id": "00000000-0000-4000-8000-000000000001",
            "fits_written": 1,
            "bands_written": 0,
            "reports_written": 0,
            "rows_written": 1,
            "message": "private-shop.myshopify.com",
        }
    )
    result = client.post_run(
        shop_domain="private-shop.myshopify.com",
        kind="elasticity",
        model_version="fit-1.0",
        gate_passed=True,
        fits=[{"variant_gid": "fit"}],
    )
    description = result.describe()
    assert "00000000" not in description
    assert "private-shop" not in description
