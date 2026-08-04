-- The shop/redact tombstone is compliance evidence. The webhook handler only
-- appends one row after a verified purge; no application path may rewrite or
-- remove that evidence later.

create or replace function public.pf_compliance_audit_is_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'compliance_audit is append-only (attempted %)', tg_op;
end;
$$;

drop trigger if exists compliance_audit_no_update_or_delete on public.compliance_audit;
create trigger compliance_audit_no_update_or_delete
  before update or delete on public.compliance_audit
  for each row execute function public.pf_compliance_audit_is_append_only();

drop trigger if exists compliance_audit_no_truncate on public.compliance_audit;
create trigger compliance_audit_no_truncate
  before truncate on public.compliance_audit
  for each statement execute function public.pf_compliance_audit_is_append_only();

-- The server must be able to append the tombstone inside
-- pf_purge_shop_for_compliance, but it never needs mutation privileges.
revoke update, delete, truncate on table public.compliance_audit from service_role;

-- Trigger helpers are implementation details, not Data API endpoints.
revoke all on function public.pf_compliance_audit_is_append_only()
  from public, anon, authenticated, priceflag_ml_readonly;
