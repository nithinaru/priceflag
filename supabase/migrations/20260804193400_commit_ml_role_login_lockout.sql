-- Phase one of retiring the old external ML PostgreSQL identity.
--
-- Supabase applies each migration file in its own transaction. This file does
-- only the durable login boundary and records whether a previous, versioned
-- membership precheck can be trusted. After this commits, direct reconnects are
-- impossible while later migrations investigate memberships and drain sessions.

create schema if not exists priceflag_internal authorization postgres;
alter schema priceflag_internal owner to postgres;
revoke all on schema priceflag_internal from public;

create table if not exists priceflag_internal.ml_role_retirement_state (
  singleton boolean primary key default true check (singleton),
  lockout_recorded_at timestamptz not null,
  postmaster_started_at_before_lockout timestamptz not null,
  requires_restart boolean not null,
  drained_at timestamptz,
  restart_verified boolean not null default false
);
alter table priceflag_internal.ml_role_retirement_state owner to postgres;
revoke all on priceflag_internal.ml_role_retirement_state
  from public, anon, authenticated, service_role, priceflag_ml_readonly;

do $$
declare
  role_state record;
  fresh_membership_precheck boolean;
  memberships_exist boolean;
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
      message = 'priceflag_ml_readonly has privileged attributes; an authorized database administrator must remove them before retirement';
  end if;

  select coalesce(
    shobj_description(role.oid, 'pg_authid') = 'Priceflag ML membership precheck v1 passed.',
    false
  )
    into strict fresh_membership_precheck
    from pg_roles role
   where role.rolname = 'priceflag_ml_readonly';

  select exists (
    select 1
      from pg_auth_members link
      join pg_roles parent on parent.oid = link.roleid
      join pg_roles member on member.oid = link.member
     where (parent.rolname = 'priceflag_ml_readonly' or member.rolname = 'priceflag_ml_readonly')
       and not (
         parent.rolname = 'priceflag_ml_readonly'
         and member.rolname = 'postgres'
       )
  ) into memberships_exist;

  alter role priceflag_ml_readonly
    nologin
    noinherit
    connection limit 0
    password null;

  insert into priceflag_internal.ml_role_retirement_state (
    singleton,
    lockout_recorded_at,
    postmaster_started_at_before_lockout,
    requires_restart,
    drained_at,
    restart_verified
  ) values (
    true,
    clock_timestamp(),
    pg_postmaster_start_time(),
    not fresh_membership_precheck or memberships_exist,
    null,
    false
  )
  on conflict (singleton) do update set
    lockout_recorded_at = excluded.lockout_recorded_at,
    postmaster_started_at_before_lockout = excluded.postmaster_started_at_before_lockout,
    requires_restart = excluded.requires_restart,
    drained_at = null,
    restart_verified = false;
end
$$;

alter role priceflag_ml_readonly set default_transaction_read_only = on;
alter role priceflag_ml_readonly set statement_timeout = '1s';

comment on role priceflag_ml_readonly is
  'Retired identity: committed NOLOGIN boundary. Real ML reads use authenticated POST /api/ml/export.';

-- PostgreSQL 16+ automatically gives the CREATEROLE identity ADMIN OPTION on a
-- role it creates. Hosted `postgres` is not a superuser and needs that exact
-- edge for every ALTER/SET/COMMENT above. Revoke it only as the final role
-- administration action; the following migration proves zero memberships.
revoke priceflag_ml_readonly from postgres;
