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
