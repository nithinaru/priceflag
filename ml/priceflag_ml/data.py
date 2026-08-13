"""Read-only data access for Priceflag's model-training lane.

The real worker reads through Priceflag's authenticated HTTPS export endpoint.
It never receives a PostgreSQL login, a Supabase API key, or the application's
service-role credential. The endpoint exposes only aggregate model inputs and
performs all database access inside the application boundary.
"""

from __future__ import annotations

import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd

from .golden import GoldenConfig, generate_store
from .target import VercelTargetAttestor, clean_https_origin

CANONICAL_COLUMNS = ["shop_id", "sku", "date", "units", "price_cents", "revenue_cents", "promo", "stockout"]
# Every column the products surface serves (app/api/ml/export/route.ts
# productRows) — the empty frame must declare the same shape the non-empty
# path returns, or downstream column access breaks only on empty stores.
PRODUCTS_COLUMNS = [
    "shop_domain",
    "variant_gid",
    "product_gid",
    "title",
    "variant_title",
    "sku",
    "vendor",
    "product_type",
    "status",
    "price_cents",
    "compare_at_cents",
    "cogs_cents",
    "cogs_source",
    "inventory_quantity",
    "excluded_from_pricing",
    "last_synced_at",
]
SURFACES = {"product_days", "products", "price_history", "rollout_windows"}
MAX_EXPORT_ROWS = 500_000


@dataclass(frozen=True)
class SourceIdentity:
    project_ref: str
    environment: str
    source_authority: str


def load_golden(cfg: GoldenConfig | None = None) -> pd.DataFrame:
    """Golden-store daily aggregates in the canonical shape."""
    return generate_store(cfg).orders[CANONICAL_COLUMNS].copy()


def densify_daily(orders: pd.DataFrame) -> pd.DataFrame:
    """Fill missing calendar days per (shop_id, sku) with zero-order rows."""
    if orders.empty:
        return orders.copy()
    out = []
    for (shop, sku), group in orders.groupby(["shop_id", "sku"]):
        group = group.sort_values("date").set_index("date")
        full = pd.date_range(group.index.min(), group.index.max(), freq="D")
        group = group.reindex(full)
        group.index.name = "date"
        group["shop_id"] = shop
        group["sku"] = sku
        group["price_cents"] = group["price_cents"].ffill().bfill()
        group["units"] = group["units"].fillna(0)
        group["revenue_cents"] = group["revenue_cents"].fillna(0)
        group["promo"] = group["promo"].fillna(False)
        group["stockout"] = group["stockout"].fillna(False)
        out.append(group.reset_index())
    frame = pd.concat(out, ignore_index=True)
    frame["units"] = frame["units"].astype(int)
    frame["revenue_cents"] = frame["revenue_cents"].astype(np.int64)
    frame["price_cents"] = frame["price_cents"].fillna(0).astype(np.int64)
    frame["promo"] = frame["promo"].astype(bool)
    frame["stockout"] = frame["stockout"].astype(bool)
    return frame[CANONICAL_COLUMNS]


