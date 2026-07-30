-- Priceflag — rollouts, the per-variant baselines that make them reversible,
-- daily readings, and the event log.

-- ---------------------------------------------------------------------------
-- rollouts
-- ---------------------------------------------------------------------------
create table public.rollouts (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  name                text not null,

  status              text not null default 'draft'
                        check (status in ('draft', 'scheduled', 'running', 'paused',
                                          'completed', 'rolled_back', 'cancelled')),

  change_type         text not null check (change_type in ('percent', 'absolute')),
  -- 12.5 means +12.5%. Negative is a cut.
  change_pct          numeric(7, 3),
  change_absolute_cents integer,
  rounding            text not null default 'none'
                        check (rounding in ('none', 'end_99', 'end_95', 'end_00')),
  horizon_days        integer not null default 90 check (horizon_days between 7 and 365),

  -- Immutable once the rollout starts: [{ "index": 0, "fraction": 0.25, "hold_days": 3 }, …]
  -- Cumulative fractions of the SELECTION (never of traffic — prices never vary
  -- by visitor). A single-variant selection collapses to a time canary.
  stages              jsonb not null,
  -- -1 = nothing live yet. Otherwise the 0-based index of the live stage.
  current_stage       integer not null default -1 check (current_stage >= -1),
  stage_entered_at    timestamptz,

  -- contracts/guardrails.schema.json, frozen at proposal time (R10). Stored as
  -- the merchant agreed to it, including the sentence they read.
  guardrails          jsonb not null default '{"contract_version":"1.0.0","auto_rollback":true,"rules":[]}'::jsonb,
  -- contracts/forecast_result.schema.json as of proposal time, so the
  -- post-rollout report compares against what was actually promised (R20/R30).
  forecast            jsonb,

  scheduled_start_at  timestamptz,
  started_at          timestamptz,
  ended_at            timestamptz,
  ended_reason        text check (ended_reason in ('completed', 'guardrail_breach',
                                                   'manual_rollback', 'kill_switch',
                                                   'external_change', 'cancelled')),
  paused_reason       text,
  notify_emails       text[] not null default '{}',

  -- Evaluator lease. NOT pg_advisory_lock: Supabase pools connections, so a
  -- session-level lock cannot be held across HTTP calls and a transaction-level
  -- one dies at statement end. A row lease with a TTL is pooler-safe and
  -- survives a crashed evaluator (see pf_acquire_rollout_lock below).
  eval_lock_token     uuid,
  eval_locked_until   timestamptz,
  last_evaluated_at   timestamptz,
  last_evaluated_day  date,

  created_by          text not null default 'merchant',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint rollouts_change_shape check (
    (change_type = 'percent'  and change_pct is not null and change_absolute_cents is null) or
    (change_type = 'absolute' and change_absolute_cents is not null and change_pct is null)
  ),
  constraint rollouts_ended_shape check (
    (status in ('completed', 'rolled_back', 'cancelled')) = (ended_at is not null)
  )
);

comment on table public.rollouts is
  'One staged price change. `stages` and `guardrails` are immutable after start; `forecast` preserves what was predicted so the report can be honest about it.';
comment on column public.rollouts.stages is
  'Cumulative fractions of the SKU selection, never of traffic. [{index,fraction,hold_days}].';

create index rollouts_shop_status_idx on public.rollouts (shop_id, status);
create index rollouts_active_idx on public.rollouts (status)
  where status in ('running', 'paused', 'scheduled');

create trigger rollouts_touch before update on public.rollouts
  for each row execute function public.pf_touch_updated_at();

-- ---------------------------------------------------------------------------
-- rollout_variants  — the reason a rollback is always correct
-- ---------------------------------------------------------------------------
-- Prices captured here at CREATION time are the single source of truth for
-- rollback (R12). Never recompute a baseline from live Shopify data: by the time
-- you need it, the live price is the changed one.
create table public.rollout_variants (
  id                       uuid primary key default gen_random_uuid(),
  rollout_id               uuid not null references public.rollouts(id) on delete cascade,
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  variant_gid              text not null check (variant_gid like 'gid://shopify/ProductVariant/%'),
  product_gid              text not null,
  title                    text not null default '',
  sku                      text,

  baseline_price_cents     integer not null check (baseline_price_cents >= 0),
  baseline_compare_at_cents integer check (baseline_compare_at_cents >= 0),
  target_price_cents       integer not null check (target_price_cents >= 0),
  -- R13 compare-at policy, decided once at creation: keep it on a decrease,
  -- clear it when the new price meets or passes it (never a fake discount).
  target_compare_at_cents  integer check (target_compare_at_cents >= 0),
  compare_at_action        text not null default 'none'
                             check (compare_at_action in ('keep', 'clear', 'none')),

  baseline_units_per_day   numeric(12, 4),
  cogs_cents_at_creation   integer check (cogs_cents_at_creation >= 0),

  -- Stage index at which this variant flips to the new price. Deterministic
  -- from a hash of the variant gid + rollout id, so cohorts are stable and
  -- reproducible. Stage k means "live from stage k onward".
  cohort_stage             integer not null check (cohort_stage >= 0),

  applied_price_cents      integer check (applied_price_cents >= 0),
  applied_at               timestamptz,
  reverted_at              timestamptz,
  excluded                 boolean not null default false,
  exclusion_reason         text check (exclusion_reason in ('gift_card', 'subscription',
                                                            'not_active', 'zero_price', 'external_change')),

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint rollout_variants_key unique (rollout_id, variant_gid)
);

