# Contract requests — Lane C

Append-only. Lane B: please land or answer; Lane C mocks against golden data
meanwhile (nothing here blocks C1–C3).

> Production note (2026-08-04): the historical direct-database credential
> requests below are superseded. The worker now uses authenticated
> `POST /api/ml/export`, and `priceflag_ml_readonly` is permanently `NOLOGIN`.

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
