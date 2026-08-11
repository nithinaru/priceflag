"""C7 nightly loop: the gate must reject a deliberately-degraded model and
raise the alarm on snapshot drift (the sprint's acceptance criterion)."""

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import nightly  # noqa: E402
from priceflag_ml.data import SourceIdentity  # noqa: E402
from verify_nightly_evidence import EXPECTED_FIELDS, verify  # noqa: E402


PROJECT_REF = "abcdefghijklmnopqrst"
COMMIT_SHA = "a" * 40


def _set_real_attestation_env(monkeypatch):
    monkeypatch.setenv("GITHUB_SHA", COMMIT_SHA)
    monkeypatch.setenv("PRICEFLAG_ML_EXPECTED_PROJECT_REF", PROJECT_REF)
    monkeypatch.setenv("PRICEFLAG_ML_EXPECTED_ENVIRONMENT", "production")


def _identity():
    return SourceIdentity(PROJECT_REF, "production", "priceflag-ml-export")


def _c3_snapshot():
    return json.loads((pathlib.Path(nightly.HERE) / "eval" / "c3_baseline.json").read_text())["summary"]


def test_approx_equal_handles_nested():
    a = {"x": 1.0, "y": [1, 2, {"z": 0.5}]}
    b = {"x": 1.0 + 1e-12, "y": [1, 2, {"z": 0.5}]}
    assert nightly._approx_equal(a, b)
    assert not nightly._approx_equal(a, {"x": 1.1, "y": [1, 2, {"z": 0.5}]})


def test_healthy_champion_passes():
    snap = _c3_snapshot()
    checks = [("stub", "c3_baseline.json", lambda: {"summary": snap}, lambda s: s["verdict"] == "challenger wins")]
    rows, ok = nightly.run_gates(checks)
    assert ok
    assert rows[0]["gate_passed"] and rows[0]["drift_free"]
    assert rows[0]["status"] == "champion"


def test_degraded_model_is_rejected_by_the_gate():
    """C7 acceptance: a deliberately-degraded model must fail the gate."""
    degraded = dict(_c3_snapshot())
    degraded["verdict"] = "incumbent stays"  # what run_c3 returns when a change breaks the win
    degraded["win_rate_vs_bracket_band"] = 0.2
    checks = [("stub", "c3_baseline.json", lambda: {"summary": degraded}, lambda s: s["verdict"] == "challenger wins")]
    rows, ok = nightly.run_gates(checks)
    assert not ok
    assert rows[0]["status"] == "failed"
    assert not rows[0]["gate_passed"]


def test_silent_drift_is_detected_even_when_gate_passes():
    """A model that still wins but produces DIFFERENT numbers than the
    committed snapshot means code/deps changed behavior silently — alarm."""
    drifted = dict(_c3_snapshot())
    drifted["median_wape"] = drifted["median_wape"] + 0.01  # still winning, but different
    checks = [("stub", "c3_baseline.json", lambda: {"summary": drifted}, lambda s: s["verdict"] == "challenger wins")]
    rows, ok = nightly.run_gates(checks)
    assert not ok
    assert rows[0]["gate_passed"] and not rows[0]["drift_free"]
    assert rows[0]["status"] == "failed"


def test_recorded_loser_stays_recorded():
    """The C4 challenger must keep LOSING (verdict 'incumbent stays') — if it
    silently started winning, that's also a drift alarm, handled by the same
    machinery."""
    snap = json.loads((pathlib.Path(nightly.HERE) / "eval" / "c4_hier.json").read_text())["summary"]
    checks = [("x (recorded loser)", "c4_hier.json", lambda: {"summary": snap}, lambda s: s["verdict"] == "incumbent stays")]
    rows, ok = nightly.run_gates(checks)
    assert ok
    assert rows[0]["status"] == "rejected"


def test_c1_incumbent_safety_bar_is_part_of_every_nightly():
    assert any(check[1] == "c1_incumbents.json" for check in nightly.CHECKS)


