-- Atomically apply refunds/create deltas to order_days. The raw Shopify
-- payload is never retained; only aggregate variant/day money and units land.

create or replace function public.pf_ingest_refund_webhook(
  p_shop_id uuid,
  p_event jsonb,
  p_rows jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_shop public.shops%rowtype;
  v_event public.webhook_events%rowtype;
  v_webhook_id text := nullif(p_event->>'webhook_id', '');
  v_rows integer := 0;
begin
  if v_webhook_id is null then
    raise exception 'webhook_id is required' using errcode = '22023';
  end if;
  if p_event->>'topic' <> 'refunds/create' then
    raise exception 'atomic refund ingest only accepts refunds/create' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'refund rows must be an array' using errcode = '22023';
  end if;

  select * into v_shop from public.shops where id = p_shop_id;
  if not found or v_shop.shop_domain <> lower(p_event->>'shop_domain') then
    raise exception 'webhook shop ownership mismatch' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_webhook_id, 0));
  select * into v_event from public.webhook_events where webhook_id = v_webhook_id;
  if found then
    if v_event.shop_id is distinct from p_shop_id
       or v_event.shop_domain <> v_shop.shop_domain
       or v_event.topic <> 'refunds/create' then
      raise exception 'webhook id is already bound to another shop or topic' using errcode = '42501';
    end if;
    if v_event.status = 'processed' then
      return jsonb_build_object(
        'duplicate', true,
        'rows_written', 0,
        'record', to_jsonb(v_event)
      );
    end if;
    if v_event.ingest_version is distinct from 'atomic-refund-v1' then
      raise exception 'legacy unprocessed refund webhook has ambiguous partial-write state'
        using errcode = '55000';
    end if;
  else
    insert into public.webhook_events (
      shop_domain, shop_id, topic, webhook_id, api_version, triggered_at,
      status, attempts, payload, ingest_version
    ) values (
      v_shop.shop_domain,
      p_shop_id,
      'refunds/create',
      v_webhook_id,
      nullif(p_event->>'api_version', ''),
      nullif(p_event->>'triggered_at', '')::timestamptz,
      'received',
      0,
      null,
      'atomic-refund-v1'
    ) returning * into v_event;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row(
      variant_gid text, day date, units integer, orders integer,
      gross_revenue_cents bigint, discount_cents bigint, refund_units integer,
      refund_cents bigint, net_revenue_cents bigint
    )
    where row.variant_gid is null
       or row.variant_gid not like 'gid://shopify/ProductVariant/%'
       or row.day is null
       or row.units is distinct from 0
       or row.orders is distinct from 0
       or row.gross_revenue_cents is distinct from 0
       or row.discount_cents is distinct from 0
       or row.refund_units is null
       or row.refund_units <= 0
       or row.refund_cents is null
       or row.refund_cents < 0
       or row.net_revenue_cents is distinct from -row.refund_cents
  ) then
    raise exception 'invalid additive refund webhook row' using errcode = '22023';
  end if;

  insert into public.order_days as existing (
    shop_id, variant_gid, day, product_gid, units, orders,
    gross_revenue_cents, discount_cents, refund_units, refund_cents,
    net_revenue_cents, realized_unit_price_cents, list_price_cents,
    had_stockout, on_promo, source
  )
  select
    p_shop_id, row.variant_gid, row.day, row.product_gid, 0, 0,
    0, 0, row.refund_units, row.refund_cents,
    -row.refund_cents, null, null, false, false, 'webhook'
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row(
    variant_gid text, product_gid text, day date, units integer, orders integer,
    gross_revenue_cents bigint, discount_cents bigint, refund_units integer,
    refund_cents bigint, net_revenue_cents bigint,
    realized_unit_price_cents integer, list_price_cents integer,
    had_stockout boolean, on_promo boolean
  )
  on conflict (shop_id, variant_gid, day) do update set
    product_gid = coalesce(excluded.product_gid, existing.product_gid),
    refund_units = existing.refund_units + excluded.refund_units,
    refund_cents = existing.refund_cents + excluded.refund_cents,
    net_revenue_cents = existing.net_revenue_cents + excluded.net_revenue_cents,
    realized_unit_price_cents = case
      when existing.units - existing.refund_units - excluded.refund_units > 0
       and existing.net_revenue_cents + excluded.net_revenue_cents >= 0
      then round(
        (existing.net_revenue_cents + excluded.net_revenue_cents)::numeric /
        (existing.units - existing.refund_units - excluded.refund_units)
      )::integer
      else null
    end,
    source = 'webhook',
    updated_at = now();
  get diagnostics v_rows = row_count;

  update public.webhook_events set
    status = 'processed',
    attempts = attempts + 1,
    error = null,
    processed_at = now(),
    payload = null,
    shop_id = p_shop_id
  where id = v_event.id
  returning * into v_event;

  return jsonb_build_object(
    'duplicate', false,
    'rows_written', v_rows,
    'record', to_jsonb(v_event)
  );
