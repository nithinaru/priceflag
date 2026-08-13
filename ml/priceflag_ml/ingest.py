"""Post validated model artifacts to Priceflag's server-only ingest endpoint."""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any
from .target import VercelTargetAttestor, clean_https_origin

MAX_ROWS_PER_REQUEST = 20_000
VALID_KINDS = ("elasticity", "baseline", "counterfactual", "report", "recommendation")
def assert_bands_cannot_double_count(bands: list[dict]) -> None:
    if not bands:
        return
    kinds = {band.get("band_kind") for band in bands}
    if len(kinds) > 1:
        raise ValueError("one request must carry one band_kind; mixed bands can double-count expectations")
    seen: set[tuple] = set()
    for band in bands:
        key = (band.get("variant_gid"), band.get("day"), band.get("rollout_id"))
        if key in seen:
            raise ValueError("duplicate band row in ingest request")
        seen.add(key)


@dataclass
class IngestResult:
    accepted: bool
    status_code: int
    reason: str | None = None
    model_run_id: str | None = None
    rows_written: int = 0
    fits_written: int = 0
    bands_written: int = 0
    reports_written: int = 0
    recommendations_written: int = 0
    message: str | None = None
    problems: list[dict] = field(default_factory=list)
    dropped: str | None = None

    @property
    def is_error(self) -> bool:
        return self.status_code >= 400 or self.reason == "contract_validation_failed" or self.dropped is not None

    def describe(self) -> str:
        if self.dropped is not None:
            return "NOT stored: endpoint acknowledgement did not match the request"
        if self.accepted:
            return f"accepted: {self.rows_written} rows"
        if self.reason == "gate_not_passed":
            return "recorded as rejected, no rows stored"
        return f"NOT accepted: {self.reason or f'HTTP {self.status_code}'}"


def git_sha() -> str | None:
    for variable in ("GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA"):
        if os.environ.get(variable):
            return os.environ[variable]
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


