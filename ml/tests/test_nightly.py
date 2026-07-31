"""C7 nightly loop: the gate must reject a deliberately-degraded model and
raise the alarm on snapshot drift (the sprint's acceptance criterion)."""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import nightly  # noqa: E402


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


def test_c1_incumbent_bar_is_drift_checked():
    """The C1 incumbents ARE the R28 bar. If they drift, every challenger
    verdict was measured against a moved goalpost — so the nightly checks the
    bar itself, not only the challengers."""
    assert any(c[1] == "c1_incumbents.json" for c in nightly.CHECKS)
    snap = json.loads((pathlib.Path(nightly.HERE) / "eval" / "c1_incumbents.json").read_text())["incumbents"]
    check = ("incumbents-c1", "c1_incumbents.json", lambda: {"incumbents": snap},
             nightly._incumbent_bands_stay_calibrated, "incumbents")
    rows, ok = nightly.run_gates([check])
    assert ok and rows[0]["gate_passed"] and rows[0]["drift_free"]


def test_decalibrated_incumbent_band_fails_the_gate():
    """R29: an incumbent whose 80% band covers 97% of days is not a bar, it is
    a rubber stamp — auto-rollback would never fire behind it."""
    snap = json.loads((pathlib.Path(nightly.HERE) / "eval" / "c1_incumbents.json").read_text())["incumbents"]
    bad = json.loads(json.dumps(snap))
    bad["bracket_band_backtest"]["pooled_coverage_80"] = 0.97
    check = ("incumbents-c1", "c1_incumbents.json", lambda: {"incumbents": bad},
             nightly._incumbent_bands_stay_calibrated, "incumbents")
    rows, ok = nightly.run_gates([check])
    assert not ok
    assert not rows[0]["gate_passed"] and not rows[0]["drift_free"]


def test_recorded_loser_stays_recorded():
    """The C4 challenger must keep LOSING (verdict 'incumbent stays') — if it
    silently started winning, that's also a drift alarm, handled by the same
    machinery."""
    snap = json.loads((pathlib.Path(nightly.HERE) / "eval" / "c4_hier.json").read_text())["summary"]
    checks = [("x (recorded loser)", "c4_hier.json", lambda: {"summary": snap}, lambda s: s["verdict"] == "incumbent stays")]
    rows, ok = nightly.run_gates(checks)
    assert ok
    assert rows[0]["status"] == "rejected"


# --- C9: the real-data refit leg and its write path -------------------------


class _FakeSource:
    """Stands in for SupabaseSource: golden data served as if it were a shop."""

    def __init__(self, shops, orders_by_shop, windows=None, history=None, products=None):
        import pandas as pd

        self._shops = shops
        self._orders = orders_by_shop
        self._windows = pd.DataFrame() if windows is None else windows
        self._history = pd.DataFrame() if history is None else history
        self._products = pd.DataFrame() if products is None else products

    def list_shops(self):
        return list(self._shops)

    def order_days(self, shop_domain):
        return self._orders[shop_domain]

    def rollout_windows(self, shop_domain, status=None):
        import pandas as pd

        if len(self._windows) == 0 or status is None:
            return self._windows
        return pd.DataFrame(self._windows[self._windows["status"] == status])

    def price_history(self, shop_domain, rollout_id=None):
        return self._history

    def products(self, shop_domain):
        return self._products


class _FakeIngest:
    """Records every post_run call and returns a scripted result."""

    def __init__(self, result=None):
        self.calls = []
        self._result = result

    def post_run(self, **kwargs):
        self.calls.append(kwargs)
        if self._result is not None:
            return self._result
        from priceflag_ml.ingest import IngestResult

        rows = len(kwargs.get("fits") or []) + len(kwargs.get("bands") or [])
        return IngestResult(accepted=True, status_code=200, model_run_id="run", rows_written=rows)


def _wire(monkeypatch, tmp_path, source, ingest, shops=("s1.myshopify.com",)):
    import priceflag_ml.data as data_mod
    import priceflag_ml.ingest as ingest_mod

    monkeypatch.setattr(data_mod.SupabaseSource, "from_env", classmethod(lambda cls: source))
    monkeypatch.setattr(ingest_mod.IngestClient, "from_env_or_none", classmethod(lambda cls, client=None: ingest))
    return tmp_path