end;
$$;

comment on function public.pf_ingest_refund_webhook(uuid, jsonb, jsonb) is
  'Atomically deduplicates refunds/create and adds aggregate refund deltas without retaining the Shopify payload.';

revoke all on function public.pf_ingest_refund_webhook(uuid, jsonb, jsonb)
  from public, anon, authenticated, priceflag_ml_readonly;
grant execute on function public.pf_ingest_refund_webhook(uuid, jsonb, jsonb)
  to service_role;

-- Every writer (full sync, order webhook, and refund webhook) passes through
-- this invariant. A mixed day can have positive net units but negative net
-- revenue when an older, higher-priced purchase is refunded. That is valid
-- accounting, but it has no meaningful non-negative realized sale price.
create or replace function public.pf_normalize_order_day_realized_price()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('priceflag:order-days:' || new.shop_id::text, 0)
  );
  if new.units - new.refund_units <= 0 or new.net_revenue_cents < 0 then
    new.realized_unit_price_cents := null;
  end if;
  return new;
end;
$$;

drop trigger if exists order_days_normalize_realized_price on public.order_days;
create trigger order_days_normalize_realized_price
before insert or update on public.order_days
for each row execute function public.pf_normalize_order_day_realized_price();

revoke all on function public.pf_normalize_order_day_realized_price()
  from public, anon, authenticated, priceflag_ml_readonly;
grant execute on function public.pf_normalize_order_day_realized_price()
  to service_role;

-- Commit a full Shopify snapshot only if no additive sales webhook arrived
-- after the remote read began. The shop lock is also taken by every order_days
-- mutation through the trigger above, closing the check/write race.
create or replace function public.pf_commit_order_day_sync_snapshot(
  p_shop_id uuid,
  p_rows jsonb,
  p_snapshot_started_at timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rows integer := 0;
begin
  if p_snapshot_started_at is null then
    raise exception 'snapshot start is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'sync rows must be an array' using errcode = '22023';
  end if;
  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'unknown sync shop' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('priceflag:order-days:' || p_shop_id::text, 0)
  );

  if exists (
    select 1
    from public.webhook_events
    where shop_id = p_shop_id
      and topic in ('orders/create', 'refunds/create')
      and received_at >= p_snapshot_started_at
  ) then
    raise exception 'sales data changed while the full sync was running; retry the sync'
      using errcode = '40001';
  end if;

  insert into public.order_days as existing (
    shop_id, variant_gid, day, product_gid, units, orders,
    gross_revenue_cents, discount_cents, refund_units, refund_cents,
    net_revenue_cents, realized_unit_price_cents, list_price_cents,
    had_stockout, on_promo, source
  )
  select
    p_shop_id, row.variant_gid, row.day, row.product_gid, row.units, row.orders,
    row.gross_revenue_cents, row.discount_cents, row.refund_units, row.refund_cents,
    row.net_revenue_cents, row.realized_unit_price_cents, row.list_price_cents,
    coalesce(row.had_stockout, false), coalesce(row.on_promo, false), 'sync'
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row(
    variant_gid text, product_gid text, day date, units integer, orders integer,
    gross_revenue_cents bigint, discount_cents bigint, refund_units integer,
    refund_cents bigint, net_revenue_cents bigint,
    realized_unit_price_cents integer, list_price_cents integer,
    had_stockout boolean, on_promo boolean
  )
  on conflict (shop_id, variant_gid, day) do update set
    product_gid = excluded.product_gid,
    units = excluded.units,
    orders = excluded.orders,
    gross_revenue_cents = excluded.gross_revenue_cents,
    discount_cents = excluded.discount_cents,
    refund_units = excluded.refund_units,
    refund_cents = excluded.refund_cents,
    net_revenue_cents = excluded.net_revenue_cents,
    realized_unit_price_cents = excluded.realized_unit_price_cents,
    list_price_cents = excluded.list_price_cents,
    had_stockout = excluded.had_stockout,
    on_promo = excluded.on_promo,
    source = 'sync',
    updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.pf_commit_order_day_sync_snapshot(uuid, jsonb, timestamptz) is
  'Atomically rejects a stale full-order snapshot when a newer additive sales webhook exists.';

revoke all on function public.pf_commit_order_day_sync_snapshot(uuid, jsonb, timestamptz)
  from public, anon, authenticated, priceflag_ml_readonly;
grant execute on function public.pf_commit_order_day_sync_snapshot(uuid, jsonb, timestamptz)
  to service_role;
