# Contract requests — Lane C

Append-only. Lane B: please land or answer; Lane C mocks against golden data
meanwhile (nothing here blocks C1–C3).

## 2026-07-29 (Sprint C1)

1. **v0 source not in repo.** The build brief tells Lane C to port
   `lib/demo-data.ts` (golden-data generator) and beat `lib/forecast.ts`
   (v0 bracket math), but neither file — nor any v0 code — is committed.
   Please commit the v0 code, or point me at it. Until then:
   - the golden generator (`ml/priceflag_ml/golden.py`) was built from the
     PRD's scope description (daily aggregates, seasonality, promos, trend,
     stockouts, NB noise);
   - the bracket incumbent uses documented stand-in constants
     (point −1.2, range [−2.2, −0.6]) in `ml/priceflag_ml/baselines.py` —
     I will reconcile them to v0's actual scenario table when it lands.

2. **`order_days` column contract.** `contracts/db/` doesn't exist yet.
   Lane C assumes (in `ml/priceflag_ml/data.py`):
   `shop_id, sku, date, units, revenue_cents, price_cents, promo, stockout`.
   Requests:
   - a per-day `price_cents` (avg or closing realized price) — elasticity is
     unestimable without the price actually charged each day;
   - a `promo` boolean (or a way to derive it, e.g. discount applied) — promo
     confounding is the #1 bias in elasticity fits;
   - a `stockout` boolean if inventory data allows — zero-sales days from
     empty shelves poison demand fits; if not available I'll infer gaps
     heuristically and flag lower confidence.

3. **Read-only credentials.** Will need `SUPABASE_URL` +
   `SUPABASE_ML_READONLY_KEY` in `.env.example` and as GitHub Actions secrets
   (for the C7 nightly refit) once B6 lands. Golden data suffices until then.

4. **`elasticity_fits.explanation` column (new, from C2).** Every fit row now
   carries a plain-language `explanation` string (e.g. "Measured from this
   product's own price changes (17% price variation across 174 days of
   history)."). R7 requires a one-line explanation per estimate and R25 bans
   jargon — Lane A can render this string verbatim. Please include
   `explanation text` in the `elasticity_fits` schema. Also `low`/`high`
   (80% credible bounds on the elasticity itself) — the forecast card's range
   should come from these, not from a fixed bracket, when confidence isn't
   `assumption`.

## 2026-07-29 (post-B1 alignment — replies to Lane B's serviced answers)

6. **All four answers received and adopted.** `ml/data.py` now reads
   `ml_product_days` (variant_gid/day/list_price_cents/on_promo/had_stockout →
   canonical frame); the elasticity fitter regresses on `list_price_cents`;
   `fits_contract_rows()` emits schema-exact `elasticity_fit` rows (validated
   against your JSON schema in `ml/tests/test_elasticity.py`) including
   `confidence_explanation`, `shrinkage_weight`, `prior_elasticity`, `method`.
   Your `lib/engine/bands.ts` is ported into the harness
   (`baselines.BracketBand`) and is now the recorded band incumbent — it beats
   my seasonal-naive on golden data (median WAPE 0.572 vs 0.591, coverage
   0.803), so C3 gates against it.

7. **Yes, please switch `lib/demo/generator.ts` to negative-binomial noise.**
   Real daily retail counts are overdispersed (var = mu + mu²/k, k ≈ 4–12);
   Poisson noise makes bands look better-calibrated than they will be on real
   stores. My golden generator draws NB with per-SKU k ∈ [4, 12] — happy to
   share parameters so the two fixtures agree.

8. **`elasticity_fits.low/high` (request stands, low priority).** The schema
   carries `se` only. My posterior is asymmetric at the edges (high clipped to
   −0.05; wrong-sign fits vacate precision), so `elasticity ± z·se` slightly
   misstates the served range. Fine to defer — `se` is a good approximation —
   but flagging that the fitted range Lane B renders is not exactly my
   credible interval until the schema carries explicit bounds.

5. **Output tables.** C2 writes `elasticity_fits`, C3 writes `expected_bands`,
   both with `model_version`; C7 needs the `model_runs` registry. When you
   write those schemas, the fields Lane C will populate are per
   BUILD_BRIEF §3 (`elasticity, se, n_obs, price_variation_pct, confidence,
   model_version, fitted_at` / `expected_units, low, high, model_version`).
   Flag anything extra you want in them now — cheap to add while the fitters
   are being written.


## 2026-07-29 (Sprint C7)

9. **Write path for fits/bands (needed to close the loop).** The nightly job
   (`.github/workflows/ml-nightly.yml` → `ml/nightly.py`) runs every
   champion's harness gate + drift check and emits contract-row artifacts
   (`elasticity_fits.json`, `expected_bands.json`, `model_runs.json`). Two
   things needed to write them into the tables instead:
   - a write-scoped key (or an ingest endpoint you own) for
     `elasticity_fits` / `expected_bands` / `model_runs` — the ML role is
     read-only by design and should stay that way for everything else;
   - a readable listing of shops/domains for the ML role (`ml_products` or a
     `shops` view) so the nightly can enumerate what to refit.
   Until then: artifacts are uploaded on every nightly run (30-day
   retention) and can be loaded by your side.

## 2026-07-30 (Sprint C9)

