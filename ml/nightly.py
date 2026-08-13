"""Nightly quality gates, real-store refits, completed-rollout reports and ingest."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from priceflag_ml import harness  # noqa: E402

BAND_HORIZON_DAYS = 14
REAL_INGEST_EVIDENCE_FILE = "real_ingest_evidence.json"
# The tolerated cohort demand drop for counterfactual monitoring. Matches the
# C5 eval-harness default; the ML export does not yet carry each rollout's own
# guardrail settings, so every active rollout is monitored at this drop.
COUNTERFACTUAL_GUARDRAIL_DROP = 0.20


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
    ("optimizer-lattice-1.0", "c7_optimizer.json", harness.run_c7, lambda s: s["acceptance_met"]),
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
        print(f"    (one variant produced no band: {type(error).__name__})")
        return None


def _validate_report(report: dict) -> None:
    from jsonschema import Draft202012Validator, FormatChecker  # noqa: PLC0415

    schema = json.loads((HERE.parent / "contracts" / "rollout_report.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(report)


def _write_real_ingest_evidence(out_dir: Path, evidence: dict) -> None:
    """Persist redacted proof of the real-data leg for CI/release review.

    The allowlist is deliberately small: merchant domains, product identifiers,
    connection details, and payloads must never enter a workflow artifact.
    """
    allowed = {
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
    unexpected = set(evidence) - allowed
    if unexpected:
        raise ValueError(f"real-ingest evidence contains forbidden fields: {sorted(unexpected)}")
    (out_dir / REAL_INGEST_EVIDENCE_FILE).write_text(json.dumps(evidence, indent=2, sort_keys=True))


def _close_source(source) -> None:
    close = getattr(source, "close", None)
    if callable(close):
        close()


def _counterfactuals_for_shop(source, client, shop_domain, orders, generated_at, gates_ok, sink, receipts) -> bool:
    """C5 counterfactual monitoring for every ACTIVE (running) rollout.

    Fits the counterfactual on pre-change days only, assesses the days since
    the rollout went live, and posts kind="counterfactual" band rows scoped to
    the rollout (rollout_id set, cohort-level numbers stamped per variant row —
    Lane B consumes exactly one row per day, never a sum)."""
    from priceflag_ml import counterfactual  # noqa: PLC0415

    windows = source.rollout_windows(shop_domain, status="running")
    if windows.empty:
        return True
    rows: list[dict] = []
    for window_index, window in enumerate(windows.itertuples(), start=1):
        rollout_id = str(window.rollout_id)
        variant_gids = sorted(str(gid) for gid in (window.variant_gids or []))
        treated = orders[orders["sku"].astype(str).isin(variant_gids)]
        pre = treated[treated["date"] < window.start_day]
        during = treated[(treated["date"] >= window.start_day) & (treated["date"] <= window.end_day)]
        if not variant_gids or pre.empty or during.empty:
            print(f"    (counterfactual {window_index} skipped: no pre/during history for the cohort)")
            continue
        try:
            monitor = counterfactual.CounterfactualMonitor(COUNTERFACTUAL_GUARDRAIL_DROP).fit(pre)
            assessments = monitor.assess(during)
        except (ValueError, RuntimeError, IndexError, KeyError) as error:
            print(f"    (counterfactual {window_index} skipped: {type(error).__name__})")
            continue
        if not assessments:
            print(f"    (counterfactual {window_index} skipped: no assessable days)")
            continue
        for gid in variant_gids:
            rows.extend(
                monitor.contract_rows(
                    assessments,
                    shop_domain=shop_domain,
                    variant_gid=gid,
                    rollout_id=rollout_id,
                    generated_at=generated_at,
                )
            )

    sink.extend(rows)
    if not rows or client is None:
        return True
    result = client.post_run(
        shop_domain=shop_domain,
        kind="counterfactual",
        model_version=counterfactual.MODEL_VERSION,
        gate_passed=gates_ok,
        bands=rows,
        notes="active-rollout counterfactual monitoring; fitted on pre-change days only",
    )
    print(f"    -> counterfactual: {result.describe()}")
    if result.accepted:
        if result.model_run_id is None:
            return False
        receipts.append((shop_domain, result.model_run_id, result.rows_written))
    return not result.is_error


def _recommendations_for_shop(source, client, shop_domain, fits, orders, generated_at, gates_ok, sink, receipts) -> bool:
    """C7 price recommendations for every fitted SKU (kind="recommendation").

    Reuses the fits already computed for this shop's nightly refit. The
    optimizer's own skips (no cogs, assumption fit, zero demand, ...) are
    counts in the log, never rows — a suggestion the data cannot support is
    not posted at all. Nothing here writes prices: rows land in the
    `recommendations` table for /api/recommend and the propose flow's
    prefill card, and the merchant always approves (PRD v1.1)."""
    from priceflag_ml import optimize  # noqa: PLC0415

    products = source.products(shop_domain)
    if products.empty:
        print("    (recommendations skipped: no products readable)")
        return True
    result = optimize.optimize_store(fits, products, orders, optimize.OptimizerConfig())
    rows = optimize.contract_rows(result.recommendations, shop_domain=shop_domain, computed_at=generated_at)
    best = optimize.top_n(result, 1)
    print(
        f"    recommendations: {len(rows)} suggested, {len(result.skips)} skipped"
        + (f", top nominal delta {best[0].nominal_profit_delta_cents_per_day} c/day" if best else "")
    )
    sink.extend(rows)
    if not rows or client is None:
        return True
    result_post = client.post_run(
        shop_domain=shop_domain,
        kind="recommendation",
        model_version=optimize.MODEL_VERSION,
        gate_passed=gates_ok,
        recommendations=rows,
        notes="nightly constrained per-SKU price suggestions; merchant always approves",
    )
    print(f"    -> recommendation: {result_post.describe()}")
    if result_post.accepted:
        if result_post.model_run_id is None:
            return False
        receipts.append((shop_domain, result_post.model_run_id, result_post.rows_written))
    return not result_post.is_error


def _reports_for_shop(source, client, shop_domain, orders, generated_at, gates_ok, sink, receipts) -> bool:
    from priceflag_ml import elasticity, reports as report_model  # noqa: PLC0415

    windows = source.rollout_windows(shop_domain, status="completed")
    if windows.empty:
        return True
    history = source.price_history(shop_domain)
    products = source.products(shop_domain)
    built: list[dict] = []
    ok = True
    for report_index, window in enumerate(windows.itertuples(), start=1):
        rollout_id = str(window.rollout_id)
        plans = report_model.plans_from_price_history(history, rollout_id, products)
        if not plans:
            print(f"    (report {report_index} skipped: no applied price changes journaled)")
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
            print(f"    (report {report_index} skipped: {type(error).__name__})")
            continue
        except Exception as error:  # schema violations must make the nightly red
            print(f"    (report {report_index} invalid: {type(error).__name__})")
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
    if result.accepted:
        if result.model_run_id is None:
            return False
        receipts.append((shop_domain, result.model_run_id, result.rows_written))
    return ok and not result.is_error


def refit_real_stores(out_dir: Path, gates_ok: bool, gate_metrics: dict, require_ingest: bool = False) -> bool:
    from priceflag_ml import elasticity, forecaster, reports  # noqa: PLC0415
    from priceflag_ml.data import PriceflagApiSource  # noqa: PLC0415
    from priceflag_ml.ingest import IngestClient  # noqa: PLC0415

    generated_at = _utc_now_iso()
    evidence = {
        "schema_version": 1,
        "source_transport": "https",
        "source_authority": None,
        "project_ref": None,
        "environment": None,
        "required_real_ingest": require_ingest,
        "shops_visible": 0,
        "shops_with_orders": 0,
        "fits_generated": 0,
        "bands_generated": 0,
        "reports_generated": 0,
        "rows_acknowledged": 0,
        "runs_verified": 0,
        "success": False,
        "failure_code": None,
        "generated_at": generated_at,
        "github_sha": os.environ.get("GITHUB_SHA"),
    }
    expected_project_ref = os.environ.get("PRICEFLAG_ML_EXPECTED_PROJECT_REF", "")
    expected_environment = os.environ.get("PRICEFLAG_ML_EXPECTED_ENVIRONMENT", "")
    commit_sha = os.environ.get("GITHUB_SHA", "")
    if require_ingest and (
        not re.fullmatch(r"[0-9a-f]{40}", commit_sha)
        or not expected_project_ref
        or not expected_environment
    ):
        evidence["failure_code"] = "missing_attestation_configuration"
        _write_real_ingest_evidence(out_dir, evidence)
        print("real-data refit: required commit/database attestation configuration is incomplete")
        return False
    source = PriceflagApiSource.from_env()
    identity = source.attest(expected_project_ref, expected_environment)
    evidence["source_authority"] = identity.source_authority
    evidence["project_ref"] = identity.project_ref
    evidence["environment"] = identity.environment
    client = IngestClient.from_env_or_none()
    if require_ingest and client is None:
        print("real-data refit: ingest is required but PRICEFLAG_APP_URL/ML_INGEST_SECRET are missing")
        evidence["failure_code"] = "missing_ingest_client"
        _write_real_ingest_evidence(out_dir, evidence)
        _close_source(source)
        return False
    shops = source.list_shops()
    evidence["shops_visible"] = len(shops)
    if require_ingest and not shops:
        print("real-data refit: zero shops are visible; refusing to pass a real-ingest nightly")
        evidence["failure_code"] = "zero_visible_shops"
        _write_real_ingest_evidence(out_dir, evidence)
        _close_source(source)
        return False
    print(f"real-data refit: {len(shops)} shop(s) readable")

    all_fits: list[dict] = []
    all_bands: list[dict] = []
    all_counterfactuals: list[dict] = []
    all_recommendations: list[dict] = []
    all_reports: list[dict] = []
    receipts: list[tuple[str, str, int]] = []
    ok = True
    for shop_index, shop_domain in enumerate(shops, start=1):
        orders = source.order_days(shop_domain)
        if orders.empty:
            print(f"  shop {shop_index}/{len(shops)}: no order history readable")
            continue
        evidence["shops_with_orders"] += 1
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
        print(f"  shop {shop_index}/{len(shops)}: {len(fit_rows)} fit(s), {len(band_rows)} band row(s)")

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
                    if result.model_run_id is None:
                        ok = False
                    else:
                        receipts.append((shop_domain, result.model_run_id, result.rows_written))
        ok &= _recommendations_for_shop(
            source,
            client,
            shop_domain,
            fits,
            orders,
            generated_at,
            gates_ok,
            all_recommendations,
            receipts,
        )
        ok &= _counterfactuals_for_shop(
            source,
            client,
            shop_domain,
            orders,
            generated_at,
            gates_ok,
            all_counterfactuals,
            receipts,
        )
        ok &= _reports_for_shop(
            source,
            client,
            shop_domain,
            orders,
            generated_at,
            gates_ok,
            all_reports,
            receipts,
        )

    (out_dir / "elasticity_fits.json").write_text(json.dumps(all_fits, indent=2, default=str))
    (out_dir / "expected_bands.json").write_text(json.dumps(all_bands, indent=2, default=str))
    (out_dir / "counterfactual_bands.json").write_text(json.dumps(all_counterfactuals, indent=2, default=str))
    (out_dir / "recommendations.json").write_text(json.dumps(all_recommendations, indent=2, default=str))
    (out_dir / "rollout_reports.json").write_text(json.dumps(all_reports, indent=2, default=str))
    (out_dir / "calibration_summary.json").write_text(json.dumps(reports.calibration_summary(all_reports), indent=2))
    evidence["fits_generated"] = len(all_fits)
    evidence["bands_generated"] = len(all_bands)
    evidence["reports_generated"] = len(all_reports)
    evidence["rows_acknowledged"] = sum(rows_written for _, _, rows_written in receipts)
    if require_ingest and evidence["rows_acknowledged"] == 0:
        print("real-data refit: no model rows were acknowledged; refusing a green production nightly")
        ok = False
        evidence["failure_code"] = "zero_acknowledged_rows"
    if require_ingest and ok:
        try:
            evidence["runs_verified"] = source.verify_ingest_receipts(receipts, commit_sha)
        except (RuntimeError, ValueError):
            ok = False
            evidence["failure_code"] = "ingest_readback_failed"
            print("real-data refit: acknowledged model runs failed attested database read-back")
    _close_source(source)
    evidence["success"] = ok
    _write_real_ingest_evidence(out_dir, evidence)
    return ok


def main() -> int:
    out_dir = HERE / "out"
    out_dir.mkdir(exist_ok=True)
    # A failed attempt must never leave an older green proof available for a
    # later verifier or artifact step.
    (out_dir / REAL_INGEST_EVIDENCE_FILE).unlink(missing_ok=True)
    rows, ok = run_gates()
    (out_dir / "model_runs.json").write_text(json.dumps(rows, indent=2, default=str))

    require_real = os.environ.get("REQUIRE_REAL_INGEST", "").lower() in {"1", "true", "yes"}
    identity_keys = (
        "PRICEFLAG_ML_EXPECTED_PROJECT_REF",
        "PRICEFLAG_ML_EXPECTED_ENVIRONMENT",
    )
    write_keys = (
        "ML_INGEST_SECRET",
        "PRICEFLAG_EXPECTED_APP_URL",
        "PRICEFLAG_EXPECTED_VERCEL_TARGET",
        "VERCEL_TOKEN",
    )
    identity_configured = all(os.environ.get(key) for key in identity_keys)
    write_configured = bool(os.environ.get("PRICEFLAG_APP_URL") or os.environ.get("APP_URL")) and all(
        os.environ.get(key) for key in write_keys
    )
    any_configured = any(
        os.environ.get(key)
        for key in (*identity_keys, "PRICEFLAG_APP_URL", "APP_URL", *write_keys)
    )
    if any_configured and not (identity_configured and write_configured):
        print("real-data refit: partial configuration is unsafe; all source and ingest settings are required")
        ok = False
    elif identity_configured and write_configured:
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
