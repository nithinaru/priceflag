-- A rollback is a storefront write, so its persisted baseline needs the same
-- one-cent floor as a forward target. Excluded zero-price products are retained
-- only as explanation rows and are never eligible for either write direction.
-- Intentionally validate existing rows: staging must stop for manual review if
-- an unsafe included baseline already exists.

alter table public.rollout_variants
  add constraint rollout_variants_baseline_price_minimum
  check (excluded or baseline_price_cents >= 1);
