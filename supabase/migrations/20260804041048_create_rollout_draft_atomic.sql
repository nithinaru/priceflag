-- Atomically persist a merchant-approved draft and the frozen per-variant
-- baselines that make a later rollback deterministic. This is intentionally a
-- narrow server-only RPC; browser roles must go through the authenticated API.

create or replace function public.pf_create_rollout_draft(
  p_rollout jsonb,
  p_variants jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rollout public.rollouts%rowtype;
  v_variant jsonb;
  v_variants jsonb;
begin
  if p_rollout->>'status' is distinct from 'draft'
     or coalesce((p_rollout->>'current_stage')::integer, -999) <> -1
     or p_rollout->>'started_at' is not null then
    raise exception 'pf_create_rollout_draft only accepts an unstarted draft';
  end if;

  if coalesce(jsonb_typeof(p_variants), '') <> 'array'
     or jsonb_array_length(p_variants) = 0 then
    raise exception 'pf_create_rollout_draft needs a frozen variant selection';
  end if;

  if coalesce((p_rollout->'guardrails'->>'auto_rollback')::boolean, true) then
    raise exception 'automatic rollback is disabled for the public beta';
  end if;

  insert into public.rollouts (
    id, shop_id, name, status, change_type, change_pct,
    change_absolute_cents, rounding, horizon_days, stages, current_stage,
    stage_entered_at, guardrails, forecast, scheduled_start_at, started_at,
    ended_at, ended_reason, paused_reason, notify_emails, created_by
  ) values (
    (p_rollout->>'id')::uuid,
    (p_rollout->>'shop_id')::uuid,
    p_rollout->>'name',
    p_rollout->>'status',
    p_rollout->>'change_type',
    (p_rollout->>'change_pct')::numeric,
    (p_rollout->>'change_absolute_cents')::integer,
    coalesce(p_rollout->>'rounding', 'none'),
    coalesce((p_rollout->>'horizon_days')::integer, 90),
    p_rollout->'stages',
    (p_rollout->>'current_stage')::integer,
    (p_rollout->>'stage_entered_at')::timestamptz,
    p_rollout->'guardrails',
    p_rollout->'forecast',
    (p_rollout->>'scheduled_start_at')::timestamptz,
    (p_rollout->>'started_at')::timestamptz,
    (p_rollout->>'ended_at')::timestamptz,
    p_rollout->>'ended_reason',
    p_rollout->>'paused_reason',
    coalesce(array(select jsonb_array_elements_text(coalesce(p_rollout->'notify_emails', '[]'::jsonb))), '{}'),
    coalesce(p_rollout->>'created_by', 'merchant')
  )
  returning * into v_rollout;

  for v_variant in select value from jsonb_array_elements(p_variants)
  loop
    if v_variant->>'rollout_id' is distinct from v_rollout.id::text
       or v_variant->>'shop_id' is distinct from v_rollout.shop_id::text then
      raise exception 'every frozen variant must belong to the draft rollout and shop';
    end if;
    if not exists (
      select 1
      from public.products product
      where product.shop_id = v_rollout.shop_id
        and product.variant_gid = v_variant->>'variant_gid'
        and product.product_gid = v_variant->>'product_gid'
    ) then
      raise exception 'every frozen variant must be owned by the draft shop'
        using errcode = '42501';
    end if;
    if not exists (
      select 1
      from public.products product
      where product.shop_id = v_rollout.shop_id
        and product.variant_gid = v_variant->>'variant_gid'
        and product.price_cents = (v_variant->>'baseline_price_cents')::integer
        and product.compare_at_cents is not distinct from
          (v_variant->>'baseline_compare_at_cents')::integer
    ) then
      raise exception 'a frozen baseline no longer matches the shop catalog'
        using errcode = '40001';
    end if;
    if not coalesce((v_variant->>'excluded')::boolean, false)
       and coalesce((v_variant->>'target_price_cents')::integer, 0) < 1 then
      raise exception 'an included variant target must be at least one cent';
    end if;
    if v_variant->>'applied_price_cents' is not null
       or v_variant->>'applied_at' is not null
       or v_variant->>'reverted_at' is not null then
      raise exception 'a frozen draft variant cannot already be applied or reverted';
    end if;

    insert into public.rollout_variants (
      rollout_id, shop_id, variant_gid, product_gid, title, sku,
      baseline_price_cents, baseline_compare_at_cents, target_price_cents,
      target_compare_at_cents, compare_at_action, baseline_units_per_day,
      cogs_cents_at_creation, cohort_stage, applied_price_cents, applied_at,
      reverted_at, excluded, exclusion_reason
    ) values (
      (v_variant->>'rollout_id')::uuid,
      (v_variant->>'shop_id')::uuid,
      v_variant->>'variant_gid',
      v_variant->>'product_gid',
      coalesce(v_variant->>'title', ''),
      v_variant->>'sku',
      (v_variant->>'baseline_price_cents')::integer,
      (v_variant->>'baseline_compare_at_cents')::integer,
      (v_variant->>'target_price_cents')::integer,
      (v_variant->>'target_compare_at_cents')::integer,
      coalesce(v_variant->>'compare_at_action', 'none'),
      (v_variant->>'baseline_units_per_day')::numeric,
      (v_variant->>'cogs_cents_at_creation')::integer,
      (v_variant->>'cohort_stage')::integer,
      null,
      null,
      null,
      coalesce((v_variant->>'excluded')::boolean, false),
      v_variant->>'exclusion_reason'
    );
  end loop;

  insert into public.rollout_events (
    rollout_id, shop_id, type, message, actor, data
  ) values (
    v_rollout.id,
    v_rollout.shop_id,
    'created',
    'Draft created. No Shopify prices have changed.',
    'merchant',
    jsonb_build_object(
      'included', (
        select count(*)
          from jsonb_array_elements(p_variants) as item(value)
         where not coalesce((item.value->>'excluded')::boolean, false)
      ),
      'excluded', (
        select count(*)
          from jsonb_array_elements(p_variants) as item(value)
         where coalesce((item.value->>'excluded')::boolean, false)
      )
    )
  );

  select coalesce(jsonb_agg(to_jsonb(rv) order by rv.cohort_stage, rv.variant_gid), '[]'::jsonb)
    into v_variants
    from public.rollout_variants rv
   where rv.rollout_id = v_rollout.id;

  return jsonb_build_object('rollout', to_jsonb(v_rollout), 'variants', v_variants);
end;
$$;

comment on function public.pf_create_rollout_draft(jsonb, jsonb) is
  'Server-only atomic creation of a draft rollout, its immutable frozen variant selection, and created event.';

revoke all on function public.pf_create_rollout_draft(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pf_create_rollout_draft(jsonb, jsonb) to service_role;
