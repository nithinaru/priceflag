-- Priceflag — the read-only Postgres role for the ML lane (B6).
--
-- `SUPABASE_ML_READONLY_KEY` is a **Postgres role**, not a dashboard API key. A
-- publishable key would authenticate PostgREST as `anon`, which RLS gives nothing
-- to; and the service key is read-write over everything, which is precisely what
-- the ML lane must not have. Lane C connects to Postgres directly with psycopg,
-- so a role is both the correct and the simpler answer.
--
-- The grant is deliberately narrow:
--   * SELECT on the four ml_* views and nothing else in the public schema
--   * SELECT on the underlying tables, because the views are `security_invoker`
--     and therefore run as the caller
--   * RLS SELECT policies admitting only this role
--   * NO access to `shops.access_token_enc` — see the column-level revoke below.
--     A read-only role that can read an encrypted Shopify token is a read-only
--     role that can exfiltrate a store.
--
-- The password is NOT set here. Committing a credential to a migration puts it in
-- git forever; it is set out of band with
--   alter role priceflag_ml_readonly login password '<generated>';
-- and handed to Lane C as a connection string.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'priceflag_ml_readonly') then
    -- NOLOGIN until a password is set out of band.
    create role priceflag_ml_readonly nologin;
  end if;
end
$$;

grant usage on schema public to priceflag_ml_readonly;

-- The read surface.
grant select on public.ml_product_days     to priceflag_ml_readonly;
grant select on public.ml_products         to priceflag_ml_readonly;
grant select on public.ml_price_history    to priceflag_ml_readonly;
grant select on public.ml_rollout_windows  to priceflag_ml_readonly;

-- Underlying tables, because security_invoker views run as the caller.
grant select on public.order_days       to priceflag_ml_readonly;
grant select on public.products         to priceflag_ml_readonly;
grant select on public.journal_entries  to priceflag_ml_readonly;
grant select on public.rollouts         to priceflag_ml_readonly;
grant select on public.rollout_variants to priceflag_ml_readonly;

-- `shops` is column-scoped: the views need the domain, timezone and currency, and
-- nothing else. Notably NOT access_token_enc.
grant select (id, shop_domain, name, currency, timezone, mode, created_at)
  on public.shops to priceflag_ml_readonly;

-- Lane C also reads its own outputs back, to compare a challenger with the
-- incumbent it has to beat (R28).
grant select on public.elasticity_fits to priceflag_ml_readonly;
grant select on public.expected_bands  to priceflag_ml_readonly;
grant select on public.model_runs      to priceflag_ml_readonly;
grant select on public.rollout_reports to priceflag_ml_readonly;

-- RLS is enabled with no policies, so grants alone still return zero rows.
do $$
declare
  t text;
begin
  foreach t in array array[
    'order_days', 'products', 'shops', 'journal_entries', 'rollouts',
    'rollout_variants', 'elasticity_fits', 'expected_bands', 'model_runs',
    'rollout_reports'
  ]
  loop
    execute format(
      'drop policy if exists ml_readonly_select on public.%I', t
    );
    execute format(
      'create policy ml_readonly_select on public.%I for select to priceflag_ml_readonly using (true)', t
    );
  end loop;
end
$$;

comment on role priceflag_ml_readonly is
  'Lane C. SELECT only, on the ml_* views and their sources. Cannot read shops.access_token_enc.';
