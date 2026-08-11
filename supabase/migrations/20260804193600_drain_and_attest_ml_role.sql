-- Phase two of retiring the old external ML PostgreSQL identity.
--
-- The preceding migration committed NOLOGIN before this transaction begins.
-- New authentication is therefore closed while this file drains every session
-- authenticated as the old role and establishes the permanent attestation.

do $$
declare
  session_row record;
  terminated boolean;
  retirement_state record;
begin
  if not exists (
    select 1
      from supabase_migrations.schema_migrations
     where version = '20260804193500'
  ) then
    raise exception using
      errcode = '42501',
      message = 'the separate ML membership verification migration is not recorded; refusing to drain';
  end if;

  select lockout_recorded_at, postmaster_started_at_before_lockout, requires_restart
    into strict retirement_state
    from priceflag_internal.ml_role_retirement_state
   where singleton;

  if retirement_state.requires_restart
     and pg_postmaster_start_time() <= retirement_state.lockout_recorded_at then
    raise exception using
      errcode = '42501',
      message = 'this database applied an older membership migration; restart the Supabase Postgres project after the committed lockout, then retry the drain migration';
  end if;

  if exists (
    select 1 from pg_roles
     where rolname = 'priceflag_ml_readonly'
       and (rolcanlogin or rolinherit or rolconnlimit <> 0)
  ) then
    raise exception using
      errcode = '42501',
      message = 'the legacy ML login boundary was not committed before the drain migration';
  end if;

  if exists (
    select 1
      from pg_auth_members link
      join pg_roles parent on parent.oid = link.roleid
      join pg_roles member on member.oid = link.member
     where (parent.rolname = 'priceflag_ml_readonly' or member.rolname = 'priceflag_ml_readonly')
       and not (
         parent.rolname = 'priceflag_ml_readonly'
         and member.rolname = 'postgres'
       )
  ) then
    raise exception using
      errcode = '42501',
      message = 'legacy ML database role has a membership at drain time';
  end if;

  for session_row in
    select pid
      from pg_stat_activity
     where usename = 'priceflag_ml_readonly'
       and pid <> pg_backend_pid()
  loop
    select pg_terminate_backend(session_row.pid, 5000) into terminated;
    if not terminated then
      raise exception using
        errcode = '42501',
        message = format(
          'could not terminate active legacy ML database session %s; an authorized administrator must drain it',
          session_row.pid
        );
    end if;
  end loop;

  -- pg_stat_activity is cached for the current transaction after the loop's
  -- first read. Discard that snapshot so verification observes the result of
  -- pg_terminate_backend instead of the pre-termination session list.
  perform pg_stat_clear_snapshot();

  if exists (
    select 1
      from pg_stat_activity
     where usename = 'priceflag_ml_readonly'
       and pid <> pg_backend_pid()
  ) then
    raise exception using
      errcode = '42501',
      message = 'legacy ML database sessions remain after the committed lockout';
  end if;

  update priceflag_internal.ml_role_retirement_state
     set drained_at = clock_timestamp(),
         restart_verified = (
           not retirement_state.requires_restart
           or pg_postmaster_start_time() > retirement_state.lockout_recorded_at
         )
   where singleton;
end
$$;

create or replace function priceflag_internal.pf_attest_ml_database_role_retired()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  role_state record;
  memberships integer;
  policies integer;
  direct_grants integer;
  active_sessions integer;
  retirement_state record;
begin
  select rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolconnlimit
    into strict role_state
    from pg_roles
   where rolname = 'priceflag_ml_readonly';

  if role_state.rolcanlogin
     or role_state.rolinherit
     or role_state.rolsuper
     or role_state.rolcreatedb
     or role_state.rolcreaterole
     or role_state.rolreplication
     or role_state.rolbypassrls
     or role_state.rolconnlimit <> 0 then
    raise exception using errcode = '42501', message = 'legacy ML database role is not fully retired';
  end if;

  select count(*)::integer into memberships
    from pg_auth_members link
    join pg_roles parent on parent.oid = link.roleid
    join pg_roles member on member.oid = link.member
   where (parent.rolname = 'priceflag_ml_readonly' or member.rolname = 'priceflag_ml_readonly')
     and not (
       parent.rolname = 'priceflag_ml_readonly'
       and member.rolname = 'postgres'
     );
  if memberships <> 0 then
    raise exception using errcode = '42501', message = 'legacy ML database role retains role memberships';
  end if;

  select count(*)::integer into active_sessions
    from pg_stat_activity
   where usename = 'priceflag_ml_readonly'
     and pid <> pg_backend_pid();
  if active_sessions <> 0 then
    raise exception using errcode = '42501', message = 'legacy ML database role still has active sessions';
  end if;

  select drained_at, requires_restart, restart_verified
    into strict retirement_state
    from priceflag_internal.ml_role_retirement_state
   where singleton;
  if retirement_state.drained_at is null
     or (retirement_state.requires_restart and not retirement_state.restart_verified) then
    raise exception using errcode = '42501', message = 'legacy ML role drain/restart attestation is incomplete';
  end if;

  select count(*)::integer into policies
    from pg_policy policy
    join pg_roles role on role.oid = any(policy.polroles)
   where role.rolname = 'priceflag_ml_readonly';
  if policies <> 0 then
    raise exception using errcode = '42501', message = 'legacy ML database role remains referenced by an RLS policy';
  end if;

  select count(*)::integer into direct_grants
    from (
      select 1 from information_schema.table_privileges
       where grantee = 'priceflag_ml_readonly' and table_schema = 'public'
      union all
      select 1 from information_schema.column_privileges
       where grantee = 'priceflag_ml_readonly' and table_schema = 'public'
      union all
      select 1 from information_schema.routine_privileges
       where grantee = 'priceflag_ml_readonly' and routine_schema = 'public'
      union all
      select 1 from information_schema.usage_privileges
       where grantee = 'priceflag_ml_readonly' and object_schema = 'public'
    ) grants;
  if direct_grants <> 0 then
    raise exception using errcode = '42501', message = 'legacy ML database role retains direct privileges in the application schema';
  end if;
end
$$;

revoke all on function priceflag_internal.pf_attest_ml_database_role_retired()
  from public, anon, authenticated, service_role, priceflag_ml_readonly;
grant execute on function priceflag_internal.pf_attest_ml_database_role_retired()
  to postgres;

select priceflag_internal.pf_attest_ml_database_role_retired();

comment on function priceflag_internal.pf_attest_ml_database_role_retired() is
  'Fail-closed attestation that the committed lockout is drained and the legacy ML PostgreSQL identity cannot be used.';
