-- Priceflag — model registry, fits, bands, reports. Lane C writes these;
-- Lane B's forecast endpoint and evaluator read them.
--
-- R31: every number a merchant sees is traceable to the model run that made it.
-- R28: a run that loses to the incumbent on the eval harness is RECORDED with
-- status='rejected' and writes no fits. Failing loudly beats shipping a worse
-- model, because these bands drive auto-rollback.

-- ---------------------------------------------------------------------------
-- model_runs
-- ---------------------------------------------------------------------------
create table public.model_runs (
  id                uuid primary key default gen_random_uuid(),
  -- null for global/portfolio runs that span shops.
  shop_id           uuid references public.shops(id) on delete cascade,
  kind              text not null check (kind in ('elasticity', 'baseline', 'counterfactual', 'report')),
  model_version     text not null,
  git_sha           text,

  status            text not null default 'running'
                      check (status in ('running', 'succeeded', 'failed', 'rejected')),
  -- R28 honesty gate. false with status='rejected' means the challenger lost to
  -- the incumbent and was not deployed.
  gate_passed       boolean,
  incumbent_version text,

  -- Whatever the harness measured: elasticity recovery error, interval
  -- coverage, pinball loss, backtest MAPE vs seasonal-naive.
  metrics           jsonb not null default '{}'::jsonb,
  rows_written      integer not null default 0,
  notes             text,
  error             text,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.model_runs is
  'Model registry (R31). Rejected challengers are kept: the record of what did not work is part of the honesty story.';

create index model_runs_kind_started_idx on public.model_runs (kind, started_at desc);
create index model_runs_shop_kind_idx on public.model_runs (shop_id, kind, started_at desc);
create index model_runs_version_idx on public.model_runs (model_version);

-- ---------------------------------------------------------------------------
-- elasticity_fits  — contracts/elasticity_fit.schema.json
-- ---------------------------------------------------------------------------
create table public.elasticity_fits (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  variant_gid         text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),

  elasticity          numeric(8, 4) not null check (elasticity between -12 and 2),
  se                  numeric(8, 4) check (se >= 0),
  n_obs               integer not null default 0 check (n_obs >= 0),
  price_variation_pct numeric(8, 4) not null default 0 check (price_variation_pct >= 0),

  confidence          text not null check (confidence in ('fitted', 'partial', 'assumption')),
  confidence_explanation text,
  method              text,
  shrinkage_weight    numeric(5, 4) check (shrinkage_weight between 0 and 1),
  prior_elasticity    numeric(8, 4),
  r2                  numeric(6, 4),

  model_version       text not null,
  model_run_id        uuid references public.model_runs(id) on delete set null,
  window_start        date,
  window_end          date,
  fitted_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  -- One fit per variant per model version; a refit of the same version replaces
  -- it, a new version lands alongside so we can compare champions.
  constraint elasticity_fits_key unique (shop_id, variant_gid, model_version)
);

comment on table public.elasticity_fits is
  'Per-variant price elasticity from Lane C. `confidence` is the model being honest about its own data; Lane B demotes to bracket math on `assumption` or staleness (R32).';

create index elasticity_fits_lookup_idx on public.elasticity_fits (shop_id, variant_gid, fitted_at desc);

-- ---------------------------------------------------------------------------
-- expected_bands  — contracts/expected_band.schema.json
-- ---------------------------------------------------------------------------
-- The band's calibration is a SAFETY property: it decides auto-rollback (R29).
create table public.expected_bands (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  variant_gid        text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),
  day                date not null,

  expected_units     numeric(12, 4) not null check (expected_units >= 0),
  low                numeric(12, 4) not null check (low >= 0),
  high               numeric(12, 4) not null check (high >= 0),
  interval_nominal   numeric(4, 3) not null default 0.800
                       check (interval_nominal > 0 and interval_nominal < 1),

  band_kind          text not null default 'baseline'
                       check (band_kind in ('baseline', 'counterfactual')),
  rollout_id         uuid references public.rollouts(id) on delete cascade,
  breach_probability numeric(5, 4) check (breach_probability between 0 and 1),
  is_floored         boolean not null default false,

  model_version      text not null,
  model_run_id       uuid references public.model_runs(id) on delete set null,
  generated_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),

  constraint expected_bands_ordered check (low <= expected_units and expected_units <= high),
  -- A counterfactual band is only meaningful for a specific rollout.
  constraint expected_bands_counterfactual_scoped check (
    (band_kind = 'counterfactual') = (rollout_id is not null)
  )
);

comment on table public.expected_bands is
  'Expected units per variant per day with no price change, plus an honest interval. Consumed by the evaluator; `is_floored` marks low-volume widening.';

-- A refit for the same (variant, day, kind, version) replaces the old row.
-- rollout_id is coalesced because NULLs are distinct in a unique index, which
-- would let duplicate baseline bands accumulate. Writers using raw SQL must
-- repeat the expression in their ON CONFLICT target — see contracts/db/schema.md.
create unique index expected_bands_key
  on public.expected_bands (
    shop_id,
    variant_gid,
    day,
    band_kind,
    model_version,
    (coalesce(rollout_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );
create index expected_bands_lookup_idx on public.expected_bands (shop_id, day, variant_gid);
create index expected_bands_rollout_idx on public.expected_bands (rollout_id, day) where rollout_id is not null;

-- ---------------------------------------------------------------------------
-- rollout_reports  — contracts/rollout_report.schema.json (C6, R20, R30)
-- ---------------------------------------------------------------------------
create table public.rollout_reports (
  id                uuid primary key default gen_random_uuid(),
  rollout_id        uuid not null references public.rollouts(id) on delete cascade,
  shop_id           uuid not null references public.shops(id) on delete cascade,

  window_start      date not null,
  window_end        date not null,
  window_days       integer not null default 30 check (window_days >= 1),

  predicted         jsonb not null,
  realized          jsonb not null,
  -- The PRD's honesty metric (R30): did realized profit land in the predicted
  -- range? Aggregated across rollouts this is the calibration number.
  in_range          boolean not null,
  elasticity_before numeric(8, 4),
  elasticity_after  numeric(8, 4),
  narrative         text not null,
  per_variant       jsonb not null default '[]'::jsonb,

  model_version     text not null,
  model_run_id      uuid references public.model_runs(id) on delete set null,
  generated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),

  constraint rollout_reports_key unique (rollout_id, window_days, model_version)
);

comment on table public.rollout_reports is
  'Realized vs predicted after a rollout completes. The retention loop, and the calibration metric that the PRD calls the moat.';

create index rollout_reports_shop_generated_idx on public.rollout_reports (shop_id, generated_at desc);
