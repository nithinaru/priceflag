"""Fail closed unless an artifact proves a successful, redacted real-data nightly."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

EXPECTED_FIELDS = {
    "schema_version",
    "source_transport",
    "source_authority",
    "project_ref",
    "environment",
    "required_real_ingest",
    "shops_visible",
    "shops_with_orders",
    "fits_generated",
    "bands_generated",
    "reports_generated",
    "rows_acknowledged",
    "runs_verified",
    "success",
    "failure_code",
    "generated_at",
    "github_sha",
}


def verify(
    evidence: object,
    expected_sha: str | None,
    expected_project_ref: str | None = None,
    expected_environment: str | None = None,
) -> None:
    if not isinstance(evidence, dict) or set(evidence) != EXPECTED_FIELDS:
        raise ValueError("nightly evidence schema or redaction allowlist does not match")
    if evidence["schema_version"] != 1:
        raise ValueError("unsupported nightly evidence schema")
    if evidence["source_transport"] != "https":
        raise ValueError("nightly did not use the authenticated application export")
    if evidence["source_authority"] != "priceflag-ml-export":
        raise ValueError("nightly did not use the narrow Priceflag ML export authority")
    if not isinstance(evidence["project_ref"], str) or not re.fullmatch(r"[a-z]{20}", evidence["project_ref"]):
        raise ValueError("nightly evidence has no valid Supabase project identity")
    if evidence["environment"] not in {"staging", "production"}:
        raise ValueError("nightly evidence has no valid database environment")
    if expected_project_ref and evidence["project_ref"] != expected_project_ref:
        raise ValueError("nightly evidence was produced from a different Supabase project")
    if expected_environment and evidence["environment"] != expected_environment:
        raise ValueError("nightly evidence was produced from a different database environment")
    if evidence["required_real_ingest"] is not True:
        raise ValueError("nightly was not run with the real-ingest requirement")
    for field in ("shops_visible", "shops_with_orders", "rows_acknowledged", "runs_verified"):
        value = evidence[field]
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"nightly evidence has no positive {field}")
    for field in ("fits_generated", "bands_generated", "reports_generated"):
        value = evidence[field]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError(f"nightly evidence has invalid {field}")
    if evidence["shops_with_orders"] > evidence["shops_visible"]:
        raise ValueError("nightly evidence has more shops with orders than visible shops")
    generated_rows = sum(evidence[field] for field in ("fits_generated", "bands_generated", "reports_generated"))
    if evidence["rows_acknowledged"] != generated_rows:
        raise ValueError("nightly acknowledged row count does not match generated model rows")
    if evidence["runs_verified"] > evidence["rows_acknowledged"]:
        raise ValueError("nightly verified more model runs than acknowledged rows")
    if evidence["success"] is not True or evidence["failure_code"] is not None:
        raise ValueError("nightly evidence does not report a clean run")
    if not isinstance(evidence["generated_at"], str) or not evidence["generated_at"].endswith("Z"):
        raise ValueError("nightly evidence has no UTC generation timestamp")
    if not isinstance(evidence["github_sha"], str) or not re.fullmatch(r"[0-9a-f]{40}", evidence["github_sha"]):
        raise ValueError("nightly evidence has no exact commit SHA")
    if expected_sha and evidence["github_sha"] != expected_sha:
        raise ValueError("nightly evidence was produced for a different commit")


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("usage: verify_nightly_evidence.py <evidence.json>")
    evidence = json.loads(Path(sys.argv[1]).read_text())
    expected_sha = os.environ.get("GITHUB_SHA")
    expected_project_ref = os.environ.get("PRICEFLAG_ML_EXPECTED_PROJECT_REF")
    expected_environment = os.environ.get("PRICEFLAG_ML_EXPECTED_ENVIRONMENT")
    if not expected_sha or not re.fullmatch(r"[0-9a-f]{40}", expected_sha):
        raise ValueError("exact GITHUB_SHA is required for evidence verification")
    if not expected_project_ref or not expected_environment:
        raise ValueError("expected ML project and environment are required for evidence verification")
    verify(evidence, expected_sha, expected_project_ref, expected_environment)
    print("real-store nightly evidence verified (merchant data redacted)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
