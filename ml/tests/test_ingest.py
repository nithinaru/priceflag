"""The write path (C9). Every test runs against a MockTransport — this suite
never touches a real endpoint, and must never be made to.

What is being defended here is not "the POST works". It is that a model which
did not earn the right to write cannot write, that a partial band set can never
reach the table, and that the secret does not leak into a log line."""

import httpx
import pytest

from priceflag_ml.ingest import MAX_ROWS_PER_REQUEST, IngestClient, IngestResult, git_sha


def _client(responder) -> tuple[IngestClient, list[httpx.Request]]:
    """IngestClient over a MockTransport, recording every request sent."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return responder(request)

    transport = httpx.Client(transport=httpx.MockTransport(handler))
    return IngestClient("https://app.example.com", "s3cret", client=transport), seen


def _accepted(rows: int = 3):
    return lambda _r: httpx.Response(
        200, json={"accepted": True, "model_run_id": "run_1", "rows_written": rows,
                   "fits_written": rows, "bands_written": 0}
    )


def _band(day: str) -> dict:
    return {
        "contract_version": "1.0.0", "shop_domain": "s1.myshopify.com",
        "variant_gid": "gid://shopify/ProductVariant/1", "day": day,
        "expected_units": 10.0, "low": 6.0, "high": 15.0, "interval": 0.8,
        "band_kind": "baseline", "rollout_id": None, "is_floored": False,
        "model_version": "baseline-cleanlevel-1.0", "generated_at": "2026-07-30T00:00:00Z",
    }


def test_requires_url_and_secret():
    with pytest.raises(ValueError):
        IngestClient("", "secret")
    with pytest.raises(ValueError):
        IngestClient("https://app.example.com", "")


def test_from_env_or_none_is_silent_when_unconfigured(monkeypatch):
    """Golden-mode runs have nowhere to post; that is a normal state."""
    for var in ("PRICEFLAG_APP_URL", "APP_URL", "ML_INGEST_SECRET"):
        monkeypatch.delenv(var, raising=False)
    assert IngestClient.from_env_or_none() is None
    with pytest.raises(RuntimeError, match="ML_INGEST_SECRET"):
        IngestClient.from_env()


def test_posts_to_the_ingest_route_with_bearer_secret():
    client, seen = _client(_accepted())
    result = client.post_run(
        shop_domain="s1.myshopify.com", kind="elasticity",
        model_version="elasticity-poisson-eb-1.0", gate_passed=True,
        incumbent_version="bracket-1.2", metrics={"mae": 0.486},
        fits=[{"variant_gid": "x"}], sha="abc123",
    )
    assert result.accepted and result.rows_written == 3
    request = seen[0]
    assert str(request.url) == "https://app.example.com/api/ml/ingest"
    assert request.headers["authorization"] == "Bearer s3cret"
    import json
    body = json.loads(request.content)
    assert body["shop_domain"] == "s1.myshopify.com"
    assert body["model_run"]["gate_passed"] is True
    assert body["model_run"]["git_sha"] == "abc123"
    assert body["model_run"]["incumbent_version"] == "bracket-1.2"


def test_a_losing_run_is_still_reported_but_carries_no_rows():
    """R28: failed challengers are recorded, not deleted — and not written.
    The endpoint discards them; this client never offers them in the first
    place, so a mistake on either side is not enough on its own."""
    client, seen = _client(
        lambda _r: httpx.Response(200, json={"accepted": False, "reason": "gate_not_passed",
                                             "model_run_id": "run_2", "rows_written": 0})
    )
    result = client.post_run(
        shop_domain="s1.myshopify.com", kind="baseline",
        model_version="baseline-challenger-2.0", gate_passed=False,
        bands=[_band("2026-07-30"), _band("2026-07-31")],
    )
    import json
    body = json.loads(seen[0].content)
    assert body["bands"] == [] and body["fits"] == []
    assert body["model_run"]["gate_passed"] is False
    assert not result.accepted
    assert result.reason == "gate_not_passed"
    assert not result.is_error  # a correct rejection must not turn the nightly red
    assert "rejected" in result.describe()


def test_contract_validation_failure_is_an_error_the_nightly_goes_red_on():
    client, _ = _client(
        lambda _r: httpx.Response(
            422,
            json={"accepted": False, "reason": "contract_validation_failed", "model_run_id": "run_3",
                  "rows_written": 0, "problems": [{"path": "bands[0].low", "message": "low > expected_units"}],
                  "problem_count": 1},
        )
    )
    result = client.post_run(shop_domain="s1.myshopify.com", kind="baseline",
                             model_version="baseline-cleanlevel-1.0", gate_passed=True,
                             bands=[_band("2026-07-30")])
    assert result.is_error and result.problems
    assert "low > expected_units" in result.describe()


def test_oversized_payload_raises_instead_of_truncating():
    """All-or-nothing per request is the endpoint's guarantee. Splitting a band
    set across requests would trade it away silently."""
    client, seen = _client(_accepted())
    bands = [_band(f"2026-07-{(i % 28) + 1:02d}") for i in range(MAX_ROWS_PER_REQUEST + 1)]
    with pytest.raises(ValueError, match="all-or-nothing"):
        client.post_run(shop_domain="s1.myshopify.com", kind="baseline",
                        model_version="baseline-cleanlevel-1.0", gate_passed=True, bands=bands)
    assert seen == []  # nothing was sent


def test_unknown_kind_is_rejected_before_any_request():
    client, seen = _client(_accepted())
    with pytest.raises(ValueError, match="kind must be one of"):
        client.post_run(shop_domain="s1.myshopify.com", kind="elasticty",  # typo
                        model_version="x", gate_passed=True)
    assert seen == []


def test_http_error_body_surfaces_without_leaking_the_secret():
    client, _ = _client(
        lambda _r: httpx.Response(401, json={"error": {"code": "unauthorized",
                                                       "message": "Missing or invalid ML ingest secret."}})
    )
    result = client.post_run(shop_domain="s1.myshopify.com", kind="elasticity",
                             model_version="x", gate_passed=True)
    assert result.is_error and result.status_code == 401
    assert result.reason == "unauthorized"
    assert "s3cret" not in result.describe()


def test_non_json_response_does_not_crash_the_run():
    """A proxy returning an HTML error page must be a red run, not a traceback
    that hides which model was being posted."""
    client, _ = _client(lambda _r: httpx.Response(502, text="<html>bad gateway</html>"))
    result = client.post_run(shop_domain="s1.myshopify.com", kind="baseline",
                             model_version="x", gate_passed=True)
    assert result.is_error and result.status_code == 502 and not result.accepted


def test_no_automatic_retry_on_failure():
    """A POST that times out after the server committed is the crash window.
    One attempt, then fail loudly."""
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        return httpx.Response(500, json={"error": {"code": "write_failed", "message": "boom"}})

    transport = httpx.Client(transport=httpx.MockTransport(handler))
    client = IngestClient("https://app.example.com", "s3cret", client=transport)
    result = client.post_run(shop_domain="s1.myshopify.com", kind="baseline",
                             model_version="x", gate_passed=True, bands=[_band("2026-07-30")])
    assert len(attempts) == 1
    assert result.is_error


def test_git_sha_prefers_ci_environment(monkeypatch):
    monkeypatch.setenv("GITHUB_SHA", "deadbeef")
    assert git_sha() == "deadbeef"


def test_result_describe_covers_the_accepted_case():
    result = IngestResult(accepted=True, status_code=200, model_run_id="run_9", rows_written=42)
    assert "42 rows" in result.describe() and not result.is_error
