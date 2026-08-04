"""Data access: golden loader shape, densification, and the direct read-only
Supabase PostgreSQL source against an injected query seam — no live network."""

import numpy as np
import pandas as pd
import pytest

from priceflag_ml.data import CANONICAL_COLUMNS, SourceIdentity, SupabaseSource, densify_daily, load_golden
from priceflag_ml.golden import GoldenConfig


def test_load_golden_canonical_shape():
    df = load_golden(GoldenConfig(n_skus=4, days=60, seed=2))
    assert list(df.columns) == CANONICAL_COLUMNS
    assert len(df) == 4 * 60


def test_supabase_source_requires_credentials():
    with pytest.raises(ValueError, match="PostgreSQL connection URL"):
        SupabaseSource("")
    with pytest.raises(ValueError, match="read-only role password"):
        SupabaseSource("postgresql://priceflag_ml_readonly@db.example/postgres")
    with pytest.raises(ValueError, match="priceflag_ml_readonly"):
        SupabaseSource("postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co/postgres?sslmode=verify-full&sslrootcert=system")
    with pytest.raises(ValueError, match="Supabase database host"):
        SupabaseSource("postgresql://priceflag_ml_readonly:secret@db.example/postgres?sslmode=verify-full&sslrootcert=system")
    with pytest.raises(ValueError, match="sslmode=verify-full"):
        SupabaseSource("postgresql://priceflag_ml_readonly:secret@db.abcdefghijklmnopqrst.supabase.co/postgres")
    with pytest.raises(ValueError, match="sslrootcert=system"):
        SupabaseSource(
            "postgresql://priceflag_ml_readonly:secret@db.abcdefghijklmnopqrst.supabase.co/postgres?sslmode=verify-full"
        )
    with pytest.raises(ValueError, match="postgres database"):
        SupabaseSource(
            "postgresql://priceflag_ml_readonly:secret@db.abcdefghijklmnopqrst.supabase.co/other?sslmode=verify-full&sslrootcert=system"
        )
    with pytest.raises(ValueError, match="standard Supabase"):
        SupabaseSource(
            "postgresql://priceflag_ml_readonly:secret@db.abcdefghijklmnopqrst.supabase.co:9999/postgres?sslmode=verify-full&sslrootcert=system"
        )
    with pytest.raises(ValueError, match="only the required TLS parameters"):
        SupabaseSource(
            "postgresql://priceflag_ml_readonly:secret@db.abcdefghijklmnopqrst.supabase.co/postgres?sslmode=verify-full&sslrootcert=system&application_name=attacker"
        )