10. **Item 9 is closed — thank you, and one note.** `POST /api/ml/ingest` plus
    the `ml_products` grant gave me both halves. The nightly now enumerates
    shops, refits, and posts fits and bands; Lane C still holds no write
    credential, which is the right shape. Two small things:
    - **`PRICEFLAG_APP_URL` and `ML_INGEST_SECRET` need to exist as GitHub
      Actions repo secrets** for the nightly to reach production. They are in
      `.env.example` already; only the Actions side is missing. Until they
      are set the nightly runs golden-mode gates and uploads artifacts,
      exactly as before — no breakage, just no writes.
    - The endpoint takes `kind: 'elasticity' | 'baseline' | 'counterfactual'
      | 'report'` but only stores `fits` and `bands`. See item 12 for
      `report`, and item 11 for what `counterfactual` needs to be safe.

11. **`expected_band.breach_metric` — the field that would end D-12.**
    `breach_probability` is documented as "P(true effect is worse than the
    guardrail threshold)", but the row never says *which quantity* the
    threshold is on. Lane C derives it from **units**;
    `lib/engine/guardrails.ts:116` consults it before it reads `rule.metric`,
    so that units probability currently satisfies a **revenue** rule whose
    revenue is exactly on expectation — auto-rollback firing on a quantity
    nobody measured, and the merchant's guardrail sentence no longer
    describing what will happen.

    Please add to `expected_band.schema.json`:

    ```
    "breach_metric": {
      "enum": ["units", "revenue", "conversion_rate", null],
      "description": "Which quantity breach_probability is about. A guardrail
                      whose metric differs must ignore it and fall back to raw
                      threshold crossing."
    }
    ```

    Until it exists, Lane C **suppresses the probability rather than
    mislabelling it**: `CounterfactualMonitor.contract_rows()` takes the
    rollout's `guardrail_metrics` and emits `breach_probability: null` unless
    every guardrail on that rollout watches units. Your evaluator then falls
    back to raw threshold crossing, which is noisier on small stores — the
    whipsaw C5 exists to reduce — but noisier and about the right quantity
    beats confident and about the wrong one. When the field lands I will emit
    it on every row and stop suppressing.

    A revenue-metric counterfactual is buildable on my side (it is a different
    model, not a relabelling, so it needs its own R28 gate). Say the word and
    it becomes a sprint.

12. **D-16: the evaluator must dedupe bands before summing.** Not a schema
    request — a fix in `lib/evaluator/index.ts:108-131`.
    `getExpectedBands(...)` is called with `rolloutId: undefined` and every
    returned row is passed to `combineBands`, which **adds** `expected_units`.
    So two rows for one variant-day double the expectation, and an inflated
    expectation is a manufactured shortfall — a routine nightly model upgrade
    could auto-roll back every healthy rollout at once. Suggested rule, in
    order: filter to the rollout under evaluation (or `rollout_id is null` for
    baseline), then take **exactly one** row per `(variant_gid, day)` —
    prefer `band_kind='counterfactual'` when a rollout is live, else
    `baseline`, breaking ties by newest `generated_at` / `model_run_id`.

    Lane C now enforces the producer half: `IngestClient` refuses any payload
    carrying two rows for the same `(variant_gid, day, rollout_id)`, or mixing
    `band_kind`s in one request. So the nightly cannot be what fires it. That
    is containment, not a fix — a rollover between two model versions still
    leaves two rows in the table, and only the evaluator can resolve that.

## 2026-07-30 (Sprint C11)

13. **`POST /api/ml/ingest` needs to accept `reports` (D-17).** `rollout_reports`
    exists, is granted to the ML role, and holds 0 rows. `reports.py` has
    computed `rollout_report.schema.json`-exact rows since C6 with no transport
    into the database — R30 is the PRD's declared moat and it is measured on
    nothing real.

    Lane C's whole half is now built and tested: the nightly reads
    `ml_rollout_windows` for completed rollouts, recovers each plan from
    `ml_price_history`, builds the report, and posts it with
    `kind: 'report'` and a `reports: [...]` array. All that is missing is the
    endpoint reading that key.

    Ask: accept `reports`, validate against `rollout_report.schema.json`
    exactly as `fits`/`bands` are validated, upsert into `rollout_reports`
    keyed on `rollout_id`, and — importantly — **return `reports_written` in
    the response**.

    That last field is not cosmetic. Extra JSON keys are currently *ignored*,
    not rejected, so a report payload comes back `200 accepted` with the rows
    silently gone: R30 would read as shipped while the table stayed empty.
    Lane C therefore treats an accepted response that does not report
    `reports_written` as a failure and turns the nightly red rather than
    trusting it. Until the field exists, reports are emitted to run artifacts
    (`out/rollout_reports.json`, `out/calibration_summary.json`) and the
    report leg of the nightly is red by design.

14. **`calibration_summary` has nowhere to live either.** `reports.py`
    computes the R30 dashboard number (% of completed rollouts whose realized
    outcome landed inside the predicted range) across a shop's reports. There
    is no table for it. Two options, your call: a `calibration_summaries`
    table, or Lane A derives it by aggregating `rollout_reports.in_range` at
    render time. The second is less machinery and I would take it — but then
    nothing needs to be added for it, and that is worth saying out loud rather
    than leaving the number homeless.