comment on table public.rollout_variants is
  'Selection + pre-rollout baselines. baseline_price_cents is the authority for every rollback (R12).';

create index rollout_variants_rollout_stage_idx on public.rollout_variants (rollout_id, cohort_stage);
create index rollout_variants_shop_variant_idx on public.rollout_variants (shop_id, variant_gid);

create trigger rollout_variants_touch before update on public.rollout_variants
  for each row execute function public.pf_touch_updated_at();

-- ---------------------------------------------------------------------------
-- rollout_readings  — one row per rollout per day. Idempotency lives here.
-- ---------------------------------------------------------------------------
create table public.rollout_readings (
  id                uuid primary key default gen_random_uuid(),
  rollout_id        uuid not null references public.rollouts(id) on delete cascade,
  shop_id           uuid not null references public.shops(id) on delete cascade,
  day               date not null,
  stage_index       integer not null,

  actual_units      integer not null default 0 check (actual_units >= 0),
  actual_orders     integer not null default 0 check (actual_orders >= 0),
  actual_revenue_cents bigint not null default 0,
  -- null when any affected variant has no COGS: profit is unknown, not zero.
  actual_profit_cents  bigint,

  expected_units    numeric(12, 4) not null,
  expected_low      numeric(12, 4) not null,
  expected_high     numeric(12, 4) not null,
  expected_source   text not null check (expected_source in ('model', 'bracket')),
  interval_nominal  numeric(4, 3) not null default 0.800,
  model_version     text,
  band_stale        boolean not null default false,
  band_floored      boolean not null default false,
  breach_probability numeric(5, 4) check (breach_probability between 0 and 1),

  breach            boolean not null default false,
  breach_rule_id    text,
  breach_reason     text,
  breach_streak     integer not null default 0 check (breach_streak >= 0),

  decision          text not null default 'none'
                      check (decision in ('none', 'hold', 'advance', 'rollback', 'pause', 'complete')),
  evaluated_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),

  -- The evaluator is idempotent per (rollout, day): a second run on the same
  -- day updates this row instead of double-counting or double-advancing.
  constraint rollout_readings_key unique (rollout_id, day),
  constraint rollout_readings_band_ordered check (expected_low <= expected_units and expected_units <= expected_high)
);

comment on table public.rollout_readings is
  'Daily actual-vs-expected for a rollout. UNIQUE(rollout_id, day) is what makes the evaluator idempotent (R15).';

create index rollout_readings_rollout_day_idx on public.rollout_readings (rollout_id, day desc);

-- ---------------------------------------------------------------------------
-- rollout_events  — the plain-language log the merchant reads (R16)
-- ---------------------------------------------------------------------------
create table public.rollout_events (
  id         uuid primary key default gen_random_uuid(),
  rollout_id uuid not null references public.rollouts(id) on delete cascade,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  type       text not null check (type in (
               'created', 'scheduled', 'started', 'stage_advanced', 'held',
               'breach_detected', 'auto_rollback', 'manual_rollback', 'kill_switch',
               'paused_external_change', 'resumed', 'completed', 'cancelled',
               'price_write_failed', 'evaluated', 'note'
             )),
  -- One sentence, merchant-facing, no jargon (R25).
  message    text not null,
  actor      text not null default 'system'
               check (actor in ('priceflag', 'merchant', 'shopify_admin', 'system')),
  data       jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.rollout_events is
  'Append-only timeline. `message` is written for a merchant to read, not for a log grep.';

create index rollout_events_rollout_at_idx on public.rollout_events (rollout_id, at desc);

-- ---------------------------------------------------------------------------
-- Evaluator lease (pooler-safe advisory locking)
-- ---------------------------------------------------------------------------
create or replace function public.pf_acquire_rollout_lock(
  p_rollout_id uuid,
  p_token uuid,
  p_ttl_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.rollouts
     set eval_lock_token   = p_token,
         eval_locked_until = now() + make_interval(secs => p_ttl_seconds)
   where id = p_rollout_id
     and (eval_locked_until is null or eval_locked_until < now())
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function public.pf_acquire_rollout_lock is
  'Atomic lease acquire. Returns false when another evaluator holds the lease. TTL means a crashed evaluator self-heals.';

create or replace function public.pf_release_rollout_lock(
  p_rollout_id uuid,
  p_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  -- Token check: a stale holder whose lease already expired cannot release the
  -- lock out from under the evaluator that took over.
  update public.rollouts
     set eval_lock_token = null,
         eval_locked_until = null
   where id = p_rollout_id
     and eval_lock_token = p_token
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

revoke all on function public.pf_acquire_rollout_lock(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.pf_release_rollout_lock(uuid, uuid) from public, anon, authenticated;
