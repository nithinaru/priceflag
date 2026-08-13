-- Priceflag — persisted price recommendations from the ML lane's optimizer.
-- Contract: contracts/price_recommendation.schema.json (kind='recommendation').
--
-- Suggestions never auto-apply: the merchant always approves (PRD v1.1). Rows
-- exist so /api/recommend and the propose flow's Suggested prefill card can
-- read the freshest constrained suggestion per variant, and so every number is
-- traceable to the model run that made it (R31).

-- ---------------------------------------------------------------------------
-- model_runs.kind gains 'recommendation'
-- ---------------------------------------------------------------------------
alter table public.model_runs
  drop constraint model_runs_kind_check;
alter table public.model_runs
  add constraint model_runs_kind_check
    check (kind in ('elasticity', 'baseline', 'counterfactual', 'report', 'recommendation'));

alter table public.model_runs
  add column if not exists recommendations_written integer not null default 0
    check (recommendations_written >= 0);

-- ---------------------------------------------------------------------------
-- recommendations  — contracts/price_recommendation.schema.json
-- ---------------------------------------------------------------------------
-- `expected` and `constraints` are flattened to typed columns (house style:
-- elasticity_fits keeps every field typed; jsonb is reserved for shapes the
-- database never interprets).
create table public.recommendations (
  id                          uuid primary key default gen_random_uuid(),
  shop_id                     uuid not null references public.shops(id) on delete cascade,
  variant_gid                 text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),

  -- Prices are integer cents, always. current_price_cents is the live price the
  -- optimizer started from; if the storefront price has moved since computed_at
  -- the row is stale and must not be prefilled.
  current_price_cents         integer not null check (current_price_cents >= 1),
  recommended_price_cents     integer not null check (recommended_price_cents >= 1),
  -- Robust optimum: argmax of worst-case profit with elasticity at its
  -- pessimistic credible bound. Shown beside the nominal; agreement = sturdy.
  robust_price_cents          integer not null check (robust_price_cents >= 1),
  rounding                    text not null check (rounding in ('none', 'end_99', 'end_95', 'end_00')),

  elasticity                  numeric(8, 4) not null check (elasticity between -12 and 2),
  elasticity_low              numeric(8, 4) check (elasticity_low between -12 and 2),
  elasticity_high             numeric(8, 4) check (elasticity_high between -12 and 2),
  -- model_version of the elasticity fit the objective was built on (R31).
  fit_model_version           text,
  -- Inherited from the underlying fit after staleness demotion. The propose
  -- flow only prefills fitted/partial; assumption rows exist for audit.
  confidence                  text not null check (confidence in ('fitted', 'partial', 'assumption')),

  -- `expected`: daily deltas at recommended_price_cents, integer cents per day.
  -- The robust profit delta may be negative while the nominal is positive —
  -- that is the honesty the card shows, not a bug.
  nominal_profit_delta_cents_per_day   integer not null,
  robust_profit_delta_cents_per_day    integer not null,
  nominal_revenue_delta_cents_per_day  integer not null,
  robust_revenue_delta_cents_per_day   integer not null,

  -- `constraints`: what bounded the search. binding = which constraints the
  -- nominal optimum is pressed against; '{none}' means it is interior.
  margin_floor_pct            numeric(8, 4) check (margin_floor_pct between 0 and 95),
  max_change_pct              numeric(8, 4) check (max_change_pct > 0 and max_change_pct <= 400),
  inventory_cap_applied       boolean not null default false,
  binding                     text[] not null check (
                                cardinality(binding) >= 1
                                and binding <@ array['margin_floor', 'max_change', 'inventory', 'lattice_edge', 'none']::text[]
                              ),

  candidates_evaluated        integer not null check (candidates_evaluated >= 1),
  baseline_units_per_day      numeric(12, 4) check (baseline_units_per_day >= 0),
  -- Plain-language, merchant-facing. No statistics jargon (R25).
  rationale                   text not null check (char_length(rationale) between 1 and 500),

  model_version               text not null,
  model_run_id                uuid references public.model_runs(id) on delete set null,
  computed_at                 timestamptz not null default now(),
  created_at                  timestamptz not null default now(),

  -- One suggestion per variant per model version; a recompute of the same
  -- version replaces it, a new version lands alongside (freshest wins on read).
  constraint recommendations_key unique (shop_id, variant_gid, model_version),
  constraint recommendations_bounds_ordered check (
    (elasticity_low is null and elasticity_high is null)
    or (elasticity_low is not null and elasticity_high is not null and elasticity_low <= elasticity_high)
  )
);

comment on table public.recommendations is
  'Constrained price suggestions from the optimizer (kind=recommendation). Never auto-applied; read by /api/recommend and the propose prefill. Freshest row per variant wins.';