def test_supabase_from_env_message_without_keys(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_ML_READONLY_KEY", raising=False)
    with pytest.raises(RuntimeError, match="load_golden"):
        SupabaseSource.from_env()


def test_supabase_from_env_requires_database_and_api_project_to_match(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co")
    monkeypatch.setenv(
        "SUPABASE_ML_READONLY_KEY",
        "postgresql://priceflag_ml_readonly.zyxwvutsrqponmlkjihg:secret@pooler.supabase.com/postgres?sslmode=verify-full&sslrootcert=system",
    )
    with pytest.raises(RuntimeError, match="does not identify"):
        SupabaseSource.from_env()

    monkeypatch.setenv(
        "SUPABASE_ML_READONLY_KEY",
        "postgresql://priceflag_ml_readonly:secret@abcdefghijklmnopqrst.other.supabase.co/postgres?sslmode=verify-full&sslrootcert=system",
    )
    with pytest.raises(RuntimeError, match="does not identify"):
        SupabaseSource.from_env()

    monkeypatch.setenv(
        "SUPABASE_ML_READONLY_KEY",
        "postgresql://priceflag_ml_readonly.abcdefghijklmnopqrst:secret@db.zyxwvutsrqponmlkjihg.supabase.co/postgres?sslmode=verify-full&sslrootcert=system",
    )
    with pytest.raises(RuntimeError, match="does not identify"):
        SupabaseSource.from_env()

    monkeypatch.setenv(
        "SUPABASE_ML_READONLY_KEY",
        "postgresql://priceflag_ml_readonly.abcdefghijklmnopqrst:secret@pooler.supabase.com/postgres?sslmode=verify-full&sslrootcert=system",
    )
    source = SupabaseSource.from_env()
    source.close()

    monkeypatch.setenv(
        "SUPABASE_ML_READONLY_KEY",
        "postgresql://priceflag_ml_readonly:secret@db.abcdefghijklmnopqrst.supabase.co/postgres?sslmode=verify-full&sslrootcert=system",
    )
    source = SupabaseSource.from_env()
    source.close()


def test_densify_daily_fills_missing_days():
    df = pd.DataFrame(
        {
            "shop_id": "s1",
            "sku": "A",
            "date": pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-05"]),  # 2 missing days
            "units": [3, 2, 4],
            "price_cents": [5000, 5000, 4500],
            "revenue_cents": [15000, 10000, 18000],
            "promo": [False, False, True],
            "stockout": [False, False, False],
        }
    )
    out = densify_daily(df)
    assert len(out) == 5
    assert pd.DatetimeIndex(out["date"]).is_monotonic_increasing
    filled = out[out["date"].isin(pd.to_datetime(["2026-01-03", "2026-01-04"]))]
    assert (filled["units"] == 0).all()
    assert (filled["revenue_cents"] == 0).all()
    assert (~filled["promo"]).all() and (~filled["stockout"]).all()
    assert (filled["price_cents"] == 5000).all()  # forward-filled posted price


def test_densify_daily_noop_on_contiguous():
    df = load_golden(GoldenConfig(n_skus=2, days=30, seed=3))
    out = densify_daily(df)
    assert len(out) == len(df)


def _mock_source(rows: list[dict]) -> tuple[SupabaseSource, list[tuple[str, list[object]]]]:
    seen: list[tuple[str, list[object]]] = []

    def query(sql, params):
        seen.append((sql, list(params)))
        return rows

    return (
        SupabaseSource(
            "postgresql://priceflag_ml_readonly.abcdefghijklmnopqrst:secret@pooler.supabase.com/postgres?sslmode=verify-full&sslrootcert=system",
            query=query,
        ),
        seen,
    )


def _view_row(day, units, gid="gid://shopify/ProductVariant/1", **extra):
    row = {
        "shop_domain": "s1.myshopify.com",
        "variant_gid": gid,
        "day": day,
        "units": units,
        "net_revenue_cents": units * 5000,
        "list_price_cents": 5000,
        "on_promo": False,
        "had_stockout": False,
    }
    row.update(extra)
    return row


def test_supabase_order_days_reads_every_database_row_in_one_parameterized_query():
    dates = pd.date_range("2026-01-01", periods=7, freq="D")
    rows = [_view_row(str(d.date()), i + 1) for i, d in enumerate(dates)]
    src, seen = _mock_source(rows)
    out = src.order_days("s1.myshopify.com")
    assert len(out) == 7
    assert len(seen) == 1
    assert "from public.ml_product_days" in seen[0][0]
    assert seen[0][1] == ["s1.myshopify.com"]
    assert out["units"].tolist() == [1, 2, 3, 4, 5, 6, 7]
    assert (out["sku"] == "gid://shopify/ProductVariant/1").all()
    assert (out["price_cents"] == 5000).all()


def test_supabase_order_days_maps_view_columns_and_densifies():
    rows = [
        _view_row("2026-01-01", 2, on_promo=True),
        _view_row("2026-01-03", 1, had_stockout=True),
    ]
    src, _ = _mock_source(rows)
    out = src.order_days("s1.myshopify.com")
    assert list(out.columns) == CANONICAL_COLUMNS
    assert len(out) == 3  # missing day densified
    assert out["promo"].tolist() == [True, False, False]
    assert out["stockout"].tolist() == [False, False, True]
    assert np.issubdtype(out["date"].dtype, np.datetime64)
    assert out["revenue_cents"].tolist() == [10000, 0, 5000]


def test_supabase_order_days_empty_result():
    src, _ = _mock_source([])
    out = src.order_days("nope")
    assert out.empty
    assert list(out.columns) == CANONICAL_COLUMNS


def test_list_shops_deduplicates_and_uses_the_read_only_view():
    source, seen = _mock_source(
        [
            {"shop_domain": "a.myshopify.com"},
            {"shop_domain": "a.myshopify.com"},
            {"shop_domain": "b.myshopify.com"},
        ],
    )
    assert source.list_shops() == ["a.myshopify.com", "b.myshopify.com"]
    assert len(seen) == 1
    assert "from public.ml_products" in seen[0][0]


def test_shop_filters_are_parameters_not_interpolated_into_sql():
    source, seen = _mock_source([])
    attacker = "x' OR true --.myshopify.com"
    source.products(attacker)
    assert attacker not in seen[0][0]
    assert seen[0][1] == [attacker]


def test_builtin_database_transport_forces_read_only_transactions(monkeypatch):
    import psycopg

    captured = {}

    class FakeCursor:
        calls = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, params=()):
            self.calls.append((sql, params))

        def fetchall(self):
            return []

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def close(self):
            captured["closed"] = True

    def connect(database_url, **kwargs):
        captured["database_url"] = database_url
        captured.update(kwargs)
        return FakeConnection()

    monkeypatch.setattr(psycopg, "connect", connect)
    database_url = (
        "postgresql://priceflag_ml_readonly.abcdefghijklmnopqrst:secret@"
        "pooler.supabase.com/postgres?sslmode=verify-full&sslrootcert=system"
    )
    source = SupabaseSource(database_url)
    assert source.list_shops() == []
    source.close()
    assert captured["database_url"] == database_url
    assert captured["autocommit"] is True
    assert captured["application_name"] == "priceflag-ml-nightly"
    assert captured["prepare_threshold"] is None
    assert FakeCursor.calls[0][0] == "begin read only"
    assert FakeCursor.calls[1][0] == "set local statement_timeout = '60s'"
    assert "from public.ml_products" in FakeCursor.calls[2][0]
    assert FakeCursor.calls[3][0] == "commit"
    assert captured["closed"] is True


def test_source_attestation_requires_exact_role_project_environment_and_sentinel():
    rows = [{
        "database_role": "priceflag_ml_readonly",
        "environment": "production",
        "project_ref": "abcdefghijklmnopqrst",
        "sentinel": "expected-sentinel",
        "can_login": True,
        "is_superuser": False,
        "can_create_database": False,
        "can_create_role": False,
        "inherits_roles": False,
        "can_replicate": False,
        "bypasses_rls": False,
        "connection_limit": 5,
        "role_memberships": 0,
        "can_create_public_objects": False,
        "creatable_schemas": 0,
        "can_read_shop_token": False,
        "writable_relations": 0,
        "accessible_sequences": 0,
        "executable_security_definers": 0,
        "unexpected_read_columns": 0,
    }]
    source, seen = _mock_source(rows)
    assert source.attest(
        "abcdefghijklmnopqrst",
        "production",
        "expected-sentinel",
    ) == SourceIdentity("abcdefghijklmnopqrst", "production", "priceflag_ml_readonly")
    assert "current_user" in seen[0][0]
    assert "pg_auth_members" in seen[0][0]
    assert "has_column_privilege" in seen[0][0]
    assert "has_function_privilege" in seen[0][0]

    for field, value, pattern in (
        ("database_role", "postgres", "dedicated read-only role"),
        ("environment", "staging", "environment marker"),
        ("project_ref", "zyxwvutsrqponmlkjihg", "project marker"),
        ("sentinel", "wrong", "sentinel"),
    ):
        bad = dict(rows[0])
        bad[field] = value
        bad_source, _ = _mock_source([bad])
        with pytest.raises(RuntimeError, match=pattern):
            bad_source.attest("abcdefghijklmnopqrst", "production", "expected-sentinel")

    for field in (
        "is_superuser",
        "can_create_database",
        "can_create_role",
        "inherits_roles",
        "can_replicate",
        "bypasses_rls",
        "can_create_public_objects",
        "can_read_shop_token",
    ):
        bad = dict(rows[0])
        bad[field] = True
        bad_source, _ = _mock_source([bad])
        with pytest.raises(RuntimeError, match="unsafe effective"):
            bad_source.attest("abcdefghijklmnopqrst", "production", "expected-sentinel")

    for field in (
        "role_memberships",
        "creatable_schemas",
        "writable_relations",
        "accessible_sequences",
        "executable_security_definers",
        "unexpected_read_columns",
    ):
        bad = dict(rows[0])
        bad[field] = 1
        bad_source, _ = _mock_source([bad])
        with pytest.raises(RuntimeError, match="outside the approved"):
            bad_source.attest("abcdefghijklmnopqrst", "production", "expected-sentinel")


def test_ingest_receipts_are_read_back_from_attested_database():
    run_id = "00000000-0000-4000-8000-000000000001"
    sha = "a" * 40
    source, seen = _mock_source([{
        "id": run_id,
        "git_sha": sha,
        "status": "succeeded",
        "rows_written": 3,
    }])
    assert source.verify_ingest_receipts([(run_id, 3)], sha) == 1
    assert "from public.model_runs" in seen[0][0]
    assert seen[0][1] == [[run_id]]


@pytest.mark.parametrize(
    "row",
    [
        None,
        {"id": "00000000-0000-4000-8000-000000000001", "git_sha": "b" * 40, "status": "succeeded", "rows_written": 3},
        {"id": "00000000-0000-4000-8000-000000000001", "git_sha": "a" * 40, "status": "failed", "rows_written": 3},
        {"id": "00000000-0000-4000-8000-000000000001", "git_sha": "a" * 40, "status": "succeeded", "rows_written": 2},
    ],
)
def test_ingest_receipt_readback_fails_closed(row):
    run_id = "00000000-0000-4000-8000-000000000001"
    source, _ = _mock_source([] if row is None else [row])
    with pytest.raises(RuntimeError):
        source.verify_ingest_receipts([(run_id, 3)], "a" * 40)