def test_required_real_ingest_rejects_zero_visible_shops(monkeypatch, tmp_path):
    import priceflag_ml.data as data_module
    import priceflag_ml.ingest as ingest_module

    class EmptySource:
        def attest(self, *_args):
            return _identity()

        def list_shops(self):
            return []

    class ConfiguredIngest:
        pass

    monkeypatch.setattr(data_module.PriceflagApiSource, "from_env", classmethod(lambda cls: EmptySource()))
    monkeypatch.setattr(
        ingest_module.IngestClient,
        "from_env_or_none",
        classmethod(lambda cls, client=None: ConfiguredIngest()),
    )
    _set_real_attestation_env(monkeypatch)
    assert nightly.refit_real_stores(tmp_path, True, {}, require_ingest=True) is False
    evidence = json.loads((tmp_path / nightly.REAL_INGEST_EVIDENCE_FILE).read_text())
    assert evidence["failure_code"] == "zero_visible_shops"
    assert evidence["shops_visible"] == 0


def test_required_real_ingest_rejects_a_shop_with_no_acknowledged_rows(monkeypatch, tmp_path):
    import pandas as pd

    import priceflag_ml.data as data_module
    import priceflag_ml.ingest as ingest_module
    from priceflag_ml.data import CANONICAL_COLUMNS

    class EmptyHistorySource:
        def attest(self, *_args):
            return _identity()

        def list_shops(self):
            return ["empty.myshopify.com"]

        def order_days(self, _shop):
            return pd.DataFrame(columns=CANONICAL_COLUMNS)

    class ConfiguredIngest:
        pass

    monkeypatch.setattr(data_module.PriceflagApiSource, "from_env", classmethod(lambda cls: EmptyHistorySource()))
    monkeypatch.setattr(
        ingest_module.IngestClient,
        "from_env_or_none",
        classmethod(lambda cls, client=None: ConfiguredIngest()),
    )
    _set_real_attestation_env(monkeypatch)
    assert nightly.refit_real_stores(tmp_path, True, {}, require_ingest=True) is False
    evidence = json.loads((tmp_path / nightly.REAL_INGEST_EVIDENCE_FILE).read_text())
    assert evidence["failure_code"] == "zero_acknowledged_rows"
    assert evidence["shops_visible"] == 1
    assert evidence["shops_with_orders"] == 0


def _valid_real_evidence():
    return {
        "schema_version": 1,
        "source_transport": "https",
        "source_authority": "priceflag-ml-export",
        "project_ref": PROJECT_REF,
        "environment": "production",
        "required_real_ingest": True,
        "shops_visible": 2,
        "shops_with_orders": 1,
        "fits_generated": 3,
        "bands_generated": 42,
        "reports_generated": 0,
        "rows_acknowledged": 45,
        "runs_verified": 2,
        "success": True,
        "failure_code": None,
        "generated_at": "2026-08-04T17:00:00Z",
        "github_sha": COMMIT_SHA,
    }


def test_real_ingest_evidence_verifier_accepts_redacted_positive_proof():
    evidence = _valid_real_evidence()
    assert set(evidence) == EXPECTED_FIELDS
    verify(evidence, COMMIT_SHA, PROJECT_REF, "production")


def test_real_ingest_evidence_verifier_rejects_golden_or_unacknowledged_runs():
    evidence = _valid_real_evidence()
    evidence["required_real_ingest"] = False
    with pytest.raises(ValueError, match="real-ingest requirement"):
        verify(evidence, COMMIT_SHA, PROJECT_REF, "production")
    evidence = _valid_real_evidence()
    evidence["rows_acknowledged"] = 0
    with pytest.raises(ValueError, match="rows_acknowledged"):
        verify(evidence, COMMIT_SHA, PROJECT_REF, "production")


def test_real_ingest_evidence_rejects_commit_mismatch_and_merchant_identifiers():
    with pytest.raises(ValueError, match="different commit"):
        verify(_valid_real_evidence(), "b" * 40, PROJECT_REF, "production")
    evidence = _valid_real_evidence() | {"shop_domain": "must-not-leak.myshopify.com"}
    with pytest.raises(ValueError, match="redaction allowlist"):
        verify(evidence, COMMIT_SHA, PROJECT_REF, "production")
    with pytest.raises(ValueError, match="forbidden fields"):
        nightly._write_real_ingest_evidence(pathlib.Path("."), evidence)