create index recommendations_lookup_idx
  on public.recommendations (shop_id, variant_gid, computed_at desc);

-- Same posture as every other table: RLS on, no policies. Only the server-side
-- service role reaches this table; anon/authenticated were stripped by the
-- default-privilege revokes in 20260729090700_rls.sql, and the retired
-- priceflag_ml_readonly role gets nothing — the ML lane writes exclusively
-- through pf_ingest_model_run via POST /api/ml/ingest.
alter table public.recommendations enable row level security;
revoke all on public.recommendations from anon, authenticated;
grant select, insert, update, delete on public.recommendations to service_role;

-- ---------------------------------------------------------------------------
-- pf_ingest_model_run gains a recommendations parameter
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE with an extra defaulted argument would leave the old
-- six-argument overload behind and make every defaulted call ambiguous, so the
-- old signature is dropped and recreated atomically in this transaction.
drop function if exists public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb);

create or replace function public.pf_ingest_model_run(
  p_shop_id uuid,
  p_ingest_key text,
  p_run jsonb,
  p_fits jsonb default '[]'::jsonb,
  p_bands jsonb default '[]'::jsonb,
  p_reports jsonb default '[]'::jsonb,
  p_recommendations jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_existing public.model_runs%rowtype;
  v_fits integer := 0;
  v_bands integer := 0;
  v_reports integer := 0;
  v_recommendations integer := 0;
  v_total integer := 0;
begin
  if p_ingest_key is null or length(p_ingest_key) <> 64 or p_ingest_key !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid ingest key' using errcode = '22023';
  end if;
  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'unknown shop' using errcode = '23503';
  end if;
  if coalesce((p_run->>'gate_passed')::boolean, false) is not true then
    raise exception 'atomic ingest requires a passed gate' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_fits, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_bands, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_reports, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_recommendations, '[]'::jsonb)) <> 'array' then
    raise exception 'fits, bands, reports and recommendations must be arrays' using errcode = '22023';
  end if;

  -- Serializes identical retries, including two requests racing before either
  -- has inserted its model_runs row.
  perform pg_advisory_xact_lock(hashtextextended(p_ingest_key, 0));
  select * into v_existing
  from public.model_runs
  where ingest_key = p_ingest_key;

  if found then
    if v_existing.shop_id is distinct from p_shop_id or v_existing.status <> 'succeeded' then
      raise exception 'ingest key already belongs to a different or incomplete run' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'model_run_id', v_existing.id,
      'fits_written', v_existing.fits_written,
      'bands_written', v_existing.bands_written,
      'reports_written', v_existing.reports_written,
      'recommendations_written', v_existing.recommendations_written,
      'rows_written', v_existing.rows_written,
      'deduplicated', true
    );
  end if;

  insert into public.model_runs (
    shop_id, kind, model_version, git_sha, status, gate_passed,
    incumbent_version, metrics, rows_written, ingest_key, notes
  ) values (
    p_shop_id,
    p_run->>'kind',
    p_run->>'model_version',
    nullif(p_run->>'git_sha', ''),
    'running',
    true,
    nullif(p_run->>'incumbent_version', ''),
    coalesce(p_run->'metrics', '{}'::jsonb),
    0,
    p_ingest_key,
    nullif(p_run->>'notes', '')
  ) returning id into v_run_id;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_fits, '[]'::jsonb)) fit
    where not exists (
      select 1 from public.products product
      where product.shop_id = p_shop_id
        and product.variant_gid = fit->>'variant_gid'
    )
  ) then
    raise exception 'fit variant is not owned by the ingest shop' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_bands, '[]'::jsonb)) band
    where not exists (
      select 1 from public.products product
      where product.shop_id = p_shop_id
        and product.variant_gid = band->>'variant_gid'
    )
  ) then
    raise exception 'band variant is not owned by the ingest shop' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_recommendations, '[]'::jsonb)) rec
    where not exists (
      select 1 from public.products product
      where product.shop_id = p_shop_id
        and product.variant_gid = rec->>'variant_gid'
    )
  ) then
    raise exception 'recommendation variant is not owned by the ingest shop' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_bands, '[]'::jsonb)) band
    where
      (band->>'band_kind' = 'baseline' and band->'rollout_id' is not null and band->'rollout_id' <> 'null'::jsonb)
      or
      (
        band->>'band_kind' = 'counterfactual'
        and (
          band->'rollout_id' is null
          or band->'rollout_id' = 'null'::jsonb
          or not exists (
            select 1 from public.rollouts rollout
            where rollout.id = (band->>'rollout_id')::uuid
              and rollout.shop_id = p_shop_id
          )
        )
      )
  ) then
    raise exception 'band rollout scope is invalid for the ingest shop' using errcode = '42501';
  end if;

  insert into public.elasticity_fits (
    shop_id, variant_gid, elasticity, se, low, high, interval_nominal,
    n_obs, price_variation_pct, confidence, confidence_explanation, method,
    shrinkage_weight, prior_elasticity, r2, model_version, model_run_id,
    window_start, window_end, fitted_at
  )
  select
    p_shop_id, x.variant_gid, x.elasticity, x.se, x.low, x.high, x.interval_nominal,
    x.n_obs, x.price_variation_pct, x.confidence, x.confidence_explanation, x.method,
    x.shrinkage_weight, x.prior_elasticity, x.r2, x.model_version, v_run_id,
    x.window_start, x.window_end, x.fitted_at
  from jsonb_to_recordset(coalesce(p_fits, '[]'::jsonb)) as x(
    variant_gid text, elasticity numeric, se numeric, low numeric, high numeric,
    interval_nominal numeric, n_obs integer, price_variation_pct numeric,
    confidence text, confidence_explanation text, method text,
    shrinkage_weight numeric, prior_elasticity numeric, r2 numeric,
    model_version text, window_start date, window_end date, fitted_at timestamptz
  )
  on conflict on constraint elasticity_fits_key do update set
    elasticity = excluded.elasticity,
    se = excluded.se,
    low = excluded.low,
    high = excluded.high,
    interval_nominal = excluded.interval_nominal,
    n_obs = excluded.n_obs,
    price_variation_pct = excluded.price_variation_pct,
    confidence = excluded.confidence,
    confidence_explanation = excluded.confidence_explanation,
    method = excluded.method,
    shrinkage_weight = excluded.shrinkage_weight,
    prior_elasticity = excluded.prior_elasticity,
    r2 = excluded.r2,
    model_run_id = excluded.model_run_id,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    fitted_at = excluded.fitted_at;
  get diagnostics v_fits = row_count;

  insert into public.expected_bands (
    shop_id, variant_gid, day, expected_units, low, high, interval_nominal,
    band_kind, rollout_id, breach_probability, is_floored, model_version,
    model_run_id, generated_at
  )
  select
    p_shop_id, x.variant_gid, x.day, x.expected_units, x.low, x.high,
    x.interval_nominal, x.band_kind, x.rollout_id, x.breach_probability,
    coalesce(x.is_floored, false), x.model_version, v_run_id, x.generated_at
  from jsonb_to_recordset(coalesce(p_bands, '[]'::jsonb)) as x(
    variant_gid text, day date, expected_units numeric, low numeric, high numeric,
    interval_nominal numeric, band_kind text, rollout_id uuid,
    breach_probability numeric, is_floored boolean, model_version text,
    generated_at timestamptz
  )
  on conflict (
    shop_id, variant_gid, day, band_kind, model_version,
    (coalesce(rollout_id, '00000000-0000-0000-0000-000000000000'::uuid))
  ) do update set
    expected_units = excluded.expected_units,
    low = excluded.low,
    high = excluded.high,
    interval_nominal = excluded.interval_nominal,
    breach_probability = excluded.breach_probability,
    is_floored = excluded.is_floored,
    model_run_id = excluded.model_run_id,
    generated_at = excluded.generated_at;
  get diagnostics v_bands = row_count;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_reports, '[]'::jsonb)) report
    where not exists (
      select 1 from public.rollouts rollout
      where rollout.id = (report->>'rollout_id')::uuid
        and rollout.shop_id = p_shop_id
    )
  ) then
    raise exception 'report rollout is not owned by the ingest shop' using errcode = '42501';
  end if;

  insert into public.rollout_reports (
    rollout_id, shop_id, window_start, window_end, window_days, predicted,
    realized, in_range, elasticity_before, elasticity_after,
    elasticity_update, narrative, per_variant, model_version, model_run_id,
    generated_at
  )
  select
    (report->>'rollout_id')::uuid,
    p_shop_id,
    (report->'window'->>'start_day')::date,
    (report->'window'->>'end_day')::date,
    (report->'window'->>'days')::integer,
    report->'predicted',
    report->'realized',
    (report->>'in_range')::boolean,
    case when report->'elasticity_update' is null or report->'elasticity_update' = 'null'::jsonb
      then null else (report->'elasticity_update'->>'before')::numeric end,
    case when report->'elasticity_update' is null or report->'elasticity_update' = 'null'::jsonb
      then null else (report->'elasticity_update'->>'after')::numeric end,
    report->'elasticity_update',
    report->>'narrative',
    coalesce(report->'per_variant', '[]'::jsonb),
    report->>'model_version',
    v_run_id,
    (report->>'generated_at')::timestamptz
  from jsonb_array_elements(coalesce(p_reports, '[]'::jsonb)) report
  on conflict on constraint rollout_reports_key do update set
    shop_id = excluded.shop_id,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    predicted = excluded.predicted,
    realized = excluded.realized,
    in_range = excluded.in_range,
    elasticity_before = excluded.elasticity_before,
    elasticity_after = excluded.elasticity_after,
    elasticity_update = excluded.elasticity_update,
    narrative = excluded.narrative,
    per_variant = excluded.per_variant,
    model_run_id = excluded.model_run_id,
    generated_at = excluded.generated_at;
  get diagnostics v_reports = row_count;

  -- Recommendations arrive contract-shaped (price_recommendation.schema.json)
  -- with nested `expected` and `constraints`; they are flattened here.
  insert into public.recommendations (
    shop_id, variant_gid, current_price_cents, recommended_price_cents,
    robust_price_cents, rounding, elasticity, elasticity_low, elasticity_high,
    fit_model_version, confidence,
    nominal_profit_delta_cents_per_day, robust_profit_delta_cents_per_day,
    nominal_revenue_delta_cents_per_day, robust_revenue_delta_cents_per_day,
    margin_floor_pct, max_change_pct, inventory_cap_applied, binding,
    candidates_evaluated, baseline_units_per_day, rationale,
    model_version, model_run_id, computed_at
  )
  select
    p_shop_id,
    rec->>'variant_gid',
    (rec->>'current_price_cents')::integer,
    (rec->>'recommended_price_cents')::integer,
    (rec->>'robust_price_cents')::integer,
    rec->>'rounding',
    (rec->>'elasticity')::numeric,
    (rec->>'elasticity_low')::numeric,
    (rec->>'elasticity_high')::numeric,
    nullif(rec->>'fit_model_version', ''),
    rec->>'confidence',
    (rec->'expected'->>'nominal_profit_delta_cents_per_day')::integer,
    (rec->'expected'->>'robust_profit_delta_cents_per_day')::integer,
    (rec->'expected'->>'nominal_revenue_delta_cents_per_day')::integer,
    (rec->'expected'->>'robust_revenue_delta_cents_per_day')::integer,
    (rec->'constraints'->>'margin_floor_pct')::numeric,
    (rec->'constraints'->>'max_change_pct')::numeric,
    coalesce((rec->'constraints'->>'inventory_cap_applied')::boolean, false),
    (select array_agg(bound.value)
       from jsonb_array_elements_text(rec->'constraints'->'binding') bound),
    (rec->>'candidates_evaluated')::integer,
    (rec->>'baseline_units_per_day')::numeric,
    rec->>'rationale',
    rec->>'model_version',
    v_run_id,
    (rec->>'computed_at')::timestamptz
  from jsonb_array_elements(coalesce(p_recommendations, '[]'::jsonb)) rec
  on conflict on constraint recommendations_key do update set
    current_price_cents = excluded.current_price_cents,
    recommended_price_cents = excluded.recommended_price_cents,
    robust_price_cents = excluded.robust_price_cents,
    rounding = excluded.rounding,
    elasticity = excluded.elasticity,
    elasticity_low = excluded.elasticity_low,
    elasticity_high = excluded.elasticity_high,
    fit_model_version = excluded.fit_model_version,
    confidence = excluded.confidence,
    nominal_profit_delta_cents_per_day = excluded.nominal_profit_delta_cents_per_day,
    robust_profit_delta_cents_per_day = excluded.robust_profit_delta_cents_per_day,
    nominal_revenue_delta_cents_per_day = excluded.nominal_revenue_delta_cents_per_day,
    robust_revenue_delta_cents_per_day = excluded.robust_revenue_delta_cents_per_day,
    margin_floor_pct = excluded.margin_floor_pct,
    max_change_pct = excluded.max_change_pct,
    inventory_cap_applied = excluded.inventory_cap_applied,
    binding = excluded.binding,
    candidates_evaluated = excluded.candidates_evaluated,
    baseline_units_per_day = excluded.baseline_units_per_day,
    rationale = excluded.rationale,
    model_run_id = excluded.model_run_id,
    computed_at = excluded.computed_at;
  get diagnostics v_recommendations = row_count;

  v_total := v_fits + v_bands + v_reports + v_recommendations;
  update public.model_runs set
    status = 'succeeded',
    fits_written = v_fits,
    bands_written = v_bands,
    reports_written = v_reports,
    recommendations_written = v_recommendations,
    rows_written = v_total,
    finished_at = now()
  where id = v_run_id;

  return jsonb_build_object(
    'model_run_id', v_run_id,
    'fits_written', v_fits,
    'bands_written', v_bands,
    'reports_written', v_reports,
    'recommendations_written', v_recommendations,
    'rows_written', v_total,
    'deduplicated', false
  );
end;
$$;

comment on function public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb) is
  'Atomically validates tenant ownership at the database boundary and upserts one idempotent model-output request (fits, bands, reports, recommendations).';

revoke all on function public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, priceflag_ml_readonly;
grant execute on function public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;
