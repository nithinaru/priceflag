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


def test_recorded_loser_stays_recorded():
    """The C4 challenger must keep LOSING (verdict 'incumbent stays') — if it
    silently started winning, that's also a drift alarm, handled by the same
    machinery."""
    snap = json.loads((pathlib.Path(nightly.HERE) / "eval" / "c4_hier.json").read_text())["summary"]
    checks = [("x (recorded loser)", "c4_hier.json", lambda: {"summary": snap}, lambda s: s["verdict"] == "incumbent stays")]
    rows, ok = nightly.run_gates(checks)
    assert ok
    assert rows[0]["status"] == "rejected"
