"""The write path: post contract rows to Lane B's ``POST /api/ml/ingest``.

Lane C's database role is read-only and stays that way — request 9 asked for
either a write key or an endpoint, and Lane B built the endpoint, which is the
better half of that choice. Everything a model produces reaches Postgres by
being *validated and accepted* by code that holds the service role, never by
this process holding a write credential.

The endpoint's three gates (secret, JSON Schema, R28 honesty) are its own; this
client's job is to be honest on the way in:

- **``gate_passed`` is never inferred.** The caller passes the harness verdict.
  A run that lost is still posted — R28 wants failed challengers *recorded*,
  and the endpoint records them and discards their rows — but this client
  drops the rows before sending, so a losing run cannot even accidentally
  offer data to write.
- **No automatic retry.** A POST that times out after the server committed is
  the crash window Lane D fuzzed on the price writer. Fits and bands are
  upserted, so a retry would not corrupt them, but it would mint a second
  ``model_runs`` row claiming the same work — and a registry that
  double-counts is a registry nobody trusts. A failed post is a red nightly.
- **No silent truncation.** Over ``MAX_ROWS_PER_REQUEST`` the client raises.
  Writes are all-or-nothing per request, so chunking would trade that
  atomicity for convenience: half a band set in the table is worse than none,
  because the evaluator reads the half that landed and believes it is whole.

Configuration: ``PRICEFLAG_APP_URL`` (or ``APP_URL``) and ``ML_INGEST_SECRET``.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from typing import Any

# One request carries one model run. 500 SKUs x 14 days of bands is ~7k rows,
# comfortably inside the endpoint's 60s budget; beyond that the caller should
# narrow the horizon rather than have this client invent a chunking policy.
MAX_ROWS_PER_REQUEST = 20_000

VALID_KINDS = ("elasticity", "baseline", "counterfactual", "report")


@dataclass
class IngestResult:
    """What the endpoint said. ``accepted`` false is not necessarily an error:
    a correctly-rejected losing challenger returns 200 with accepted=false."""

    accepted: bool
    status_code: int
    reason: str | None = None
    model_run_id: str | None = None
    rows_written: int = 0
    message: str | None = None
    problems: list[dict] = field(default_factory=list)

    @property
    def is_error(self) -> bool:
        """True only for outcomes the nightly should go red on. A recorded
        rejection (gate_not_passed) is the system working."""
        return self.status_code >= 400 or self.reason == "contract_validation_failed"

    def describe(self) -> str:
        if self.accepted:
            return f"accepted: {self.rows_written} rows (model_run {self.model_run_id})"
        if self.reason == "gate_not_passed":
            return f"recorded as rejected, no rows stored (model_run {self.model_run_id})"
        detail = self.message or self.reason or f"HTTP {self.status_code}"
        if self.problems:
            detail += f"; first problem: {json.dumps(self.problems[0])}"
        return f"NOT accepted: {detail}"


def git_sha() -> str | None:
    """The commit the models were run from — ``model_runs.git_sha`` is how a
    surprising fit is traced back to the code that produced it."""
    for env_var in ("GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA"):
        sha = os.environ.get(env_var)
        if sha:
            return sha
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    return sha if out.returncode == 0 and sha else None


class IngestClient:
    """Poster for ``POST /api/ml/ingest``. Holds no database credential."""

    def __init__(self, base_url: str, secret: str, client: Any = None, timeout: float = 120.0) -> None:
        if not base_url or not secret:
            raise ValueError("IngestClient needs both base_url and secret")
        self._url = base_url.rstrip("/") + "/api/ml/ingest"
        self._secret = secret
        self._client = client  # injectable for tests; lazily created otherwise
        self._timeout = timeout

    @classmethod
    def from_env(cls, client: Any = None) -> "IngestClient":
        base = os.environ.get("PRICEFLAG_APP_URL") or os.environ.get("APP_URL") or ""
        secret = os.environ.get("ML_INGEST_SECRET", "")
        if not base or not secret:
            raise RuntimeError(
                "PRICEFLAG_APP_URL (or APP_URL) and ML_INGEST_SECRET are not set. "
                "Without them the nightly emits artifacts only and writes nothing."
            )
        return cls(base, secret, client=client)

    @classmethod
    def from_env_or_none(cls, client: Any = None) -> "IngestClient | None":
        """Same, but absent configuration is a normal state, not a failure —
        golden-mode runs have nowhere to post and that is fine."""
        try:
            return cls.from_env(client=client)
        except RuntimeError:
            return None

    def _get_client(self) -> Any:
        if self._client is None:
            import httpx  # lazy: keep golden-only workflows free of network deps

            self._client = httpx.Client(timeout=self._timeout)
        return self._client

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
        notes: str | None = None,
        sha: str | None = None,
    ) -> IngestResult:
        if kind not in VALID_KINDS:
            raise ValueError(f"kind must be one of {VALID_KINDS}, got {kind!r}")

        fits = list(fits or [])
        bands = list(bands or [])
        if not gate_passed:
            # The endpoint would discard these anyway. Dropping them here makes
            # the intent explicit and keeps a losing run's payload small.
            fits, bands = [], []

        total = len(fits) + len(bands)
        if total > MAX_ROWS_PER_REQUEST:
            raise ValueError(
                f"{total} rows exceeds MAX_ROWS_PER_REQUEST={MAX_ROWS_PER_REQUEST}. "
                "Writes are all-or-nothing per request; narrow the horizon or the "
                "SKU set rather than splitting a band set across requests."
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
            # The endpoint's failure shape: {error: {code, message, ...}}.
            message = error.get("message") or message

        return IngestResult(
            accepted=bool(body.get("accepted", False)),
            status_code=response.status_code,
            reason=body.get("reason") or (error.get("code") if isinstance(error, dict) else None),
            model_run_id=body.get("model_run_id"),
            rows_written=int(body.get("rows_written") or 0),
            message=message,
            problems=list(body.get("problems") or []),
        )