def _golden_shop(shop="s1.myshopify.com", n_skus=3, days=120):
    from priceflag_ml.data import load_golden
    from priceflag_ml.golden import GoldenConfig

    df = load_golden(GoldenConfig(n_skus=n_skus, days=days, seed=5))
    df = df.copy()
    df["shop_id"] = shop
    return df


def test_refit_posts_fits_and_bands_per_kind(monkeypatch, tmp_path):
    """One request per kind: the endpoint records one model_run per request,
    so mixing surfaces would make the registry unable to say what deployed."""
    shop = "s1.myshopify.com"
    source = _FakeSource([shop], {shop: _golden_shop(shop)})
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    ok = nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={})
    assert ok
    kinds = [c["kind"] for c in ingest.calls]
    assert kinds == ["elasticity", "baseline"]
    elastic, baseline = ingest.calls
    assert elastic["fits"] and not elastic["bands"]
    assert baseline["bands"] and not baseline["fits"]
    assert all(c["gate_passed"] is True for c in ingest.calls)
    assert all(c["shop_domain"] == shop for c in ingest.calls)
    # Artifacts are written whether or not a post happened.
    assert json.loads((tmp_path / "elasticity_fits.json").read_text())
    assert json.loads((tmp_path / "expected_bands.json").read_text())


def test_a_red_harness_cannot_deploy_a_model(monkeypatch, tmp_path):
    """The safety property of this sprint. If any golden gate failed, the run
    is still RECORDED (R28 wants failed challengers visible) but carries no
    rows — so a nightly that is red about model quality cannot write."""
    shop = "s1.myshopify.com"
    source = _FakeSource([shop], {shop: _golden_shop(shop)})
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    nightly.refit_real_stores(tmp_path, gates_ok=False, gate_metrics={})
    assert ingest.calls, "a failed run must still be recorded, not silently skipped"
    assert all(call["gate_passed"] is False for call in ingest.calls)

    # gate_passed=False is what makes the rows undeployable, and it is enforced
    # twice below this line: IngestClient.post_run drops them before sending
    # (test_ingest.py), and the endpoint discards them if it ever sees them
    # (R28). Prove the first link here rather than trusting the fake — the fake
    # is the one participant that does neither.
    import httpx

    from priceflag_ml.ingest import IngestClient

    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"accepted": False, "reason": "gate_not_passed", "rows_written": 0})

    real = IngestClient("https://app.example.com", "s3cret",
                        client=httpx.Client(transport=httpx.MockTransport(handler)))
    losing = ingest.calls[0]
    real.post_run(**{**losing, "fits": losing["fits"] or [{"variant_gid": "x"}]})
    assert sent[0]["fits"] == [] and sent[0]["bands"] == []


def test_shop_with_no_history_is_not_a_failure(monkeypatch, tmp_path):
    import pandas as pd
    from priceflag_ml.data import CANONICAL_COLUMNS

    shop = "empty.myshopify.com"
    source = _FakeSource([shop], {shop: pd.DataFrame(columns=CANONICAL_COLUMNS)})
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    assert nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={}) is True
    assert ingest.calls == []
    assert json.loads((tmp_path / "expected_bands.json").read_text()) == []


def test_a_refused_post_turns_the_nightly_red(monkeypatch, tmp_path):
    from priceflag_ml.ingest import IngestResult

    shop = "s1.myshopify.com"
    source = _FakeSource([shop], {shop: _golden_shop(shop)})
    refused = IngestResult(accepted=False, status_code=422, reason="contract_validation_failed",
                           problems=[{"path": "bands[0].low", "message": "low > expected_units"}])
    ingest = _FakeIngest(result=refused)
    _wire(monkeypatch, tmp_path, source, ingest)

    assert nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={}) is False


def test_bands_carry_the_full_horizon_and_are_ordered(monkeypatch, tmp_path):
    shop = "s1.myshopify.com"
    source = _FakeSource([shop], {shop: _golden_shop(shop, n_skus=2)})
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={})
    bands = json.loads((tmp_path / "expected_bands.json").read_text())
    assert len(bands) == 2 * nightly.BAND_HORIZON_DAYS
    for row in bands:
        assert row["low"] <= row["expected_units"] <= row["high"]
        assert row["band_kind"] == "baseline"


