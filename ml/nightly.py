"""Nightly quality gates, real-store refits, completed-rollout reports and ingest."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from priceflag_ml import harness  # noqa: E402

BAND_HORIZON_DAYS = 14


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _approx_equal(a, b, tol=1e-9) -> bool:
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= tol
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_approx_equal(a[key], b[key], tol) for key in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_approx_equal(x, y, tol) for x, y in zip(a, b))
    return a == b


def _incumbent_bands_stay_calibrated(incumbents: dict) -> bool:
    return all(
        0.70 <= incumbents[key]["pooled_coverage_80"] <= 0.90
        for key in ("seasonal_naive_backtest", "bracket_band_backtest")
    )


CHECKS = [
    ("incumbents-c1", "c1_incumbents.json", harness.run_c1, _incumbent_bands_stay_calibrated, "incumbents"),
    ("elasticity-poisson-eb-1.0", "c2_elasticity.json", harness.run_c2, lambda s: s["verdict"] == "challenger wins"),
    ("baseline-cleanlevel-1.0", "c3_baseline.json", harness.run_c3, lambda s: s["verdict"] == "challenger wins"),
    ("counterfactual-cleanlevel-1.0", "c5_counterfactual.json", harness.run_c5, lambda s: s["verdict"] == "challenger wins"),
    ("rollout-report-1.0", "c6_reports.json", harness.run_c6, lambda s: s["acceptance_met"]),
    ("elasticity-hier-em-1.0 (recorded loser)", "c4_hier.json", harness.run_c4, lambda s: s["verdict"] == "incumbent stays"),
]


def run_gates(checks=None) -> tuple[list[dict], bool]:
    rows, all_ok = [], True
    for check in checks if checks is not None else CHECKS:
        name, snapshot_file, runner, passes = check[:4]
        key = check[4] if len(check) > 4 else "summary"
        current = runner()[key]
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
    return rows, all_ok


def _forecast_one(forecaster, history):
    try:
        return forecaster.CleanLevelBaseline().fit(history.sort_values("date")).forecast(BAND_HORIZON_DAYS)
    except (ValueError, IndexError, KeyError) as error:
        print(f"    (no band for {history['sku'].iloc[0]}: {error})")
        return None


def _validate_report(report: dict) -> None:
    from jsonschema import Draft202012Validator, FormatChecker  # noqa: PLC0415

    schema = json.loads((HERE.parent / "contracts" / "rollout_report.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(report)


def _reports_for_shop(source, client, shop_domain, orders, generated_at, gates_ok, sink) -> bool:
    from priceflag_ml import elasticity, reports as report_model  # noqa: PLC0415

    windows = source.rollout_windows(shop_domain, status="completed")
    if windows.empty:
        return True
    history = source.price_history(shop_domain)
    products = source.products(shop_domain)
    built: list[dict] = []
    ok = True
    for window in windows.itertuples():
        rollout_id = str(window.rollout_id)
        plans = report_model.plans_from_price_history(history, rollout_id, products)
        if not plans:
            print(f"    (no report for rollout {rollout_id}: no applied price changes journaled)")
            continue
        pre = orders[orders["date"] < window.start_day]
        during = orders[(orders["date"] >= window.start_day) & (orders["date"] <= window.end_day)]
        # Fit only data available before activation; using the full nightly fit
        # would leak the realized rollout outcome into its own prediction.
        fits_before = elasticity.fit_store(pre) if not pre.empty else []
        fit_by_sku = {fit.sku: fit for fit in fits_before}
        try:
            report = report_model.build_report(
                rollout_id=rollout_id,
                plans=plans,
                pre_history=pre,
                during_actuals=during,
                fits_before={plan.sku: fit_by_sku.get(plan.sku) for plan in plans},
                generated_at=generated_at,
            )
            _validate_report(report)
        except (ValueError, RuntimeError) as error:
            print(f"    (no report for rollout {rollout_id}: {error})")
            continue
        except Exception as error:  # schema violations must make the nightly red
            print(f"    (INVALID report for rollout {rollout_id}: {error})")
            ok = False
            continue
        built.append(report)

    rows = report_model.reports_contract_rows(built)
    sink.extend(rows)
    if not rows or client is None:
        return ok
    result = client.post_run(
        shop_domain=shop_domain,
        kind="report",
        model_version=report_model.MODEL_VERSION,
        gate_passed=gates_ok,
        reports=rows,
        notes="completed-rollout reports; prediction fit used pre-activation data only",
    )
    print(f"    -> report: {result.describe()}")
    return ok and not result.is_error


def refit_real_stores(out_dir: Path, gates_ok: bool, gate_metrics: dict, require_ingest: bool = False) -> bool:
    from priceflag_ml import elasticity, forecaster, reports  # noqa: PLC0415
    from priceflag_ml.data import SupabaseSource  # noqa: PLC0415
    from priceflag_ml.ingest import IngestClient  # noqa: PLC0415

    source = SupabaseSource.from_env()
    client = IngestClient.from_env_or_none()
    if require_ingest and client is None:
        print("real-data refit: ingest is required but PRICEFLAG_APP_URL/ML_INGEST_SECRET are missing")
        return False
    shops = source.list_shops()
    if require_ingest and not shops:
        print("real-data refit: zero shops are visible; refusing to pass a real-ingest nightly")
        return False
    print(f"real-data refit: {len(shops)} shop(s) readable")

    generated_at = _utc_now_iso()
    all_fits: list[dict] = []
    all_bands: list[dict] = []
    all_reports: list[dict] = []
    ok = True
    accepted_rows = 0
    for shop_domain in shops:
        orders = source.order_days(shop_domain)
        if orders.empty:
            print(f"  {shop_domain}: no order history readable")
            continue
        fits = elasticity.fit_store(orders)
        window_start, window_end = str(orders["date"].min().date()), str(orders["date"].max().date())
        fit_rows = elasticity.fits_contract_rows(
            fits,
            shop_domain=shop_domain,
            fitted_at=generated_at,
            window_start=window_start,
            window_end=window_end,
        )
        band_rows: list[dict] = []
        for sku, history in orders.groupby("sku", sort=True):
            forecast = _forecast_one(forecaster, history)
            if forecast is not None:
                band_rows.extend(
                    forecaster.bands_contract_rows(
                        forecast, shop_domain=shop_domain, variant_gid=str(sku), generated_at=generated_at
                    )
                )
        all_fits.extend(fit_rows)
        all_bands.extend(band_rows)
        print(f"  {shop_domain}: {len(fit_rows)} fit(s), {len(band_rows)} band row(s)")

        if client is not None:
            for kind, version, incumbent, fit_payload, band_payload in (
                ("elasticity", elasticity.MODEL_VERSION, "bracket-elasticity", fit_rows, []),
                ("baseline", forecaster.MODEL_VERSION, "bracket-band", [], band_rows),
            ):
                if not fit_payload and not band_payload and gates_ok:
                    continue
                result = client.post_run(
                    shop_domain=shop_domain,
                    kind=kind,
                    model_version=version,
                    gate_passed=gates_ok,
                    incumbent_version=incumbent,
                    metrics=gate_metrics.get(version, {}),
                    fits=fit_payload,
                    bands=band_payload,
                    notes=f"nightly refit over {window_start}..{window_end}",
                )
                print(f"    -> {kind}: {result.describe()}")
                ok &= not result.is_error
                if result.accepted:
                    accepted_rows += result.rows_written
        ok &= _reports_for_shop(source, client, shop_domain, orders, generated_at, gates_ok, all_reports)

    (out_dir / "elasticity_fits.json").write_text(json.dumps(all_fits, indent=2, default=str))
    (out_dir / "expected_bands.json").write_text(json.dumps(all_bands, indent=2, default=str))
    (out_dir / "rollout_reports.json").write_text(json.dumps(all_reports, indent=2, default=str))
    (out_dir / "calibration_summary.json").write_text(json.dumps(reports.calibration_summary(all_reports), indent=2))
    if require_ingest and accepted_rows == 0:
        print("real-data refit: no model rows were acknowledged; refusing a green production nightly")
        ok = False
    return ok


def main() -> int:
    out_dir = HERE / "out"
    out_dir.mkdir(exist_ok=True)
    rows, ok = run_gates()
    (out_dir / "model_runs.json").write_text(json.dumps(rows, indent=2, default=str))

    require_real = os.environ.get("REQUIRE_REAL_INGEST", "").lower() in {"1", "true", "yes"}
    read_configured = bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_ML_READONLY_KEY"))
    write_configured = bool((os.environ.get("PRICEFLAG_APP_URL") or os.environ.get("APP_URL")) and os.environ.get("ML_INGEST_SECRET"))
    any_configured = any(
        os.environ.get(key)
        for key in ("SUPABASE_URL", "SUPABASE_ML_READONLY_KEY", "PRICEFLAG_APP_URL", "APP_URL", "ML_INGEST_SECRET")
    )
    if any_configured and not (read_configured and write_configured):
        print("real-data refit: partial configuration is unsafe; all read and ingest settings are required")
        ok = False
    elif read_configured and write_configured:
        metrics = {row["model_version"]: row["metrics"] for row in rows}
        ok &= refit_real_stores(out_dir, gates_ok=ok, gate_metrics=metrics, require_ingest=require_real)
    elif require_real:
        print("REQUIRE_REAL_INGEST=true but real Supabase and ingest configuration is absent")
        ok = False
    else:
        print("no real-data configuration: golden-mode gates only")
    print(f"nightly {'GREEN' if ok else 'RED'}; model_runs -> {out_dir / 'model_runs.json'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
