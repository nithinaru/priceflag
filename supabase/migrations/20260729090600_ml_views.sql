-- Priceflag — read-only views for the Python ML lane (Lane C).
--
-- Lane C pulls tidy frames, not joins. These views are the stable read surface:
-- if the underlying columns move, the views absorb it and `ml/data.py` does not
-- change. Treat their column names as part of contracts/.
--
-- security_invoker = on so the caller's own RLS applies. Sprint B6 adds the
-- dedicated read-only role plus the SELECT policies that let it see rows;
-- until then only the service role can read through these.

-- One row per variant per day, with everything a demand model needs.
create view public.ml_product_days
with (security_invoker = on) as
select
  s.shop_domain,
  od.shop_id,
  od.variant_gid,
  coalesce(od.product_gid, p.product_gid)          as product_gid,
  od.day,
  extract(isodow from od.day)::int                 as dow,
  od.units,
  od.orders,
  od.net_revenue_cents,
  od.gross_revenue_cents,
  od.discount_cents,
  od.refund_units,
  od.realized_unit_price_cents,
  -- Prefer the list price the shopper actually saw; fall back to the current
  -- catalog price so a thin sync still yields a usable regressor.
  coalesce(od.list_price_cents, p.price_cents)     as list_price_cents,
  od.had_stockout,
  od.on_promo,
  p.cogs_cents,
  p.cogs_source,
  p.product_type,
  p.vendor,
  p.status,
  (p.is_gift_card or p.requires_selling_plan or p.has_selling_plan
     or p.status <> 'ACTIVE' or p.deleted_at is not null)  as excluded_from_pricing
from public.order_days od
join public.shops s on s.id = od.shop_id
left join public.products p
       on p.shop_id = od.shop_id and p.variant_gid = od.variant_gid;

comment on view public.ml_product_days is
  'Tidy per-variant-per-day frame for Lane C. list_price_cents is the elasticity regressor; excluded_from_pricing marks variants Priceflag will never reprice.';

-- Current catalog, one row per variant.
create view public.ml_products
with (security_invoker = on) as
select
  s.shop_domain,
  p.shop_id,
  p.variant_gid,
  p.product_gid,
  p.title,
  p.variant_title,
  p.sku,
  p.vendor,
  p.product_type,
  p.status,
  p.price_cents,
  p.compare_at_cents,
  p.cogs_cents,
  p.cogs_source,
  p.inventory_quantity,
  (p.is_gift_card or p.requires_selling_plan or p.has_selling_plan
     or p.status <> 'ACTIVE' or p.deleted_at is not null)  as excluded_from_pricing,
  p.last_synced_at
from public.products p
join public.shops s on s.id = p.shop_id
where p.deleted_at is null;

comment on view public.ml_products is 'Current catalog for Lane C, variant-grained.';

-- Every observed price change, from any source. This is how Lane C knows which
-- days had which list price, and which days are contaminated by a rollout.
create view public.ml_price_history
with (security_invoker = on) as
select
  s.shop_domain,
  j.shop_id,
  j.variant_gid,
  j.product_gid,
  j.applied_at,
  public.pf_shop_day(j.applied_at, s.timezone) as day,
  j.before_price_cents,
  j.after_price_cents,
  j.source,
  j.actor,
  j.rollout_id,
  j.stage_index
from public.journal_entries j
join public.shops s on s.id = j.shop_id
where j.status = 'applied';

comment on view public.ml_price_history is
  'Applied price changes only (skipped no-ops and failures excluded). `day` is in shop time.';

-- Rollout windows, so a backtest can hold out or condition on them.
create view public.ml_rollout_windows
with (security_invoker = on) as
select
  s.shop_domain,
  r.shop_id,
  r.id                                             as rollout_id,
  r.name,
  r.status,
  r.change_type,
  r.change_pct,
  r.change_absolute_cents,
  r.started_at,
  r.ended_at,
  r.ended_reason,
  public.pf_shop_day(r.started_at, s.timezone)     as start_day,
  public.pf_shop_day(coalesce(r.ended_at, now()), s.timezone) as end_day,
  array(
    select rv.variant_gid
      from public.rollout_variants rv
     where rv.rollout_id = r.id and not rv.excluded
  )                                                as variant_gids
from public.rollouts r
join public.shops s on s.id = r.shop_id
where r.started_at is not null;

comment on view public.ml_rollout_windows is
  'Started rollouts with their shop-time day windows and affected variants — the treatment periods for counterfactual work (C5).';