# --- C11 / D-17: the report leg --------------------------------------------


def _completed_rollout(orders, rollout_id="8f2b1c66-1f7e-4a4e-9c1f-2b3d4e5f6a7b"):
    """A completed rollout over the last 10 days of `orders`, with the journal
    entries that recorded its price writes."""
    import pandas as pd

    skus = sorted(orders["sku"].unique())[:2]
    end = orders["date"].max()
    start = end - pd.Timedelta(days=9)
    windows = pd.DataFrame([{
        "shop_domain": "s1.myshopify.com", "rollout_id": rollout_id, "status": "completed",
        "start_day": start, "end_day": end, "variant_gids": list(skus),
    }])
    history = pd.DataFrame([
        {"variant_gid": sku, "applied_at": pd.Timestamp(start, tz="UTC"),
         "before_price_cents": 2000, "after_price_cents": 2200,
         "source": "rollout", "rollout_id": rollout_id}
        for sku in skus
    ])
    products = pd.DataFrame([{"variant_gid": sku, "cogs_cents": 800} for sku in skus])
    return windows, history, products


def test_reports_are_built_and_posted_for_completed_rollouts(monkeypatch, tmp_path):
    shop = "s1.myshopify.com"
    orders = _golden_shop(shop)
    windows, history, products = _completed_rollout(orders)
    source = _FakeSource([shop], {shop: orders}, windows, history, products)
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={})
    assert "report" in [c["kind"] for c in ingest.calls]
    report_call = next(c for c in ingest.calls if c["kind"] == "report")
    assert len(report_call["reports"]) == 1
    written = json.loads((tmp_path / "rollout_reports.json").read_text())
    assert len(written) == 1
    # R30: the honesty metric is computed and kept, flattering or not.
    summary = json.loads((tmp_path / "calibration_summary.json").read_text())
    assert summary["n_rollouts"] == 1 and summary["pct_in_range"] in (0.0, 1.0)


def test_reports_reach_artifacts_even_with_no_endpoint_configured(monkeypatch, tmp_path):
    """Artifact-only mode must still produce the reports — otherwise the one
    output D-17 says is missing would be missing for a different reason."""
    shop = "s1.myshopify.com"
    orders = _golden_shop(shop)
    windows, history, products = _completed_rollout(orders)
    source = _FakeSource([shop], {shop: orders}, windows, history, products)
    _wire(monkeypatch, tmp_path, source, None)

    assert nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={}) is True
    assert len(json.loads((tmp_path / "rollout_reports.json").read_text())) == 1


def test_an_endpoint_that_drops_reports_turns_the_nightly_red(monkeypatch, tmp_path):
    """D-17's failure shape: 200 accepted, rows silently gone, R30 reading as
    shipped while rollout_reports stays empty."""
    from priceflag_ml.ingest import IngestResult

    shop = "s1.myshopify.com"
    orders = _golden_shop(shop)
    windows, history, products = _completed_rollout(orders)
    source = _FakeSource([shop], {shop: orders}, windows, history, products)
    dropped = IngestResult(accepted=True, status_code=200, rows_written=0,
                           dropped="sent 1 report(s), no `reports_written`")
    ingest = _FakeIngest(result=dropped)
    _wire(monkeypatch, tmp_path, source, ingest)

    assert nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={}) is False


def test_a_rollout_with_no_journal_entries_is_skipped_not_reported_thinly(monkeypatch, tmp_path):
    import pandas as pd

    shop = "s1.myshopify.com"
    orders = _golden_shop(shop)
    windows, _, products = _completed_rollout(orders)
    source = _FakeSource([shop], {shop: orders}, windows, pd.DataFrame(), products)
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    assert nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={}) is True
    assert "report" not in [c["kind"] for c in ingest.calls]
    assert json.loads((tmp_path / "rollout_reports.json").read_text()) == []


def test_no_completed_rollouts_means_no_report_run(monkeypatch, tmp_path):
    shop = "s1.myshopify.com"
    source = _FakeSource([shop], {shop: _golden_shop(shop)})
    ingest = _FakeIngest()
    _wire(monkeypatch, tmp_path, source, ingest)

    nightly.refit_real_stores(tmp_path, gates_ok=True, gate_metrics={})
    assert "report" not in [c["kind"] for c in ingest.calls]
