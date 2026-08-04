-- Phase two of retiring the old external ML PostgreSQL identity.
--
-- The direct login lockout is already committed. This separate transaction
-- refuses any membership in either direction before session draining begins.
-- If it fails, NOLOGIN remains durable while an administrator investigates.

do $$
declare
  memberships integer;
begin
  if not exists (
    select 1
      from supabase_migrations.schema_migrations
     where version = '20260804193400'
  ) then
    raise exception using
      errcode = '42501',
      message = 'the ML login lockout migration is not recorded; refusing membership verification';
  end if;

  if exists (
    select 1 from pg_roles
     where rolname = 'priceflag_ml_readonly'
       and (rolcanlogin or rolinherit or rolconnlimit <> 0)
  ) then
    raise exception using
      errcode = '42501',
      message = 'the legacy ML login boundary was not committed before membership verification';
  end if;

  perform 1
    from priceflag_internal.ml_role_retirement_state
   where singleton;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'the ML role retirement state was not committed with the login lockout';
  end if;

  select count(*)::integer
    into memberships
    from pg_auth_members link
    join pg_roles role on role.oid in (link.roleid, link.member)
   where role.rolname = 'priceflag_ml_readonly';
  if memberships <> 0 then
    raise exception using
      errcode = '42501',
      message = 'legacy ML database role has memberships; restart to drain member sessions, remove every relationship, then retry';
  end if;
end
$$;
