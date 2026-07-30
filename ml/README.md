# Priceflag ML (Lane C)

Python models behind Priceflag's forecasts and monitoring bands: elasticity
estimation, baseline demand forecasting with honest uncertainty, counterfactual
rollout monitoring, and calibration tracking.

## Setup & tests

```bash
cd ml
uv sync          # Python 3.12, pinned deps (uv installs the interpreter too)
uv run pytest    # golden-data recovery + backtest gates
```

From the repo root: `uv run --project ml pytest ml`.

## The rule that governs this directory

**No model ships or replaces another unless it beats the incumbent on the eval
harness** (PRD R28): golden-data recovery, rolling-origin backtests, interval
coverage. Failed challengers are recorded in [MODELS.md](MODELS.md), not
deployed. Band calibration is a safety property — the bands drive
auto-rollback (R29).

## Layout

| Path | What |
|---|---|
| `priceflag_ml/golden.py` | Synthetic golden store with known ground truth (elasticity, seasonality, promos with price confound, trend, stockouts, NB noise) |
| `priceflag_ml/data.py` | Read-only data access: golden fixture or Supabase PostgREST (`SUPABASE_URL` + `SUPABASE_ML_READONLY_KEY`) |
| `priceflag_ml/baselines.py` | Incumbents: seasonal-naive forecaster (80% bands), bracket elasticity (v0 stand-in) |
| `priceflag_ml/metrics.py` | Coverage, pinball loss, MAPE/WAPE, elasticity recovery |
| `priceflag_ml/harness.py` | Rolling-origin backtests, golden recovery, champion-vs-challenger comparison |
| `eval/` | Committed harness score snapshots (`c1_incumbents.json` = the bar) |
| `tests/` | The harness itself is under test |

## Reproduce the incumbent scores

```bash
cd ml && uv run python -m priceflag_ml.harness
```

Deterministic: the golden generator is seeded (per-SKU independent streams)
and anchored to a fixed end date; the same command always yields
`eval/c1_incumbents.json`. A SHA256 snapshot test
(`tests/test_golden.py::test_golden_snapshot_pinned`) pins the golden universe
— note it depends on the exact pinned numpy version (bit-stream stability). If
a dependency bump or generator edit changes the data, the test fails loudly:
re-run the harness, re-baseline `eval/` + `MODELS.md`, and update the hash in
the same commit.