class IngestClient:
    def __init__(
        self,
        base_url: str,
        secret: str,
        client: Any = None,
        timeout: float = 120.0,
        *,
        vercel_token: str | None = None,
        expected_target: str | None = None,
        attestation_client: Any = None,
    ) -> None:
        if not base_url or not secret:
            raise ValueError("IngestClient needs both base_url and secret")
        origin = clean_https_origin(base_url, "PRICEFLAG_APP_URL")
        self._origin = origin
        self._url = origin + "/api/ml/ingest"
        self._secret = secret
        self._client = client
        self._timeout = timeout
        self._target = VercelTargetAttestor(origin, vercel_token, expected_target, attestation_client)

    @classmethod
    def from_env(cls, client: Any = None) -> "IngestClient":
        base = os.environ.get("PRICEFLAG_APP_URL") or os.environ.get("APP_URL") or ""
        expected_base = os.environ.get("PRICEFLAG_EXPECTED_APP_URL", "")
        secret = os.environ.get("ML_INGEST_SECRET", "")
        vercel_token = os.environ.get("VERCEL_TOKEN", "")
        expected_target = os.environ.get("PRICEFLAG_EXPECTED_VERCEL_TARGET", "")
        if not base or not expected_base or not secret or not vercel_token or not expected_target:
            raise RuntimeError(
                "PRICEFLAG_APP_URL, PRICEFLAG_EXPECTED_APP_URL, ML_INGEST_SECRET, "
                "VERCEL_TOKEN and PRICEFLAG_EXPECTED_VERCEL_TARGET are required for real ingest"
            )
        try:
            origin = clean_https_origin(base, "PRICEFLAG_APP_URL")
            expected_origin = clean_https_origin(expected_base, "PRICEFLAG_EXPECTED_APP_URL")
        except ValueError as error:
            raise RuntimeError(str(error)) from error
        if origin != expected_origin:
            raise RuntimeError("PRICEFLAG_APP_URL does not match the protected expected app origin")
        return cls(
            origin,
            secret,
            client=client,
            vercel_token=vercel_token,
            expected_target=expected_target,
        )

    @classmethod
    def from_env_or_none(cls, client: Any = None) -> "IngestClient | None":
        try:
            return cls.from_env(client=client)
        except RuntimeError:
            return None

    def _get_client(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=self._timeout)
        return self._client

    def _attest_target(self) -> None:
        self._target.attest()

    def post_run(
        self,
        *,
        shop_domain: str,
        kind: str,
        model_version: str,
        gate_passed: bool,
        metrics: dict | None = None,
        incumbent_version: str | None = None,
        fits: list[dict] | None = None,
        bands: list[dict] | None = None,
        reports: list[dict] | None = None,
        recommendations: list[dict] | None = None,
        notes: str | None = None,
        sha: str | None = None,
    ) -> IngestResult:
        self._attest_target()
        if kind not in VALID_KINDS:
            raise ValueError(f"kind must be one of {VALID_KINDS}, got {kind!r}")
        fits, bands, reports, recommendations = (
            list(fits or []),
            list(bands or []),
            list(reports or []),
            list(recommendations or []),
        )
        if not gate_passed:
            fits, bands, reports, recommendations = [], [], [], []
        wrong_surface = (
            (kind == "elasticity" and (bands or reports or recommendations))
            or (kind in ("baseline", "counterfactual") and (fits or reports or recommendations))
            or (kind == "report" and (fits or bands or recommendations))
            or (kind == "recommendation" and (fits or bands or reports))
        )
        if wrong_surface:
            raise ValueError(f"kind={kind} cannot carry rows from a different model surface")
        assert_bands_cannot_double_count(bands)
        expected = (len(fits), len(bands), len(reports), len(recommendations))
        if sum(expected) > MAX_ROWS_PER_REQUEST:
            raise ValueError(
                f"{sum(expected)} rows exceeds MAX_ROWS_PER_REQUEST={MAX_ROWS_PER_REQUEST}; "
                "writes are all-or-nothing"
            )

        payload = {
            "shop_domain": shop_domain,
            "model_run": {
                "kind": kind,
                "model_version": model_version,
                "git_sha": sha if sha is not None else git_sha(),
                "gate_passed": gate_passed,
                "incumbent_version": incumbent_version,
                "metrics": metrics or {},
                "notes": notes,
            },
            "fits": fits,
            "bands": bands,
            "reports": reports,
            "recommendations": recommendations,
        }
        response = self._get_client().post(
            self._url,
            json=payload,
            headers={"Authorization": f"Bearer {self._secret}", "Content-Type": "application/json"},
        )
        try:
            body = response.json()
        except (ValueError, json.JSONDecodeError):
            body = {}
        if not isinstance(body, dict):
            body = {}
        error = body.get("error")
        message = body.get("message")
        if isinstance(error, dict):
            message = error.get("message") or message

        result = IngestResult(
            accepted=bool(body.get("accepted", False)),
            status_code=response.status_code,
            reason=body.get("reason") or (error.get("code") if isinstance(error, dict) else None),
            model_run_id=body.get("model_run_id"),
            rows_written=int(body.get("rows_written") or 0),
            fits_written=int(body.get("fits_written") or 0),
            bands_written=int(body.get("bands_written") or 0),
            reports_written=int(body.get("reports_written") or 0),
            recommendations_written=int(body.get("recommendations_written") or 0),
            message=message,
            problems=list(body.get("problems") or []),
        )
        if result.accepted:
            actual = (
                result.fits_written,
                result.bands_written,
                result.reports_written,
                result.recommendations_written,
            )
            if actual != expected or result.rows_written != sum(expected):
                result.dropped = (
                    f"endpoint accounted for fits/bands/reports/recommendations={actual} "
                    f"and total={result.rows_written}; sent {expected} and total={sum(expected)}"
                )
        return result
