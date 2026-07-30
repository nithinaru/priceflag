-- Priceflag — extensions and shared helpers.
--
-- Ground rules encoded here and enforced by every table that follows:
--   * money is integer cents, never numeric/float (a single price fits in int4;
--     aggregates that can exceed ~$21M use int8)
--   * percentages are stored as plain numbers where 12.5 means 12.5%
--   * a `day` column is a calendar date in the SHOP's timezone, not UTC
--   * every mutable table carries created_at/updated_at, maintained by trigger

create extension if not exists pgcrypto;

-- Keeps updated_at honest without every writer remembering to set it.
create or replace function public.pf_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.pf_touch_updated_at is
  'BEFORE UPDATE trigger: maintains updated_at.';

-- Shop-timezone calendar day for a timestamp. The evaluator and every daily
-- aggregate use this so "yesterday" means yesterday for the merchant, not UTC.
create or replace function public.pf_shop_day(ts timestamptz, tz text)
returns date
language sql
-- STABLE, not IMMUTABLE: `at time zone` depends on the timezone database.
stable
as $$
  select (ts at time zone coalesce(nullif(tz, ''), 'UTC'))::date;
$$;

comment on function public.pf_shop_day is
  'Calendar day of ts in the shop timezone tz (IANA). Falls back to UTC.';
