-- Priceflag — record Shopify's own last-modified timestamp for a variant.
--
-- Shopify does not guarantee webhook delivery order. Without a version marker,
-- a products/update replayed after a newer one writes the OLD price back into
-- the catalog: the next forecast then simulates from a price the store stopped
-- charging, and the frozen baseline a rollback restores to comes from the same
-- stale row. Comparing this column lets a late delivery be recognised and
-- ignored.
--
-- Nullable on purpose: rows synced before this migration, and payloads that
-- omit the field, carry null and are treated as "unknown, accept" exactly as
-- they were before.

alter table public.products
  add column if not exists shopify_updated_at timestamptz;

comment on column public.products.shopify_updated_at is
  'Shopify''s updated_at for this variant''s product, used to discard out-of-order products/update deliveries. Null = unknown (pre-migration rows or payloads without the field).';
