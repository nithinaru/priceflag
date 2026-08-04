-- Phase two of retiring the old external ML PostgreSQL identity.
--
-- The direct login lockout is already committed. This separate transaction
-- refuses any membership in either direction before session draining begins.
-- If it fails, NOLOGIN remains durable while an administrator investigates.

do $$
declare
  membership_edges text;
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

  select string_agg(format('%I->%I', member.rolname, parent.rolname), ', ' order by member.rolname, parent.rolname)
    into membership_edges
    from pg_auth_members link
    join pg_roles parent on parent.oid = link.roleid
    join pg_roles member on member.oid = link.member
   where parent.rolname = 'priceflag_ml_readonly' or member.rolname = 'priceflag_ml_readonly';
  if membership_edges is not null then
    raise exception using
      errcode = '42501',
      message = format(
        'legacy ML database role has memberships (%s); restart to drain member sessions, remove every relationship, then retry',
        membership_edges
      );
  end if;
end
$$;
