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

- **With `SUPABASE_URL` + `SUPABASE_ML_READONLY_KEY`** (Lane B's B6): pull
  every readable shop's `ml_product_days`, refit the champions on real data,
  and emit contract rows to `out/` as JSON artifacts.

- **Additionally with `PRICEFLAG_APP_URL` + `ML_INGEST_SECRET`** (C9): post
  those rows to Lane B's `POST /api/ml/ingest`, which holds the service role
  and does the writing. Lane C's own database role stays read-only. The
  golden-harness verdict is what the post carries as `gate_passed`, so a red
  harness records the run and stores nothing — a failing nightly cannot
  deploy a model.

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


# How far ahead the nightly writes baseline bands. The evaluator judges
# yesterday, so it only ever needs one; two weeks means a nightly that fails
# to run does not immediately leave the evaluator band-less (it falls back to
# Lane B's bracket math, which is safe but blunter).
BAND_HORIZON_DAYS = 14


def _utc_now_iso() -> str:
    from datetime import datetime, timezone  # noqa: PLC0415

    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _approx_equal(a, b, tol=1e-9) -> bool:
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= tol
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_approx_equal(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_approx_equal(x, y, tol) for x, y in zip(a, b))
    return a == b


def _incumbent_bands_stay_calibrated(inc: dict) -> bool:
    """The C1 bar's own safety property (R29). Every challenger is measured
    against these two incumbents, so if THEIR bands drift out of calibration
    the whole comparison is being made against a moved goalpost — and the
    fallback band (`BracketBand` is Lane B's shipped `lib/engine/bands.ts`) is
    what auto-rollback actually uses when no model band exists."""
    return all(
        0.70 <= inc[k]["pooled_coverage_80"] <= 0.90
        for k in ("seasonal_naive_backtest", "bracket_band_backtest")
    )


# (name, snapshot file, runner, gate, key selected from both current + snapshot)
CHECKS = [
    ("incumbents-c1", "c1_incumbents.json", harness.run_c1, _incumbent_bands_stay_calibrated, "incumbents"),
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
    for check in checks if checks is not None else CHECKS:
        name, snapshot_file, fn, passes = check[:4]
        key = check[4] if len(check) > 4 else "summary"
        current = fn()[key]
        snapshot = json.loads((HERE / "eval" / snapshot_file).read_text())[key]
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


def refit_real_stores(out_dir: Path, gates_ok: bool, gate_metrics: dict) -> bool:
    """Real-data leg — runs only when read credentials exist (B6).

    Refits every readable shop, writes the contract rows to `out/` as
    artifacts, and — when `ML_INGEST_SECRET` + `PRICEFLAG_APP_URL` are also
    configured — posts them to Lane B's `POST /api/ml/ingest`, which holds the
    service role and does the actual writing. Lane C never holds a write
    credential.

    `gates_ok` carries the golden-harness verdict into `model_run.gate_passed`.
    That coupling is the point of the sprint: the models being posted are the
    ones that just re-proved themselves against the incumbent on golden data
    this run. If any gate failed, every run is posted with `gate_passed=False`
    — recorded in the registry, rows discarded (R28). A red nightly must not be
    able to deploy anything.

    Returns True if nothing went wrong that should turn the nightly red. A shop
    that yields no rows is not a failure; a shop whose post was refused is.
    """
    from priceflag_ml import elasticity, forecaster  # noqa: PLC0415
    from priceflag_ml.data import SupabaseSource  # noqa: PLC0415
    from priceflag_ml.ingest import IngestClient  # noqa: PLC0415

    src = SupabaseSource.from_env()
    client = IngestClient.from_env_or_none()
    if client is None:
        print("real-data refit: no ML_INGEST_SECRET/PRICEFLAG_APP_URL — artifacts only, nothing posted.")

    shops = src.list_shops()
    print(f"real-data refit: {len(shops)} shop(s) readable.")
    generated_at = _utc_now_iso()
    all_fits: list[dict] = []
    all_bands: list[dict] = []
    ok = True

    for shop_domain in shops:
        orders = src.order_days(shop_domain)
        if orders.empty:
            print(f"  {shop_domain}: no order history readable — nothing to fit (not a failure).")
            continue

        fits = elasticity.fit_store(orders)
        window_start = str(orders["date"].min().date())
        window_end = str(orders["date"].max().date())
        fit_rows = elasticity.fits_contract_rows(
            fits, shop_domain=shop_domain, fitted_at=generated_at,
            window_start=window_start, window_end=window_end,
        )

        band_rows: list[dict] = []
        for sku, history in orders.groupby("sku", sort=True):
            forecast = _forecast_one(forecaster, history)
            if forecast is None:
                continue
            band_rows.extend(
                forecaster.bands_contract_rows(
                    forecast, shop_domain=shop_domain, variant_gid=str(sku), generated_at=generated_at
                )
            )

        all_fits.extend(fit_rows)
        all_bands.extend(band_rows)
        print(f"  {shop_domain}: {len(fit_rows)} fit(s), {len(band_rows)} band row(s) over {window_start}..{window_end}")

        if client is None:
            continue

        # One request per kind: the endpoint records one model_run per request,
        # and mixing an elasticity fit set with a band set into a single run
        # would make the registry unable to say which surface was deployed.
        for kind, version, incumbent, fit_payload, band_payload in (
            ("elasticity", elasticity.MODEL_VERSION, "bracket-elasticity", fit_rows, []),
            ("baseline", forecaster.MODEL_VERSION, "bracket-band", [], band_rows),
        ):
            if not fit_payload and not band_payload and gates_ok:
                continue
            result = client.post_run(
                shop_domain=shop_domain, kind=kind, model_version=version,
                gate_passed=gates_ok, incumbent_version=incumbent,
                metrics=gate_metrics.get(version, {}), fits=fit_payload, bands=band_payload,
                notes=f"nightly refit over {window_start}..{window_end}",
            )
            print(f"    -> {kind}: {result.describe()}")
            if result.is_error:
                ok = False

    (out_dir / "elasticity_fits.json").write_text(json.dumps(all_fits, indent=2, default=str))
    (out_dir / "expected_bands.json").write_text(json.dumps(all_bands, indent=2, default=str))
    return ok


def _forecast_one(forecaster, history):
    """One SKU's baseline bands, or None when its history cannot support them.

    A SKU that cannot be forecast honestly produces no band, and the evaluator
    falls back to Lane B's bracket band for it. That is the designed fallback —
    far better than emitting a wide band that looks like a measurement."""
    try:
        model = forecaster.CleanLevelBaseline().fit(history.sort_values("date"))
        return model.forecast(BAND_HORIZON_DAYS)
    except (ValueError, IndexError, KeyError) as exc:
        print(f"    (no band for {history['sku'].iloc[0]}: {exc})")
        return None


def main() -> int:
    out_dir = HERE / "out"
    out_dir.mkdir(exist_ok=True)
    rows, ok = run_gates()
    (out_dir / "model_runs.json").write_text(json.dumps(rows, indent=2, default=str))
    if os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_ML_READONLY_KEY"):
        metrics = {row["model_version"]: row["metrics"] for row in rows}
        # `ok` is passed as gate_passed: a red golden harness cannot deploy.
        ok &= refit_real_stores(out_dir, gates_ok=ok, gate_metrics=metrics)
    else:
        print("no Supabase credentials: golden-mode gates only.")
    print(f"nightly {'GREEN' if ok else 'RED'}; model_runs -> {out_dir / 'model_runs.json'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
