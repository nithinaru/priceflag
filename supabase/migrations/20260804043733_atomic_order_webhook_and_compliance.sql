-- Atomic Shopify order webhook ingest and privacy-compliance purge.

alter table public.webhook_events
  add column if not exists ingest_version text;

alter table public.webhook_events drop constraint if exists webhook_events_status_check;
alter table public.webhook_events add constraint webhook_events_status_check
  check (status in ('received', 'processing', 'processed', 'failed', 'ignored', 'duplicate'));

-- Historical REST order payloads may contain customer/email/address fields.
-- Priceflag needs only aggregate variant/day measures, never the raw payload.
update public.webhook_events
set payload = null
where topic like 'orders/%'
   or topic in ('customers/data_request', 'customers/redact', 'shop/redact');

create table if not exists public.compliance_audit (
  id            uuid primary key default gen_random_uuid(),
  webhook_id    text not null unique,
  -- Deliberately not an FK: the audit tombstone must survive deletion of shops.
  shop_id       uuid not null,
  shop_domain   text not null,
  topic         text not null check (topic = 'shop/redact'),
  action        text not null check (action = 'shop_data_purged'),
  triggered_at  timestamptz,
  purged_at     timestamptz not null default now(),
  details       jsonb not null default '{"customer_identity_stored":false}'::jsonb,
  created_at    timestamptz not null default now()
);

alter table public.compliance_audit enable row level security;
revoke all on table public.compliance_audit from anon, authenticated;

create or replace function public.pf_ingest_order_webhook(
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
  if p_event->>'topic' <> 'orders/create' then
    raise exception 'atomic order ingest only accepts orders/create' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'order rows must be an array' using errcode = '22023';
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
       or v_event.topic <> 'orders/create' then
      raise exception 'webhook id is already bound to another shop or topic' using errcode = '42501';
    end if;
    if v_event.status = 'processed' then
      return jsonb_build_object(
        'duplicate', true,
        'rows_written', 0,
        'record', to_jsonb(v_event)
      );
    end if;
    if v_event.ingest_version is distinct from 'atomic-order-v1' then
      raise exception 'legacy unprocessed order webhook has ambiguous partial-write state'
        using errcode = '55000';
    end if;
  else
    insert into public.webhook_events (
      shop_domain, shop_id, topic, webhook_id, api_version, triggered_at,
      status, attempts, payload, ingest_version
    ) values (
      v_shop.shop_domain,
      p_shop_id,
      'orders/create',
      v_webhook_id,
      nullif(p_event->>'api_version', ''),
      nullif(p_event->>'triggered_at', '')::timestamptz,
      'received',
      0,
      null,
      'atomic-order-v1'
    ) returning * into v_event;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row(
      variant_gid text, day date, units integer, orders integer,
      gross_revenue_cents bigint, discount_cents bigint, refund_units integer,
      refund_cents bigint, net_revenue_cents bigint
    )
    where row.variant_gid not like 'gid://shopify/ProductVariant/%'
       or row.units <= 0
       or row.orders <> 1
       or row.gross_revenue_cents < 0
       or row.discount_cents < 0
       or row.discount_cents > row.gross_revenue_cents
       or row.refund_units <> 0
       or row.refund_cents <> 0
       or row.net_revenue_cents <> row.gross_revenue_cents - row.discount_cents
  ) then
    raise exception 'invalid additive order webhook row' using errcode = '22023';
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
    coalesce(row.had_stockout, false), coalesce(row.on_promo, false), 'webhook'
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row(
    variant_gid text, product_gid text, day date, units integer, orders integer,
    gross_revenue_cents bigint, discount_cents bigint, refund_units integer,
    refund_cents bigint, net_revenue_cents bigint,
    realized_unit_price_cents integer, list_price_cents integer,
    had_stockout boolean, on_promo boolean
  )
  on conflict (shop_id, variant_gid, day) do update set
    product_gid = coalesce(excluded.product_gid, existing.product_gid),
    units = existing.units + excluded.units,
    orders = existing.orders + excluded.orders,
    gross_revenue_cents = existing.gross_revenue_cents + excluded.gross_revenue_cents,
    discount_cents = existing.discount_cents + excluded.discount_cents,
    refund_units = existing.refund_units + excluded.refund_units,
    refund_cents = existing.refund_cents + excluded.refund_cents,
    net_revenue_cents = existing.net_revenue_cents + excluded.net_revenue_cents,
    realized_unit_price_cents = case
      when existing.units + excluded.units - existing.refund_units - excluded.refund_units > 0
      then round(
        (existing.net_revenue_cents + excluded.net_revenue_cents)::numeric /
        (existing.units + excluded.units - existing.refund_units - excluded.refund_units)
      )::integer
      else null
    end,
    list_price_cents = coalesce(excluded.list_price_cents, existing.list_price_cents),
    had_stockout = existing.had_stockout or excluded.had_stockout,
    on_promo = existing.on_promo or excluded.on_promo,
    source = 'webhook';
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

