-- Priceflag — row level security.
--
-- Posture: RLS is ON for every table and there are NO policies. Nothing reaches
-- these tables except the service role (which bypasses RLS), and the service
-- role key never leaves the server — every read and write goes through a route
-- handler in app/api/** that has already resolved and scoped the shop.
--
-- The alternative (policies keyed on a Supabase auth user) would be dead code
-- in v1: the merchant authenticates to Shopify, not to Supabase, so there is no
-- auth.uid() to key on. When session-token auth arrives in Sprint B2 the shop
-- scoping still happens in the route handler, and tokens live in shops.
--
-- Consequence to remember: an unscoped query in a route handler is not caught
-- by the database. Shop scoping is a code review item, and every adapter method
-- takes a shop_id for exactly this reason.

alter table public.shops             enable row level security;
alter table public.products          enable row level security;
alter table public.sync_runs         enable row level security;
alter table public.order_days        enable row level security;
alter table public.rollouts          enable row level security;
alter table public.rollout_variants  enable row level security;
alter table public.rollout_readings  enable row level security;
alter table public.rollout_events    enable row level security;
alter table public.journal_entries   enable row level security;
alter table public.webhook_events    enable row level security;
alter table public.model_runs        enable row level security;
alter table public.elasticity_fits   enable row level security;
alter table public.expected_bands    enable row level security;
alter table public.rollout_reports   enable row level security;

-- Belt and braces: even with RLS on, do not hand the public roles table
-- privileges. Supabase grants these by default to anon/authenticated.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Nothing created later should silently become readable by anon either.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Belongs to journal_entries but stated here with the rest of the safety
-- posture: the price audit trail is append-only. It is the manual recovery path
-- when everything else has failed, so a bug that rewrites history is worse than
-- a bug that loses a feature.
--
-- UPDATE is never allowed. DELETE is allowed only inside an explicit purge:
--   set local priceflag.purge = 'on';
--   delete from shops where shop_domain = '…';   -- cascades
-- which exists for the GDPR shop/redact topic (R23). Uninstall does NOT purge —
-- it clears the token and stamps uninstalled_at, so a reinstalling merchant
-- keeps their price history.
create or replace function public.pf_journal_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('priceflag.purge', true), 'off') = 'on' then
    return old;
  end if;
  raise exception 'journal_entries is append-only (attempted %)', tg_op
    using hint = 'For a GDPR purge: set local priceflag.purge = ''on'' in the same transaction.';
end;
$$;

create trigger journal_entries_no_update
  before update on public.journal_entries
  for each row execute function public.pf_journal_is_append_only();

create trigger journal_entries_no_delete
  before delete on public.journal_entries
  for each row execute function public.pf_journal_is_append_only();
