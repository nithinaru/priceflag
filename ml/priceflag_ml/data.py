"""Read-only data access for Lane C.

Two sources behind one shape:

- ``load_golden`` — the synthetic golden store (always available; what tests
  and the harness run against until Lane B provides real DB access).
- ``SupabaseSource`` — direct read-only PostgreSQL access using Lane B's
  ``priceflag_ml_readonly`` role supplied in ``SUPABASE_ML_READONLY_KEY`` as a
  libpq connection URL, via Lane B's stable read
  surface: the ``ml_product_days`` view (contracts/db/schema.md). View columns
  map onto the canonical frame as sku=variant_gid, date=day,
  price_cents=list_price_cents (the elasticity regressor — NOT the realized
  price, which absorbs discounts), revenue_cents=net_revenue_cents,
  promo=on_promo, stockout=had_stockout. Nothing in this module ever writes.

Canonical tidy frame (one row per shop x SKU x *consecutive calendar day* —
the harness enforces contiguity)::

    shop_id, sku, date, units, price_cents, revenue_cents, promo, stockout
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse
from uuid import UUID

import numpy as np
import pandas as pd

from .golden import GoldenConfig, generate_store

CANONICAL_COLUMNS = ["shop_id", "sku", "date", "units", "price_cents", "revenue_cents", "promo", "stockout"]

Query = Callable[[str, Sequence[object]], list[dict]]


@dataclass(frozen=True)
class SourceIdentity:
    project_ref: str
    environment: str
    database_role: str


def load_golden(cfg: GoldenConfig | None = None) -> pd.DataFrame:
    """Golden-store daily aggregates in the canonical shape."""
    return generate_store(cfg).orders[CANONICAL_COLUMNS].copy()


def densify_daily(orders: pd.DataFrame) -> pd.DataFrame:
    """Fill missing calendar days per (shop_id, sku) with zero-order rows.

    A real `order_days` table has no row on days with no orders; the harness
    and forecasters require one row per consecutive day. Filled rows get
    units=0, revenue=0, promo=False, stockout=False, and the price
    forward-filled (a day with no orders still had a posted price).
    """
    if orders.empty:
        return orders.copy()
    out = []
    for (shop, sku), g in orders.groupby(["shop_id", "sku"]):
        g = g.sort_values("date").set_index("date")
        full = pd.date_range(g.index.min(), g.index.max(), freq="D")
        g = g.reindex(full)
        g.index.name = "date"
        g["shop_id"] = shop
        g["sku"] = sku
        g["price_cents"] = g["price_cents"].ffill().bfill()
        g["units"] = g["units"].fillna(0)
        g["revenue_cents"] = g["revenue_cents"].fillna(0)
        g["promo"] = g["promo"].fillna(False)
        g["stockout"] = g["stockout"].fillna(False)
        out.append(g.reset_index())
    df = pd.concat(out, ignore_index=True)
    df["units"] = df["units"].astype(int)
    df["revenue_cents"] = df["revenue_cents"].astype(np.int64)
    # A SKU with no observed price on ANY day survives as 0 (unregressable —
    # the elasticity design matrix drops non-positive prices).
    df["price_cents"] = df["price_cents"].fillna(0).astype(np.int64)
    df["promo"] = df["promo"].astype(bool)
    df["stockout"] = df["stockout"].astype(bool)
    return df[CANONICAL_COLUMNS]


class SupabaseSource:
    """Direct PostgreSQL reader for Lane B's narrow ML read surface.

    ``database_url`` must authenticate the dedicated ``priceflag_ml_readonly``
    role. The migration grants that role SELECT only and this client also sets
    ``default_transaction_read_only=on`` as defense in depth. It never accepts
    a Supabase dashboard API key or the application's service-role key.
    """

    def __init__(self, database_url: str, query: Query | None = None, project_ref: str | None = None) -> None:
        parsed = urlparse(database_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or not parsed.username:
            raise ValueError("SupabaseSource needs a PostgreSQL connection URL")
        if not parsed.password:
            raise ValueError("SupabaseSource connection URL must contain the read-only role password")
        if not (parsed.hostname.endswith(".supabase.co") or parsed.hostname.endswith(".supabase.com")):
            raise ValueError("SupabaseSource connection URL must use a Supabase database host")
        if not re.fullmatch(r"priceflag_ml_readonly(?:\.[a-z]{20})?", parsed.username):
            raise ValueError("SupabaseSource must authenticate as priceflag_ml_readonly")
        if parsed.path != "/postgres" or parsed.fragment:
            raise ValueError("SupabaseSource must connect to the postgres database without a fragment")
        if parsed.port not in {None, 5432, 6543}:
            raise ValueError("SupabaseSource must use a standard Supabase database or pooler port")
        query_params = parse_qs(parsed.query)
        if query_params.get("sslmode", [])[-1:] != ["verify-full"]:
            raise ValueError("SupabaseSource connection URL must use sslmode=verify-full")
        if query_params.get("sslrootcert", [])[-1:] != ["system"]:
            raise ValueError("SupabaseSource connection URL must use sslrootcert=system")
        if set(query_params) != {"sslmode", "sslrootcert"} or any(len(values) != 1 for values in query_params.values()):
            raise ValueError("SupabaseSource connection URL may contain only the required TLS parameters")
        self._database_url = database_url
        self._injected_query = query
        self._connection = None
        self._project_ref = project_ref

    @classmethod
    def from_env(cls) -> "SupabaseSource":
        api_url = os.environ.get("SUPABASE_URL", "")
        database_url = os.environ.get("SUPABASE_ML_READONLY_KEY", "")
        if not api_url or not database_url:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_ML_READONLY_KEY are not set. "
                "Lane B provides these (BUILD_BRIEF B6). Until then, use load_golden()."
            )
        api = urlparse(api_url)
        if (
            api.scheme != "https"
            or not api.hostname
            or not re.fullmatch(r"[a-z]{20}\.supabase\.co", api.hostname)
            or api.path not in {"", "/"}
            or api.query
            or api.fragment
            or api.username
            or api.password
        ):
            raise RuntimeError("SUPABASE_URL must be an HTTPS Supabase project origin")
        project_ref = api.hostname.removesuffix(".supabase.co")
        database = urlparse(database_url)
        direct_identity = (
            database.username == "priceflag_ml_readonly"
            and database.hostname == f"db.{project_ref}.supabase.co"
        )
        pooler_identity = database.username == f"priceflag_ml_readonly.{project_ref}"
        pooler_identity = pooler_identity and (
            database.hostname == "pooler.supabase.com"
            or bool(database.hostname and database.hostname.endswith(".pooler.supabase.com"))
        )
        if not (direct_identity or pooler_identity):
            raise RuntimeError("SUPABASE_ML_READONLY_KEY does not identify the SUPABASE_URL project")
        return cls(database_url, project_ref=project_ref)

    def _query(self, sql: str, params: Sequence[object] = ()) -> list[dict]:
        if self._injected_query is not None:
            return self._injected_query(sql, params)
        if self._connection is None:
            import psycopg  # lazy: golden-only tests do not need a database
            from psycopg.rows import dict_row

            self._connection = psycopg.connect(
                self._database_url,
                autocommit=True,
                row_factory=dict_row,
                application_name="priceflag-ml-nightly",
                prepare_threshold=None,
            )
        with self._connection.cursor() as cursor:
            cursor.execute("begin read only")
            try:
                cursor.execute("set local statement_timeout = '60s'")
                cursor.execute(sql, params)
                rows = [dict(row) for row in cursor.fetchall()]
                cursor.execute("commit")
                return rows
            except Exception:
                try:
                    cursor.execute("rollback")
                except Exception:
                    pass
                raise

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def attest(self, expected_project_ref: str, expected_environment: str, sentinel: str) -> SourceIdentity:
        if not re.fullmatch(r"[a-z]{20}", expected_project_ref):
            raise ValueError("expected ML project ref must be exactly 20 lowercase letters")
        if self._project_ref is not None and self._project_ref != expected_project_ref:
            raise ValueError("configured ML project ref does not match SUPABASE_URL")
        if expected_environment not in {"staging", "production"}:
            raise ValueError("expected ML environment must be staging or production")
        if not sentinel:
            raise ValueError("ML database sentinel is required")
        rows = self._query(
            """
            select current_user as database_role,
                   current_setting('app.priceflag_environment', true) as environment,
                   current_setting('app.priceflag_project_ref', true) as project_ref,
                   current_setting('app.priceflag_ml_sentinel', true) as sentinel,
                   role.rolcanlogin as can_login,
                   role.rolsuper as is_superuser,
                   role.rolcreatedb as can_create_database,
                   role.rolcreaterole as can_create_role,
                   role.rolinherit as inherits_roles,
                   role.rolreplication as can_replicate,
                   role.rolbypassrls as bypasses_rls,
                   role.rolconnlimit as connection_limit,
                   (select count(*)::int
                      from pg_auth_members membership
                     where membership.member = role.oid) as role_memberships,
                   has_schema_privilege(current_user, 'public', 'CREATE') as can_create_public_objects,
                   (select count(*)::int
                      from pg_namespace namespace
                     where namespace.nspname <> 'information_schema'
                       and namespace.nspname !~ '^pg_'
                       and has_schema_privilege(
                         current_user, namespace.oid, 'CREATE'
                       )) as creatable_schemas,
                   (select count(*)::int
                     from pg_database database
                     where database.datallowconn
                       and (
                         database.datdba = role.oid
                         or has_database_privilege(
                           current_user, database.oid, 'CREATE'
                         )
                       )) as creatable_databases,
                   has_column_privilege(
                     current_user, 'public.shops', 'access_token_enc', 'SELECT'
                   ) as can_read_shop_token,
                   (select count(*)::int
                      from pg_class relation
                      join pg_namespace namespace on namespace.oid = relation.relnamespace
                     where namespace.nspname <> 'information_schema'
                       and namespace.nspname !~ '^pg_'
                       and relation.relkind in ('r', 'p', 'v', 'm', 'f')
                       and has_table_privilege(
                         current_user,
                         relation.oid,
                         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                       )) as writable_relations,
                   (select count(*)::int
                      from pg_class sequence
                      join pg_namespace namespace on namespace.oid = sequence.relnamespace
                     where namespace.nspname <> 'information_schema'
                       and namespace.nspname !~ '^pg_'
                       and sequence.relkind = 'S'
                       and has_sequence_privilege(
                         current_user, sequence.oid, 'USAGE,SELECT,UPDATE'
                       )) as accessible_sequences,
                   (select count(*)::int
                      from pg_proc routine
                      join pg_namespace namespace on namespace.oid = routine.pronamespace
                     where namespace.nspname <> 'information_schema'
                       and namespace.nspname !~ '^pg_'
                       and routine.prosecdef
                       and has_function_privilege(
                         current_user, routine.oid, 'EXECUTE'
                       )) as executable_security_definers,
                   (select count(*)::int
                      from pg_class relation
                      join pg_namespace namespace on namespace.oid = relation.relnamespace
                      join pg_attribute attribute on attribute.attrelid = relation.oid
                     where namespace.nspname <> 'information_schema'
                       and namespace.nspname !~ '^pg_'
                       and relation.relkind in ('r', 'p', 'v', 'm', 'f')
                       and attribute.attnum > 0
                       and not attribute.attisdropped
                       and (
                         has_column_privilege(
                           current_user, relation.oid, attribute.attnum,
                           'INSERT,UPDATE,REFERENCES'
                         )
                         or (
                           has_column_privilege(
                             current_user, relation.oid, attribute.attnum, 'SELECT'
                           )
                           and not (
                             namespace.nspname = 'public'
                             and (
                               relation.relname = any(array[
                                 'ml_product_days', 'ml_products', 'ml_price_history',
                                 'ml_rollout_windows', 'order_days', 'products',
                                 'journal_entries', 'rollouts', 'rollout_variants',
                                 'elasticity_fits', 'expected_bands', 'model_runs',
                                 'rollout_reports'
                               ])
                               or (
                                 relation.relname = 'shops'
                                 and attribute.attname = any(array[
                                   'id', 'shop_domain', 'name', 'currency',
                                   'timezone', 'mode', 'created_at'
                                 ])
                               )
                             )
                           )
                         )
                       )) as unexpected_column_privileges
              from pg_roles role
             where role.rolname = current_user
            """
        )
        if len(rows) != 1:
            raise RuntimeError("ML database identity query returned an invalid result")
        row = rows[0]
        if row.get("database_role") != "priceflag_ml_readonly":
            raise RuntimeError("ML database connection is not the dedicated read-only role")
        if row.get("environment") != expected_environment:
            raise RuntimeError("ML database environment marker does not match")
        if row.get("project_ref") != expected_project_ref:
            raise RuntimeError("ML database project marker does not match")
        if row.get("sentinel") != sentinel:
            raise RuntimeError("ML database sentinel does not match")
        if row.get("can_login") is not True:
            raise RuntimeError("ML database role is not a dedicated login role")
        unsafe_role_attributes = (
            row.get("is_superuser"),
            row.get("can_create_database"),
            row.get("can_create_role"),
            row.get("inherits_roles"),
            row.get("can_replicate"),
            row.get("bypasses_rls"),
            row.get("can_create_public_objects"),
            row.get("can_read_shop_token"),
        )
        if any(value is not False for value in unsafe_role_attributes):
            raise RuntimeError("ML database role has an unsafe effective role or schema privilege")
        if row.get("connection_limit") != 5 or any(
            row.get(field) != 0
            for field in (
                "role_memberships",
                "creatable_schemas",
                "creatable_databases",
                "writable_relations",
                "accessible_sequences",
                "executable_security_definers",
                "unexpected_column_privileges",
            )
        ):
            raise RuntimeError("ML database role has privileges outside the approved read surface")
        return SourceIdentity(
            project_ref=expected_project_ref,
            environment=expected_environment,
            database_role="priceflag_ml_readonly",
        )

    def verify_ingest_receipts(self, receipts: Sequence[tuple[str, int]], expected_sha: str) -> int:
        if not receipts:
            raise ValueError("at least one ingest receipt is required")
        if not re.fullmatch(r"[0-9a-f]{40}", expected_sha):
            raise ValueError("ingest receipt verification requires an exact lowercase commit SHA")
        expected: dict[str, int] = {}
        for run_id, rows_written in receipts:
            canonical_id = str(UUID(run_id))
            if rows_written < 1 or canonical_id in expected:
                raise ValueError("ingest receipts must contain unique positive writes")
            expected[canonical_id] = rows_written
        rows = self._query(
            """
            select id::text as id, git_sha, status, rows_written
              from public.model_runs
             where id = any(%s::uuid[])
            """,
            [list(expected)],
        )
        if len(rows) != len(expected):
            raise RuntimeError("not every acknowledged model run exists in the attested database")
        for row in rows:
            run_id = str(row.get("id"))
            if (
                run_id not in expected
                or row.get("git_sha") != expected_sha
                or row.get("status") != "succeeded"
                or row.get("rows_written") != expected[run_id]
            ):
                raise RuntimeError("an acknowledged model run failed database read-back verification")
        return len(rows)

    # ml_product_days view column -> canonical frame column
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

    def list_shops(self) -> list[str]:
        rows = self._query("select shop_domain from public.ml_products order by shop_domain")
        return list(dict.fromkeys(row["shop_domain"] for row in rows if row.get("shop_domain")))

    def rollout_windows(self, shop_domain: str, status: str | None = None) -> pd.DataFrame:
        sql = "select * from public.ml_rollout_windows where shop_domain = %s"
        params: list[object] = [shop_domain]
        if status is not None:
            sql += " and status = %s"
            params.append(status)
        rows = self._query(sql + " order by started_at", params)
        if not rows:
            return pd.DataFrame(
                columns=["shop_domain", "rollout_id", "status", "start_day", "end_day", "variant_gids"]
            )
        frame = pd.DataFrame(rows)
        for column in ("start_day", "end_day"):
            if column in frame.columns:
                frame[column] = pd.to_datetime(frame[column])
        return frame

    def price_history(self, shop_domain: str, rollout_id: str | None = None) -> pd.DataFrame:
        sql = "select * from public.ml_price_history where shop_domain = %s"
        params: list[object] = [shop_domain]
        if rollout_id is not None:
            sql += " and rollout_id = %s"
            params.append(rollout_id)
        rows = self._query(sql + " order by variant_gid, applied_at", params)
        if not rows:
            return pd.DataFrame(
                columns=[
                    "variant_gid", "applied_at", "before_price_cents", "after_price_cents",
                    "source", "rollout_id", "stage_index",
                ]
            )
        frame = pd.DataFrame(rows)
        frame["applied_at"] = pd.to_datetime(frame["applied_at"], format="mixed", utc=True)
        return frame

    def products(self, shop_domain: str) -> pd.DataFrame:
        rows = self._query(
            "select * from public.ml_products where shop_domain = %s order by variant_gid",
            [shop_domain],
        )
        return pd.DataFrame(rows) if rows else pd.DataFrame(columns=["variant_gid", "cogs_cents", "price_cents"])

    def order_days(self, shop_domain: str) -> pd.DataFrame:
        rows = self._query(
            """
            select shop_domain, variant_gid, day, units, list_price_cents,
                   net_revenue_cents, on_promo, had_stockout
              from public.ml_product_days
             where shop_domain = %s
             order by variant_gid, day
            """,
            [shop_domain],
        )
        if not rows:
            return pd.DataFrame(columns=CANONICAL_COLUMNS)
        df = pd.DataFrame(rows).rename(columns=self.VIEW_COLUMN_MAP)
        df["date"] = pd.to_datetime(df["date"])
        for col, default in (("promo", False), ("stockout", False)):
            if col not in df.columns:
                df[col] = default
            df[col] = df[col].fillna(default)
        # price_cents (list_price_cents) is genuinely nullable (e.g. an
        # orders/create webhook for a not-yet-synced variant). Do NOT fill
        # with 0 — a zero price poisons log-price regressors; leave NaN for
        # densify_daily's ffill/bfill to repair from neighboring days.
        if "price_cents" not in df.columns:
            df["price_cents"] = np.nan
        return densify_daily(df[CANONICAL_COLUMNS])