create or replace function public.pf_purge_shop_for_compliance(
  p_shop_id uuid,
  p_shop_domain text,
  p_webhook_id text,
  p_triggered_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_shop public.shops%rowtype;
  v_audit public.compliance_audit%rowtype;
  v_deleted integer := 0;
begin
  if nullif(p_webhook_id, '') is null or nullif(lower(p_shop_domain), '') is null then
    raise exception 'shop domain and webhook id are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_webhook_id, 0));

  select * into v_audit from public.compliance_audit where webhook_id = p_webhook_id;
  if found then
    if v_audit.shop_domain <> lower(p_shop_domain) then
      raise exception 'compliance webhook id is bound to another shop' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'purged', true,
      'shop_id', v_audit.shop_id,
      'shop_domain', v_audit.shop_domain,
      'webhook_id', v_audit.webhook_id
    );
  end if;

  select * into v_shop
  from public.shops
  where shop_domain = lower(p_shop_domain)
    and (p_shop_id is null or id = p_shop_id);
  if not found then
    raise exception 'unknown shop for compliance purge' using errcode = 'P0002';
  end if;

  insert into public.compliance_audit (
    webhook_id, shop_id, shop_domain, topic, action, triggered_at, details
  ) values (
    p_webhook_id,
    v_shop.id,
    v_shop.shop_domain,
    'shop/redact',
    'shop_data_purged',
    p_triggered_at,
    '{"customer_identity_stored":false,"raw_webhook_payload_stored":false}'::jsonb
  ) returning * into v_audit;

  perform set_config('priceflag.purge', 'on', true);
  -- Legacy rows may predate resolved shop_id attachment, so delete by domain
  -- before the FK cascade handles all correctly scoped rows.
  delete from public.webhook_events where shop_domain = v_shop.shop_domain;
  delete from public.shops where id = v_shop.id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'shop purge did not delete exactly one shop' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'purged', true,
    'shop_id', v_shop.id,
    'shop_domain', v_shop.shop_domain,
    'webhook_id', p_webhook_id
  );
end;
$$;

comment on function public.pf_ingest_order_webhook(uuid, jsonb, jsonb) is
  'Atomically deduplicates one HMAC-verified orders/create delivery and adds its per-variant daily deltas.';
comment on function public.pf_purge_shop_for_compliance(uuid, text, text, timestamptz) is
  'Audits and transactionally cascades a Shopify shop/redact request using the journal purge escape hatch.';

revoke all on function public.pf_ingest_order_webhook(uuid, jsonb, jsonb)
  from public, anon, authenticated, priceflag_ml_readonly;
revoke all on function public.pf_purge_shop_for_compliance(uuid, text, text, timestamptz)
  from public, anon, authenticated, priceflag_ml_readonly;
grant execute on function public.pf_ingest_order_webhook(uuid, jsonb, jsonb) to service_role;
grant execute on function public.pf_purge_shop_for_compliance(uuid, text, text, timestamptz) to service_role;
