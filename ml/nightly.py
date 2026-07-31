"""C7: the nightly production loop.

    pull -> refit -> validate on the harness -> emit fits/bands/model_runs
    -> FAIL LOUDLY (never write worse-than-incumbent fits)

Run:  cd ml && uv run python nightly.py

Behavior by environment:

- **Always** (golden mode): re-run every champion's gate (C2 elasticity, C3
  bands, C5 monitor, C6 reports) and the drift check (current verdict
  summaries must match the committed `eval/*.json` snapshots exactly — the
  golden universe is deterministic, so ANY drift means code/dependency
  changes silently altered model behavior). Exit code 1 on any failure: a
  red nightly is the alarm, not a log line.

- **With `SUPABASE_URL` + `SUPABASE_ML_READONLY_KEY`** (once Lane B's B6
  lands): additionally pull every shop's `ml_product_days`, refit the
  champions on real data, and emit contract rows to `out/` as JSON artifacts
  (`elasticity_fits.json`, `expected_bands.json`, `model_runs.json`).
  Writing them INTO the tables needs a write-scoped key from Lane B
  (requested in contracts/requests-lane-c.md); until then the GitHub Action
  uploads the artifacts and Lane B can load them.

The model_runs rows record gate results for CHALLENGERS TOO — R28 wants
failed challengers recorded, not discarded (status='rejected').
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from priceflag_ml import harness  # noqa: E402


def _approx_equal(a, b, tol=1e-9) -> bool:
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= tol
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_approx_equal(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_approx_equal(x, y, tol) for x, y in zip(a, b))
    return a == b


CHECKS = [
    ("elasticity-poisson-eb-1.0", "c2_elasticity.json", harness.run_c2, lambda s: s["verdict"] == "challenger wins"),
    ("baseline-cleanlevel-1.0", "c3_baseline.json", harness.run_c3, lambda s: s["verdict"] == "challenger wins"),
    ("counterfactual-cleanlevel-1.0", "c5_counterfactual.json", harness.run_c5, lambda s: s["verdict"] == "challenger wins"),
    ("rollout-report-1.0", "c6_reports.json", harness.run_c6, lambda s: s["acceptance_met"]),
    ("elasticity-hier-em-1.0 (recorded loser)", "c4_hier.json", harness.run_c4, lambda s: s["verdict"] == "incumbent stays"),
]


def run_gates(checks=None) -> tuple[list[dict], bool]:
    """Every champion re-validated + drift-checked against its committed
    snapshot. Returns (model_run_rows, all_ok)."""
    rows, all_ok = [], True
    for name, snapshot_file, fn, passes in checks if checks is not None else CHECKS:
        current = fn()["summary"]
        snapshot = json.loads((HERE / "eval" / snapshot_file).read_text())["summary"]
        gate_ok = bool(passes(current))
        drift_ok = _approx_equal(current, snapshot)
        ok = gate_ok and drift_ok
        all_ok &= ok
        status = "champion" if gate_ok and "loser" not in name else ("rejected" if "loser" in name else "failed")
        if not ok:
            status = "failed"
        rows.append(
            {
                "model_version": name,
                "status": status,
                "gate_passed": gate_ok,
                "drift_free": drift_ok,
                "metrics": current,
            }
        )
        print(f"[{'ok' if ok else 'FAIL'}] {name}: gate={'pass' if gate_ok else 'FAIL'} drift={'none' if drift_ok else 'DETECTED'}")
        if not drift_ok:
            print(f"       snapshot {snapshot_file} no longer matches — a code/dep change altered model behavior.")
            print("       If intentional: regenerate the snapshot in the same commit. If not: that's the alarm firing.")
    return rows, all_ok


def refit_real_stores(out_dir: Path) -> None:
    """Real-data leg — runs only when read credentials exist (B6)."""
    from priceflag_ml.data import SupabaseSource  # noqa: PLC0415

    src = SupabaseSource.from_env()
    print("real-data refit: credentials found, but shop enumeration needs Lane B's")
    print("shops listing surface — recorded in contracts/requests-lane-c.md; skipping.")
    # Wire per-shop refit + gate here when ml_products/shops enumeration is
    # readable by the ML role (B6). The single-shop path is:
    #   orders = src.order_days(shop_domain)
    #   fits   = elasticity.fit_store(orders)  -> fits_contract_rows(...)
    #   bands  = forecaster.CleanLevelBaseline per SKU -> bands_contract_rows(...)
    # gated by run_c2/run_c3 style comparisons before anything is emitted.
    _ = src, out_dir


def main() -> int:
    out_dir = HERE / "out"
    out_dir.mkdir(exist_ok=True)
    rows, ok = run_gates()
    (out_dir / "model_runs.json").write_text(json.dumps(rows, indent=2, default=str))
    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_ML_READONLY_KEY"):
        refit_real_stores(out_dir)
    else:
        print("no Supabase credentials: golden-mode gates only (expected until B6).")
    print(f"nightly {'GREEN' if ok else 'RED'}; model_runs -> {out_dir / 'model_runs.json'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
