"""Pin and attest the Priceflag application endpoint used by the ML worker."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlparse

PRICEFLAG_VERCEL_PROJECT_ID = "prj_RU8NlBDoR7t89BNqn5BagOpmpnmm"
PRICEFLAG_VERCEL_TEAM_ID = "team_AqaBD6YaOf9DIJ7NzbytTZTW"


def clean_https_origin(value: str, name: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.port not in {None, 443}
    ):
        raise ValueError(f"{name} must be a clean HTTPS origin")
    return f"https://{parsed.hostname}"


class VercelTargetAttestor:
    """Verify an origin resolves to the pinned Priceflag Vercel deployment."""

    def __init__(
        self,
        origin: str,
        vercel_token: str | None,
        expected_target: str | None,
        client: Any = None,
    ) -> None:
        if (vercel_token is None) != (expected_target is None):
            raise ValueError("Vercel token and expected target must be configured together")
        if expected_target not in {None, "production", "preview"}:
            raise ValueError("expected Vercel target must be production or preview")
        if vercel_token is not None and not origin.endswith(".vercel.app"):
            raise ValueError("attested pipeline target must be a vercel.app origin")
        self._origin = origin
        self._vercel_token = vercel_token
        self._expected_target = expected_target
        self._client = client
        self._attested = False

    def attest(self) -> None:
        if self._vercel_token is None or self._attested:
            return
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=30.0)
        hostname = urlparse(self._origin).hostname
        endpoint = (
            f"https://api.vercel.com/v13/deployments/{quote(hostname or '', safe='')}"
            f"?teamId={quote(PRICEFLAG_VERCEL_TEAM_ID, safe='')}"
        )
        response = self._client.get(
            endpoint,
            headers={"Authorization": f"Bearer {self._vercel_token}"},
        )
        if response.status_code != 200:
            raise RuntimeError(f"Vercel pipeline-target attestation failed with HTTP {response.status_code}")
        body = response.json()
        if not isinstance(body, dict):
            raise RuntimeError("Vercel pipeline-target attestation returned an invalid payload")
        project = body.get("project")
        project_id = body.get("projectId") or (project.get("id") if isinstance(project, dict) else None)
        aliases = body.get("alias") if isinstance(body.get("alias"), list) else []
        deployment_url = body.get("url")
        if project_id != PRICEFLAG_VERCEL_PROJECT_ID:
            raise RuntimeError("pipeline target is outside the pinned Priceflag Vercel project")
        if body.get("readyState") != "READY":
            raise RuntimeError("pipeline target deployment is not READY")
        actual_target = body.get("target")
        if self._expected_target == "production" and actual_target != "production":
            raise RuntimeError("pipeline target is not the Production deployment")
        if self._expected_target == "preview" and actual_target == "production":
            raise RuntimeError("preview pipeline gate resolved to a Production deployment")
        if hostname != deployment_url and hostname not in aliases:
            raise RuntimeError("Vercel attestation did not return the expected pipeline hostname")
        self._attested = True