class PriceflagApiSource:
    """Read model inputs from the pinned Priceflag server-to-server API."""

    VIEW_COLUMN_MAP = {
        "shop_domain": "shop_id",
        "variant_gid": "sku",
        "day": "date",
        "units": "units",
        "list_price_cents": "price_cents",
        "net_revenue_cents": "revenue_cents",
        "on_promo": "promo",
        "had_stockout": "stockout",
    }

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
        if not secret:
            raise ValueError("PriceflagApiSource needs an ML pipeline secret")
        self._origin = clean_https_origin(base_url, "PRICEFLAG_APP_URL")
        self._url = self._origin + "/api/ml/export"
        self._secret = secret
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout
        self._target = VercelTargetAttestor(
            self._origin,
            vercel_token,
            expected_target,
            attestation_client,
        )
        self._shops: list[str] | None = None

    @classmethod
    def from_env(cls, client: Any = None) -> "PriceflagApiSource":
        base = os.environ.get("PRICEFLAG_APP_URL") or os.environ.get("APP_URL") or ""
        expected_base = os.environ.get("PRICEFLAG_EXPECTED_APP_URL", "")
        secret = os.environ.get("ML_INGEST_SECRET", "")
        vercel_token = os.environ.get("VERCEL_TOKEN", "")
        expected_target = os.environ.get("PRICEFLAG_EXPECTED_VERCEL_TARGET", "")
        if not base or not expected_base or not secret or not vercel_token or not expected_target:
            raise RuntimeError(
                "PRICEFLAG_APP_URL, PRICEFLAG_EXPECTED_APP_URL, ML_INGEST_SECRET, "
                "VERCEL_TOKEN and PRICEFLAG_EXPECTED_VERCEL_TARGET are required for real reads"
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

    def _http(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=self._timeout)
        return self._client

    def _post(self, payload: dict) -> dict:
        self._target.attest()
        response = self._http().post(
            self._url,
            json=payload,
            headers={"Authorization": f"Bearer {self._secret}", "Content-Type": "application/json"},
        )
        try:
            body = response.json()
        except (ValueError, TypeError) as error:
            raise RuntimeError(f"ML export returned invalid JSON with HTTP {response.status_code}") from error
        if response.status_code != 200:
            raise RuntimeError(f"ML export failed with HTTP {response.status_code}")
        if not isinstance(body, dict):
            raise RuntimeError("ML export returned an invalid response object")
        return body

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            close = getattr(self._client, "close", None)
            if callable(close):
                close()
        self._client = None

    def attest(self, expected_project_ref: str, expected_environment: str) -> SourceIdentity:
        if not re.fullmatch(r"[a-z]{20}", expected_project_ref):
            raise ValueError("expected ML project ref must be exactly 20 lowercase letters")
        if expected_environment not in {"staging", "production"}:
            raise ValueError("expected ML environment must be staging or production")
        body = self._post({"operation": "attest"})
        if body.get("schema_version") != 1 or body.get("source") != "priceflag-ml-export":
            raise RuntimeError("ML export source attestation contract does not match")
        if body.get("project_ref") != expected_project_ref:
            raise RuntimeError("ML export Supabase project marker does not match")
        if body.get("environment") != expected_environment:
            raise RuntimeError("ML export environment marker does not match")
        shops = body.get("shops")
        if not isinstance(shops, list) or any(
            not isinstance(shop, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.myshopify\.com", shop)
            for shop in shops
        ):
            raise RuntimeError("ML export returned an invalid shop list")
        if len(set(shops)) != len(shops):
            raise RuntimeError("ML export returned duplicate shops")
        self._shops = list(shops)
        return SourceIdentity(
            project_ref=expected_project_ref,
            environment=expected_environment,
            source_authority="priceflag-ml-export",
        )

    def list_shops(self) -> list[str]:
        if self._shops is None:
            raise RuntimeError("ML export source must be attested before reading shops")
        return list(self._shops)

    def _read(self, surface: str, shop_domain: str) -> list[dict]:
        if surface not in SURFACES:
            raise ValueError("unsupported ML export surface")
        if self._shops is None or shop_domain not in self._shops:
            raise ValueError("shop is outside the attested ML export scope")
        rows: list[dict] = []
        cursor: int | None = 0
        while cursor is not None:
            body = self._post(
                {
                    "operation": "read",
                    "surface": surface,
                    "shop_domain": shop_domain,
                    "cursor": cursor,
                    "limit": 1_000,
                }
            )
            if (
                body.get("schema_version") != 1
                or body.get("surface") != surface
                or body.get("shop_domain") != shop_domain
                or not isinstance(body.get("rows"), list)
            ):
                raise RuntimeError("ML export page contract does not match the request")
            page = body["rows"]
            if any(not isinstance(row, dict) for row in page):
                raise RuntimeError("ML export page contains a non-object row")
            rows.extend(page)
            if len(rows) > MAX_EXPORT_ROWS:
                raise RuntimeError("ML export exceeded the per-surface safety limit")
            next_cursor = body.get("next_cursor")
            if next_cursor is not None and (
                not isinstance(next_cursor, int)
                or isinstance(next_cursor, bool)
                or next_cursor <= cursor
                or not page
            ):
                raise RuntimeError("ML export returned an invalid pagination cursor")
            cursor = next_cursor
        return rows

    def verify_ingest_receipts(
        self,
        receipts: Sequence[tuple[str, str, int]],
        expected_sha: str,
    ) -> int:
        if not receipts:
            raise ValueError("at least one ingest receipt is required")
        if not re.fullmatch(r"[0-9a-f]{40}", expected_sha):
            raise ValueError("ingest receipt verification requires an exact lowercase commit SHA")
        grouped: dict[str, list[dict]] = {}
        seen: set[str] = set()
        for shop_domain, run_id, rows_written in receipts:
            canonical_id = str(UUID(run_id))
            if (
                self._shops is None
                or shop_domain not in self._shops
                or rows_written < 1
                or canonical_id in seen
            ):
                raise ValueError("ingest receipts must be unique, positive and inside the attested shop scope")
            seen.add(canonical_id)
            grouped.setdefault(shop_domain, []).append(
                {"id": canonical_id, "git_sha": expected_sha, "rows_written": rows_written}
            )
        verified = 0
        for shop_domain, expected in grouped.items():
            body = self._post(
                {
                    "operation": "verify_receipts",
                    "shop_domain": shop_domain,
                    "receipts": expected,
                }
            )
            if (
                body.get("schema_version") != 1
                or body.get("shop_domain") != shop_domain
                or body.get("verified") != len(expected)
            ):
                raise RuntimeError("model-run receipt read-back did not match")
            verified += len(expected)
        return verified

    def rollout_windows(self, shop_domain: str, status: str | None = None) -> pd.DataFrame:
        rows = self._read("rollout_windows", shop_domain)
        if status is not None:
            rows = [row for row in rows if row.get("status") == status]
        if not rows:
            return pd.DataFrame(
                columns=["shop_domain", "rollout_id", "status", "start_day", "end_day", "variant_gids"]
            )
        frame = pd.DataFrame(rows)
        for column in ("start_day", "end_day"):
            if column in frame.columns:
                frame[column] = pd.to_datetime(frame[column])
        return frame.sort_values("start_day").reset_index(drop=True)

    def price_history(self, shop_domain: str, rollout_id: str | None = None) -> pd.DataFrame:
        rows = self._read("price_history", shop_domain)
        if rollout_id is not None:
            rows = [row for row in rows if row.get("rollout_id") == rollout_id]
        if not rows:
            return pd.DataFrame(
                columns=[
                    "variant_gid",
                    "applied_at",
                    "before_price_cents",
                    "after_price_cents",
                    "source",
                    "rollout_id",
                    "stage_index",
                ]
            )
        frame = pd.DataFrame(rows)
        frame["applied_at"] = pd.to_datetime(frame["applied_at"], format="mixed", utc=True)
        return frame.sort_values(["variant_gid", "applied_at"]).reset_index(drop=True)

    def products(self, shop_domain: str) -> pd.DataFrame:
        rows = self._read("products", shop_domain)
        if not rows:
            return pd.DataFrame(columns=PRODUCTS_COLUMNS)
        return pd.DataFrame(rows).sort_values("variant_gid").reset_index(drop=True)

    def order_days(self, shop_domain: str) -> pd.DataFrame:
        rows = self._read("product_days", shop_domain)
        if not rows:
            return pd.DataFrame(columns=CANONICAL_COLUMNS)
        frame = pd.DataFrame(rows).rename(columns=self.VIEW_COLUMN_MAP)
        missing = set(CANONICAL_COLUMNS) - set(frame.columns)
        if missing:
            raise RuntimeError(f"ML product-day export is missing required columns: {sorted(missing)}")
        frame["date"] = pd.to_datetime(frame["date"])
        for column, default in (("promo", False), ("stockout", False)):
            frame[column] = frame[column].fillna(default)
        return densify_daily(frame[CANONICAL_COLUMNS])
