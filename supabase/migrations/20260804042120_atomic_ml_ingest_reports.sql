-- Atomic and idempotent model-output ingest. The ML runner remains read-only;
-- only the server-side service role may call this function.

alter table public.model_runs
  add column if not exists ingest_key text,
  add column if not exists fits_written integer not null default 0 check (fits_written >= 0),
  add column if not exists bands_written integer not null default 0 check (bands_written >= 0),
  add column if not exists reports_written integer not null default 0 check (reports_written >= 0);

create unique index if not exists model_runs_ingest_key_unique
  on public.model_runs (ingest_key)
  where ingest_key is not null;

alter table public.rollout_reports
  add column if not exists elasticity_update jsonb;

create or replace function public.pf_ingest_model_run(
  p_shop_id uuid,
  p_ingest_key text,
  p_run jsonb,
  p_fits jsonb default '[]'::jsonb,
  p_bands jsonb default '[]'::jsonb,
  p_reports jsonb default '[]'::jsonb
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
     or jsonb_typeof(coalesce(p_reports, '[]'::jsonb)) <> 'array' then
    raise exception 'fits, bands and reports must be arrays' using errcode = '22023';
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

  v_total := v_fits + v_bands + v_reports;
  update public.model_runs set
    status = 'succeeded',
    fits_written = v_fits,
    bands_written = v_bands,
    reports_written = v_reports,
    rows_written = v_total,
    finished_at = now()
  where id = v_run_id;

  return jsonb_build_object(
    'model_run_id', v_run_id,
    'fits_written', v_fits,
    'bands_written', v_bands,
    'reports_written', v_reports,
    'rows_written', v_total,
    'deduplicated', false
  );
end;
$$;

comment on function public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb) is
  'Atomically validates tenant ownership at the database boundary and upserts one idempotent model-output request.';

revoke all on function public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, priceflag_ml_readonly;
grant execute on function public.pf_ingest_model_run(uuid, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;