@pytest.mark.parametrize("readback_ok", [True, False])
def test_real_refit_requires_receipt_readback_and_emits_redacted_evidence(monkeypatch, tmp_path, readback_ok):
    import pandas as pd

    import priceflag_ml.data as data_module
    import priceflag_ml.elasticity as elasticity_module
    import priceflag_ml.forecaster as forecaster_module
    import priceflag_ml.ingest as ingest_module
    import priceflag_ml.reports as reports_module

    class Source:
        closed = False

        def attest(self, *_args):
            return _identity()

        def list_shops(self):
            return ["private-merchant.myshopify.com"]

        def order_days(self, _shop):
            return pd.DataFrame(
                {
                    "shop_id": ["private-merchant.myshopify.com"],
                    "sku": ["gid://shopify/ProductVariant/1"],
                    "date": pd.to_datetime(["2026-08-01"]),
                    "units": [2],
                    "price_cents": [1500],
                    "revenue_cents": [3000],
                    "promo": [False],
                    "stockout": [False],
                }
            )

        def close(self):
            self.closed = True

        def verify_ingest_receipts(self, receipts, sha):
            assert sha == COMMIT_SHA
            assert len(receipts) == 2
            assert all(receipt[0] == "private-merchant.myshopify.com" for receipt in receipts)
            if not readback_ok:
                raise RuntimeError("test-only readback failure")
            return len(receipts)

    class Result:
        accepted = True
        rows_written = 1
        is_error = False

        def __init__(self, model_run_id):
            self.model_run_id = model_run_id

        def describe(self):
            return "accepted"

    class Ingest:
        calls = 0

        def post_run(self, **_kwargs):
            self.calls += 1
            return Result(f"00000000-0000-4000-8000-{self.calls:012d}")

    source = Source()
    monkeypatch.setattr(data_module.PriceflagApiSource, "from_env", classmethod(lambda cls: source))
    monkeypatch.setattr(
        ingest_module.IngestClient,
        "from_env_or_none",
        classmethod(lambda cls, client=None: Ingest()),
    )
    monkeypatch.setattr(elasticity_module, "fit_store", lambda _orders: [object()])
    monkeypatch.setattr(elasticity_module, "fits_contract_rows", lambda *_args, **_kwargs: [{"fit": 1}])
    monkeypatch.setattr(nightly, "_forecast_one", lambda *_args: object())
    monkeypatch.setattr(forecaster_module, "bands_contract_rows", lambda *_args, **_kwargs: [{"band": 1}])
    monkeypatch.setattr(nightly, "_reports_for_shop", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(reports_module, "calibration_summary", lambda _reports: {"n": 0})
    _set_real_attestation_env(monkeypatch)

    assert nightly.refit_real_stores(tmp_path, True, {}, require_ingest=True) is readback_ok
    evidence = json.loads((tmp_path / nightly.REAL_INGEST_EVIDENCE_FILE).read_text())
    if readback_ok:
        verify(evidence, COMMIT_SHA, PROJECT_REF, "production")
        assert evidence["runs_verified"] == 2
    else:
        assert evidence["success"] is False
        assert evidence["failure_code"] == "ingest_readback_failed"
        assert evidence["runs_verified"] == 0
    assert source.closed is True
    assert "private-merchant.myshopify.com" not in json.dumps(evidence)


def test_partial_attestation_or_target_configuration_fails_closed(monkeypatch, tmp_path):
    keys = (
        "PRICEFLAG_ML_EXPECTED_PROJECT_REF",
        "PRICEFLAG_ML_EXPECTED_ENVIRONMENT",
        "PRICEFLAG_APP_URL",
        "APP_URL",
        "ML_INGEST_SECRET",
        "PRICEFLAG_EXPECTED_APP_URL",
        "PRICEFLAG_EXPECTED_VERCEL_TARGET",
        "VERCEL_TOKEN",
        "REQUIRE_REAL_INGEST",
    )
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(nightly, "HERE", tmp_path)
    monkeypatch.setattr(nightly, "run_gates", lambda: ([], True))
    monkeypatch.setenv("VERCEL_TOKEN", "configured-alone")
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    stale_evidence = out_dir / nightly.REAL_INGEST_EVIDENCE_FILE
    stale_evidence.write_text(json.dumps(_valid_real_evidence()))
    assert nightly.main() == 1
    assert not stale_evidence.exists()
