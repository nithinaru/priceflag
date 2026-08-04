import json

import httpx
import pytest

from priceflag_ml.ingest import IngestClient


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
