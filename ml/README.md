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
| `priceflag_ml/data.py` | Read-only data access: golden fixture or direct PostgreSQL through the narrow `priceflag_ml_readonly` role (`SUPABASE_ML_READONLY_KEY` is its libpq URL, not an API key) |
| `priceflag_ml/baselines.py` | Incumbents: seasonal-naive forecaster (80% bands), bracket elasticity (v0 stand-in) |
| `priceflag_ml/elasticity.py` | Champion elasticity: Poisson GLM + EB shrinkage, honest confidence tiers, `elasticity_fits` rows |
| `priceflag_ml/forecaster.py` | Champion baseline forecaster: promo-clean dow-level model + calibrated 80% bands, `expected_bands` rows |
| `priceflag_ml/metrics.py` | Coverage, pinball loss, MAPE/WAPE, elasticity recovery |
| `priceflag_ml/harness.py` | Rolling-origin backtests, golden recovery, champion-vs-challenger comparison |
| `eval/` | Committed harness score snapshots (`c1_incumbents.json` = the bar) |
| `tests/` | The harness itself is under test |

## Real-store release safety

Real reads use direct PostgreSQL through the dedicated
`priceflag_ml_readonly` role. The connection URL must identify the same project
as `SUPABASE_URL` and use `sslmode=verify-full&sslrootcert=system`. Before any
merchant rows are read, the job verifies `current_user` plus protected database
markers for the expected project, environment and random sentinel. Every query
runs in an explicit read-only transaction with a timeout.

Before the app ingest secret is used, the destination is verified through the
Vercel API as a READY deployment in the pinned Priceflag app project and the
expected Production or Preview target. Accepted model-run receipts are then
read back through the attested database and must match the candidate commit,
successful status and exact row count.

The database attestation checks effective authority, not merely the role name:
the login must be non-superuser, NOINHERIT, unable to create databases/roles or
bypass RLS, have no memberships, writable relations, sequences, executable
SECURITY DEFINER routines, creatable non-system schemas or readable columns
outside the explicit ML surface,
and it must not be able to read `shops.access_token_enc`. Migration
`20260804180000_normalize_ml_readonly_privileges.sql` resets direct grants and
role attributes before restoring that allowlist.

GitHub uploads only `out/real_ingest_evidence.json`, whose strict allowlist
contains aggregate counts and identities but no merchant domains, product or
variant identifiers, model-run IDs, financial rows, URLs or credentials. Raw
fit, band and report files remain ephemeral on the runner and are never
uploaded.

## Reproduce the incumbent scores

```bash
cd ml && uv run python -m priceflag_ml.harness      # C1: incumbent bar
cd ml && uv run python -m priceflag_ml.harness c2   # C2: elasticity gate (5 seeds)
```

Deterministic: the golden generator is seeded (per-SKU independent streams)
and anchored to a fixed end date; the same command always yields
`eval/c1_incumbents.json`. A SHA256 snapshot test
(`tests/test_golden.py::test_golden_snapshot_pinned`) pins the golden universe
— note it depends on the exact pinned numpy version (bit-stream stability). If
a dependency bump or generator edit changes the data, the test fails loudly:
re-run the harness, re-baseline `eval/` + `MODELS.md`, and update the hash in
the same commit.
