-- Preserve the two different baselines the evaluator needs:
--
--   counterfactual_*  what the live SKUs would have produced at their old price
--   expected_*        what they should produce after the approved price effect
--
-- Keeping these cent-exact daily values prevents reports and historical
-- guardrail streaks from reconstructing heterogeneous SKU mixes with an average
-- price. Columns are nullable only for readings written by older deployments.

alter table public.rollout_readings
  add column counterfactual_units numeric(12, 4)
    check (counterfactual_units is null or counterfactual_units >= 0),
  add column counterfactual_revenue_cents bigint
    check (counterfactual_revenue_cents is null or counterfactual_revenue_cents >= 0),
  add column counterfactual_profit_cents bigint,
  add column expected_revenue_cents bigint
    check (expected_revenue_cents is null or expected_revenue_cents >= 0),
  add column expected_profit_cents bigint,
  add column expected_revenue_low_cents bigint
    check (expected_revenue_low_cents is null or expected_revenue_low_cents >= 0),
  add column expected_revenue_high_cents bigint
    check (expected_revenue_high_cents is null or expected_revenue_high_cents >= 0),
  add column expected_profit_low_cents bigint,
  add column expected_profit_high_cents bigint,
  add constraint rollout_readings_revenue_band_ordered check (
    expected_revenue_low_cents is null
    or (
      expected_revenue_cents is not null
      and expected_revenue_high_cents is not null
      and expected_revenue_low_cents <= expected_revenue_cents
      and expected_revenue_cents <= expected_revenue_high_cents
    )
  ),
  add constraint rollout_readings_profit_band_ordered check (
    expected_profit_low_cents is null
    or (
      expected_profit_cents is not null
      and expected_profit_high_cents is not null
      and expected_profit_low_cents <= expected_profit_cents
      and expected_profit_cents <= expected_profit_high_cents
    )
  );

comment on column public.rollout_readings.counterfactual_units is
  'No-price-change expected units for the exact variants live in this reading stage.';
comment on column public.rollout_readings.counterfactual_revenue_cents is
  'No-price-change expected revenue, summed per SKU at frozen baseline prices and forecast-frozen discount realization.';
comment on column public.rollout_readings.counterfactual_profit_cents is
  'No-price-change expected gross profit, null if any live SKU lacks frozen COGS.';
comment on column public.rollout_readings.expected_revenue_cents is
  'Price-conditioned expected revenue, summed per SKU at live target prices.';
comment on column public.rollout_readings.expected_profit_cents is
  'Price-conditioned expected gross profit, null if any live SKU lacks frozen COGS.';
comment on column public.rollout_readings.expected_revenue_low_cents is
  'Conservative per-SKU lower revenue edge for metric-specific guardrails.';
comment on column public.rollout_readings.expected_revenue_high_cents is
  'Conservative per-SKU upper revenue edge for metric-specific guardrails.';
comment on column public.rollout_readings.expected_profit_low_cents is
  'Conservative per-SKU lower profit edge, null if any live SKU lacks frozen COGS.';
comment on column public.rollout_readings.expected_profit_high_cents is
  'Conservative per-SKU upper profit edge, null if any live SKU lacks frozen COGS.';

create sequence public.rollout_creation_sequence_seq;

-- Add the column *before* its default. Existing rows deliberately remain null:
-- assigning sequence values in heap order would invent chronology for legacy
-- rows whose created_at timestamps tie. New rows receive a durable total order.
alter table public.rollouts
  add column creation_sequence bigint unique;

alter table public.rollouts
  alter column creation_sequence
  set default nextval('public.rollout_creation_sequence_seq'::regclass);

alter sequence public.rollout_creation_sequence_seq
  owned by public.rollouts.creation_sequence;

revoke all on sequence public.rollout_creation_sequence_seq
  from public, anon, authenticated, priceflag_ml_readonly;
grant usage, select on sequence public.rollout_creation_sequence_seq to service_role;

comment on column public.rollouts.creation_sequence is
  'Durable total-order tie-breaker for new chained rollouts. Null on legacy rows so tied timestamps fail closed.';
