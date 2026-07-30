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

4. **Output tables.** C2 writes `elasticity_fits`, C3 writes `expected_bands`,
   both with `model_version`; C7 needs the `model_runs` registry. When you
   write those schemas, the fields Lane C will populate are per
   BUILD_BRIEF §3 (`elasticity, se, n_obs, price_variation_pct, confidence,
   model_version, fitted_at` / `expected_units, low, high, model_version`).
   Flag anything extra you want in them now — cheap to add while the fitters
   are being written.
