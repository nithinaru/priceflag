-- Priceflag — daily order aggregates. NO PII, EVER (R23).
--
-- This is the only place order data lands: units and money per SKU per day.
-- No customer id, no email, no address, no order id. If a future feature seems
-- to need one of those, it does not.

create table public.order_days (
  shop_id                   uuid not null references public.shops(id) on delete cascade,
  variant_gid               text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),
  -- Calendar day in the SHOP's timezone (shops.timezone), not UTC.
  day                       date not null,

  product_gid               text,

  units                     integer not null default 0 check (units >= 0),
  -- Distinct orders that contained this variant. Not summable across variants.
  orders                    integer not null default 0 check (orders >= 0),

  gross_revenue_cents       bigint not null default 0,
  discount_cents            bigint not null default 0 check (discount_cents >= 0),
  refund_units              integer not null default 0 check (refund_units >= 0),
  refund_cents              bigint not null default 0 check (refund_cents >= 0),
  -- gross - discounts - refunds. Stored, not generated, because refunds land
  -- days later via webhook and we want the arithmetic in one obvious place.
  net_revenue_cents         bigint not null default 0,

  -- Average price actually paid: net_revenue / units. This is the demand-side
  -- price and it moves with discounts.
  realized_unit_price_cents integer check (realized_unit_price_cents >= 0),
  -- The variant's list price on that day, reconstructed from journal_entries
  -- during sync. Lane C's elasticity regression wants the price the shopper
  -- saw on the page, which is this one.
  list_price_cents          integer check (list_price_cents >= 0),

  -- Controls for the demand model. A day with no inventory is not a day of
  -- weak demand, and a promo day is not evidence about list price.
  had_stockout              boolean not null default false,
  on_promo                  boolean not null default false,

  source                    text not null default 'sync'
                              check (source in ('sync', 'webhook', 'seed')),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  primary key (shop_id, variant_gid, day)
);

comment on table public.order_days is
  'Daily per-variant aggregates. Deliberately holds no customer identifiers of any kind (R23). Not FK-bound to products so a webhook for an unsynced variant can still land; sync reconciles.';
comment on column public.order_days.list_price_cents is
  'List price on that day (from the price journal). The regressor for elasticity — realized_unit_price_cents moves with discounts and is not the same thing.';

create index order_days_shop_day_idx on public.order_days (shop_id, day);
create index order_days_variant_day_idx on public.order_days (shop_id, variant_gid, day desc);

create trigger order_days_touch before update on public.order_days
  for each row execute function public.pf_touch_updated_at();
