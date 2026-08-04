-- Public-beta safety defaults.
--
-- Automatic rollback remains an explicit future opt-in. During the invite-only
-- beta a guardrail breach pauses and alerts; it must never write a price merely
-- because an older database default was permissive.

alter table public.rollouts
  alter column guardrails
  set default '{"contract_version":"1.0.0","auto_rollback":false,"rules":[]}'::jsonb;

-- Disarm every rollout that could still write to Shopify. Terminal rows are
-- historical evidence and are intentionally left unchanged.
update public.rollouts
set guardrails = jsonb_set(guardrails, '{auto_rollback}', 'false'::jsonb, true)
where status in ('draft', 'scheduled', 'running', 'paused')
  and guardrails ->> 'auto_rollback' is distinct from 'false';

-- Application code rejects sub-cent targets during planning and immediately
-- before a write. Keep the same invariant at rest so a direct RPC or future
-- code path cannot stage a free included product. Excluded Shopify variants may
-- legitimately have a zero current/target price and are never write candidates.
-- Validation intentionally fails the migration if staging already contains an
-- unsafe included draft that needs review.
alter table public.rollout_variants
  add constraint rollout_variants_target_price_minimum
  check (excluded or target_price_cents >= 1);

-- Row triggers do not run for TRUNCATE. The journal is the recovery record for
-- every Shopify write, so block the statement explicitly as well as revoking
-- the privilege from the role used by the server-side Supabase client.
create or replace function public.pf_journal_reject_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'journal_entries is append-only (attempted TRUNCATE)';
end;
$$;

drop trigger if exists journal_entries_no_truncate on public.journal_entries;
create trigger journal_entries_no_truncate
  after truncate on public.journal_entries
  for each statement execute function public.pf_journal_reject_truncate();

revoke truncate on table public.journal_entries from anon, authenticated, service_role;
