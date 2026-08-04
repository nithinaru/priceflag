-- Retire the direct PostgreSQL credential previously used by the ML worker.
--
-- Supabase extensions are owned by platform roles and some grant privileges to
-- PUBLIC. A tenant migration runs as `postgres`, not the extension owner, so it
-- cannot reliably narrow every extension ACL. Giving an external worker any DB
-- login would therefore inherit authority outside Priceflag's intended views.
--
-- The production design now reads through POST /api/ml/export. The application
-- keeps its Supabase service key server-side and returns only aggregate model
-- inputs. This migration permanently makes the legacy role unusable, removes
-- its data policies and direct grants, and fails closed if another role can
-- assume it or it can assume another role.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'priceflag_ml_readonly') then
    create role priceflag_ml_readonly nologin noinherit connection limit 0;
  end if;
end
$$;

do $$
declare
  role_state record;
begin
  select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    into strict role_state
    from pg_roles
   where rolname = 'priceflag_ml_readonly';

  if role_state.rolsuper
     or role_state.rolcreatedb
     or role_state.rolcreaterole
     or role_state.rolreplication
     or role_state.rolbypassrls then
    raise exception using
      errcode = '42501',
      message = 'priceflag_ml_readonly has privileged attributes; an authorized database administrator must remove them before the legacy login can be retired';
  end if;

  -- The hosted `postgres` migration identity is deliberately not a superuser,
  -- so it must not mention NOSUPERUSER/NOBYPASSRLS even after proving those
  -- attributes are already absent. LOGIN, INHERIT and the connection limit are
  -- within its CREATEROLE authority.
  alter role priceflag_ml_readonly nologin noinherit connection limit 0;
end
$$;

alter role priceflag_ml_readonly set default_transaction_read_only = on;
alter role priceflag_ml_readonly set statement_timeout = '1s';

-- Membership must be absent before retirement. Silently revoking it would hide
-- a session that already executed SET ROLE because pg_stat_activity reports
-- only that backend's session user. A fresh migration chain records this clean
-- precondition in the role comment for the later lockout migration.
--
-- PostgreSQL 16+ automatically gives the CREATEROLE identity ADMIN OPTION on a
-- role it creates. The original migration creates this role as `postgres`, so
-- remove exactly that creator-management edge. `postgres` already owns the
-- migration authority and gains no external-worker capability from SET ROLE;
-- every other relationship remains an incident and fails below.
revoke priceflag_ml_readonly from postgres;

do $$
declare
  memberships integer;
begin
  select count(*)::integer
    into memberships
    from pg_auth_members link
    join pg_roles role on role.oid in (link.roleid, link.member)
   where role.rolname = 'priceflag_ml_readonly';
  if memberships <> 0 then
    raise exception using
      errcode = '42501',
      message = 'priceflag_ml_readonly has role memberships; drain member sessions and remove memberships before retirement';
  end if;
end
$$;

-- Remove the policies that made the old direct reader useful.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'order_days', 'products', 'shops', 'journal_entries', 'rollouts',
    'rollout_variants', 'elasticity_fits', 'expected_bands', 'model_runs',
    'rollout_reports'
  ]
  loop
    execute format('drop policy if exists ml_readonly_select on public.%I', table_name);
  end loop;
end
$$;

revoke all privileges on all tables in schema public from priceflag_ml_readonly;
revoke all privileges on all sequences in schema public from priceflag_ml_readonly;
revoke all privileges on all routines in schema public from priceflag_ml_readonly;
revoke all privileges on schema public from priceflag_ml_readonly;

-- Column grants survive a table-level revoke, so remove them explicitly.
do $$
declare
  grant_row record;
begin
  for grant_row in
    select table_schema, table_name, privilege_type, column_name
      from information_schema.column_privileges
     where grantee = 'priceflag_ml_readonly'
       and table_schema = 'public'
  loop
    execute format(
      'revoke %s (%I) on table %I.%I from priceflag_ml_readonly',
      grant_row.privilege_type,
      grant_row.column_name,
      grant_row.table_schema,
      grant_row.table_name
    );
  end loop;
end
$$;

drop function if exists priceflag_internal.pf_normalize_extension_privileges();

comment on role priceflag_ml_readonly is
  'Priceflag ML membership precheck v1 passed.';
