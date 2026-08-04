-- Make the ML reader's name match its effective authority.
--
-- The original role migration was intentionally narrow for a fresh project,
-- but `create role if missing` would preserve dangerous attributes, role
-- memberships or direct grants on a pre-existing role. Production evidence
-- must not trust the role name alone, so normalize all role attributes and
-- direct object grants before restoring the documented read surface.

-- Supabase's migration role deliberately is not a cluster superuser. PostgreSQL
-- does not let a non-superuser mention NOSUPERUSER at all, even when the target
-- role is already non-superuser. Normalize cluster-level attributes when the
-- migrator can do so; otherwise prove that every privileged attribute is
-- already absent and fail closed if an owner must repair the role out of band.
do $$
declare
  migrator_is_superuser boolean;
  reader record;
begin
  select rolsuper
    into strict migrator_is_superuser
    from pg_roles
   where rolname = current_user;

  select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    into strict reader
    from pg_roles
   where rolname = 'priceflag_ml_readonly';

  if migrator_is_superuser then
    alter role priceflag_ml_readonly
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication
      nobypassrls
      connection limit 5;
  else
    if reader.rolsuper
       or reader.rolcreatedb
       or reader.rolcreaterole
       or reader.rolreplication
       or reader.rolbypassrls then
      raise exception using
        errcode = '42501',
        message = 'priceflag_ml_readonly has privileged role attributes; an authorized database administrator must remove them before this migration can continue';
    end if;

    -- These attributes do not confer cluster-level authority and can be
    -- tightened by the CREATEROLE migration identity that created the reader.
    alter role priceflag_ml_readonly noinherit connection limit 5;
  end if;
end
$$;

alter role priceflag_ml_readonly set default_transaction_read_only = on;
alter role priceflag_ml_readonly set statement_timeout = '60s';

-- Membership can confer SET ROLE even when NOINHERIT is set. Remove every
-- membership so the credential cannot assume a more powerful role.
do $$
declare
  parent_role record;
begin
  for parent_role in
    select parent.rolname
      from pg_auth_members membership
      join pg_roles member on member.oid = membership.member
      join pg_roles parent on parent.oid = membership.roleid
     where member.rolname = 'priceflag_ml_readonly'
  loop
    execute format('revoke %I from priceflag_ml_readonly', parent_role.rolname);
  end loop;
end
$$;

-- Remove every direct grant on the application schema. PUBLIC grants and any
-- accidental privileges in other schemas are not role-specific enough to
-- normalize safely here, so runtime attestation inventories their effective
-- result and fails closed if it can read or mutate anything outside the list.
revoke all privileges on all tables in schema public from priceflag_ml_readonly;
revoke all privileges on all sequences in schema public from priceflag_ml_readonly;
revoke all privileges on all routines in schema public from priceflag_ml_readonly;
revoke all privileges on schema public from priceflag_ml_readonly;

-- Normalize independently recorded column grants as well. The information
-- schema exposes only valid column privilege types and avoids depending on the
-- elevated ACL-expansion catalog helper that hosted Supabase withholds.
do $$
declare
  column_grant record;
begin
  for column_grant in
    select table_schema, table_name, column_name, privilege_type
      from information_schema.column_privileges
     where grantee = 'priceflag_ml_readonly'
       and table_schema = 'public'
       and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
  loop
    execute format(
      'revoke %s (%I) on table %I.%I from priceflag_ml_readonly',
      column_grant.privilege_type,
      column_grant.column_name,
      column_grant.table_schema,
      column_grant.table_name
    );
  end loop;
end
$$;

-- A database-level CREATE grant would let this role manufacture a new schema
-- even after every existing schema has been locked down. Remove a direct grant
-- on the application database, then inventory every connectable database. An
-- ownership grant, PUBLIC grant or grant in another database cannot be made
-- safe here without broader authority, so fail closed and require owner repair.
do $$
declare
  unsafe_databases integer;
begin
  execute format(
    'revoke create on database %I from priceflag_ml_readonly',
    current_database()
  );

  select count(*)::integer
    into strict unsafe_databases
    from pg_database database
    join pg_roles reader on reader.rolname = 'priceflag_ml_readonly'
   where database.datallowconn
     and (
       database.datdba = reader.oid
       or has_database_privilege(reader.oid, database.oid, 'CREATE')
     );

  if unsafe_databases <> 0 then
    raise exception using
      errcode = '42501',
      message = 'priceflag_ml_readonly owns or can create objects in a connectable database; an authorized database administrator must remove that authority before this migration can continue';
  end if;
end
$$;

-- Supabase installs pg_stat_statements and pg_net before application
-- migrations. Their extension defaults include privileges for PUBLIC, which
-- every role inherits and which cannot be removed from only the ML reader.
-- Replace those broad grants with the platform roles Supabase documents for
-- database webhooks and administration. This preserves those integrations
-- while preventing the ML credential from reading statement metadata or
-- writing to pg_net's request/response tables.
create schema if not exists priceflag_internal authorization postgres;
alter schema priceflag_internal owner to postgres;
revoke all on schema priceflag_internal from public;

create or replace function priceflag_internal.pf_normalize_extension_privileges()
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  platform_role text;
  request_routine text;
  pg_net_version text;
  pg_net_major integer;
  pg_net_minor integer;
  unsafe_extension_privileges integer;
begin
  if to_regclass('extensions.pg_stat_statements') is not null then
    revoke select on extensions.pg_stat_statements
      from public, priceflag_ml_readonly;
    foreach platform_role in array array['postgres', 'dashboard_user']
    loop
      if exists (select 1 from pg_roles where rolname = platform_role) then
        execute format(
          'grant select on extensions.pg_stat_statements to %I',
          platform_role
        );
      end if;
    end loop;
  end if;

  if to_regclass('extensions.pg_stat_statements_info') is not null then
    revoke select on extensions.pg_stat_statements_info
      from public, priceflag_ml_readonly;
    foreach platform_role in array array['postgres', 'dashboard_user']
    loop
      if exists (select 1 from pg_roles where rolname = platform_role) then
        execute format(
          'grant select on extensions.pg_stat_statements_info to %I',
          platform_role
        );
      end if;
    end loop;
  end if;

  if exists (select 1 from pg_namespace where nspname = 'net') then
    select extension.extversion
      into strict pg_net_version
      from pg_extension extension
     where extension.extname = 'pg_net';

    -- pg_net 0.11 -> 0.12 re-applies PUBLIC grants during the upgrade. Force
    -- that upgrade to happen before normalization so an old project cannot
    -- become unsafe immediately after this migration runs.
    if pg_net_version !~ '^[0-9]+\.[0-9]+(\.[0-9]+)?$' then
      raise exception using
        errcode = '42501',
        message = 'unsupported pg_net version format; upgrade pg_net to 0.12.0 or newer before applying Priceflag ML privileges';
    end if;

    pg_net_major := split_part(pg_net_version, '.', 1)::integer;
    pg_net_minor := split_part(pg_net_version, '.', 2)::integer;

    if pg_net_major = 0 and pg_net_minor < 12 then
      raise exception using
        errcode = '42501',
        message = 'pg_net 0.12.0 or newer is required before Priceflag can normalize extension privileges';
    end if;

    revoke all privileges on all tables in schema net from public;
    revoke all privileges on all sequences in schema net from public;
    revoke all privileges on all routines in schema net from public;
    revoke all privileges on schema net from public;
    revoke all privileges on all tables in schema net
      from priceflag_ml_readonly;
    revoke all privileges on all sequences in schema net
      from priceflag_ml_readonly;
    revoke all privileges on all routines in schema net
      from priceflag_ml_readonly;
    revoke all privileges on schema net from priceflag_ml_readonly;

    foreach platform_role in array array[
      'supabase_functions_admin', 'postgres', 'anon',
      'authenticated', 'service_role'
    ]
    loop
      if exists (select 1 from pg_roles where rolname = platform_role) then
        execute format('grant usage on schema net to %I', platform_role);

        -- Keep pg_net's documented request and response APIs working without
        -- exposing administrative helpers such as worker_restart. Discover
        -- the installed signatures from the catalog because pg_net is beta
        -- and its argument lists differ between supported Supabase images.
        for request_routine in
          select format(
            '%I.%I(%s)',
            namespace.nspname,
            routine.proname,
            pg_get_function_identity_arguments(routine.oid)
          )
          from pg_proc routine
          join pg_namespace namespace on namespace.oid = routine.pronamespace
          where namespace.nspname = 'net'
            and routine.prokind = 'f'
            and routine.proname = any (array[
              'http_get',
              'http_post',
              'http_delete',
              'http_collect_response',
              '_http_collect_response',
              '_await_response',
              '_urlencode_string',
              '_encode_url_with_params_array',
              'wake'
            ])
        loop
          execute format(
            'grant execute on function %s to %I',
            request_routine,
            platform_role
          );
        end loop;

        if platform_role = 'postgres' then
          execute format(
            'grant select, insert, update, delete on all tables in schema net to %I',
            platform_role
          );
          execute format(
            'grant usage, select, update on all sequences in schema net to %I',
            platform_role
          );

          -- These are operator-only diagnostics/configuration entry points.
          for request_routine in
            select format(
              '%I.%I(%s)',
              namespace.nspname,
              routine.proname,
              pg_get_function_identity_arguments(routine.oid)
            )
            from pg_proc routine
            join pg_namespace namespace on namespace.oid = routine.pronamespace
            where namespace.nspname = 'net'
              and routine.prokind = 'f'
              and routine.proname = any (array[
                'worker_restart',
                'wait_until_running',
                'check_worker_is_up'
              ])
          loop
            execute format(
              'grant execute on function %s to %I',
              request_routine,
              platform_role
            );
          end loop;
        else
          -- SECURITY INVOKER request functions insert into the queue and use
          -- its sequence; callers only need to observe responses. Do not
          -- restore PUBLIC's TRIGGER/TRUNCATE/REFERENCES authority.
          if to_regclass('net.http_request_queue') is not null then
            execute format(
              'grant select, insert on net.http_request_queue to %I',
              platform_role
            );
          end if;
          if to_regclass('net._http_response') is not null then
            execute format(
              'grant select on net._http_response to %I',
              platform_role
            );
          end if;
          if to_regclass('net.http_request_queue_id_seq') is not null then
            execute format(
              'grant usage, select on sequence net.http_request_queue_id_seq to %I',
              platform_role
            );
          end if;
        end if;
      end if;
    end loop;

    if has_schema_privilege('priceflag_ml_readonly', 'net', 'USAGE') then
      raise exception using
        errcode = '42501',
        message = 'priceflag_ml_readonly retains effective USAGE on the net schema after normalization';
    end if;

    select count(*)::integer
      into strict unsafe_extension_privileges
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where (
       namespace.nspname = 'net'
       or (
         namespace.nspname = 'extensions'
         and relation.relname = any(array[
           'pg_stat_statements', 'pg_stat_statements_info'
         ])
       )
     )
       and relation.relkind in ('r', 'p', 'v', 'm', 'f')
       and (
         has_table_privilege(
           'priceflag_ml_readonly', relation.oid,
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         )
         or has_any_column_privilege(
           'priceflag_ml_readonly', relation.oid,
           'SELECT,INSERT,UPDATE,REFERENCES'
         )
       );

    if unsafe_extension_privileges <> 0 then
      raise exception using
        errcode = '42501',
        message = 'priceflag_ml_readonly retains effective relation privileges on protected Supabase extension objects';
    end if;

    select count(*)::integer
      into strict unsafe_extension_privileges
      from pg_class sequence
      join pg_namespace namespace on namespace.oid = sequence.relnamespace
     where namespace.nspname = 'net'
       and sequence.relkind = 'S'
       and has_sequence_privilege(
         'priceflag_ml_readonly', sequence.oid, 'USAGE,SELECT,UPDATE'
       );

    if unsafe_extension_privileges <> 0 then
      raise exception using
        errcode = '42501',
        message = 'priceflag_ml_readonly retains effective sequence privileges in the net schema';
    end if;

    select count(*)::integer
      into strict unsafe_extension_privileges
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
     where namespace.nspname = 'net'
       and has_function_privilege(
         'priceflag_ml_readonly', routine.oid, 'EXECUTE'
       );

    if unsafe_extension_privileges <> 0 then
      raise exception using
        errcode = '42501',
        message = 'priceflag_ml_readonly retains effective routine execution in the net schema';
    end if;
  end if;
end
$function$;

revoke all on function priceflag_internal.pf_normalize_extension_privileges()
  from public, anon, authenticated, service_role, priceflag_ml_readonly;
revoke all on schema priceflag_internal
  from public, anon, authenticated, service_role, priceflag_ml_readonly;
grant usage on schema priceflag_internal to postgres;
grant execute on function priceflag_internal.pf_normalize_extension_privileges()
  to postgres;

-- This function is the mandatory post-enable/update control for pg_net. It both
-- restores the least-privilege ACL and proves the ML credential still has no
-- effective access before returning successfully.
select priceflag_internal.pf_normalize_extension_privileges();

comment on function priceflag_internal.pf_normalize_extension_privileges() is
  'Run as postgres immediately after every pg_net enablement or update; normalizes extension ACLs and fails unless the ML role remains isolated.';

-- Trigger helpers are not RPC endpoints. Remove the default PUBLIC execute
-- grant so the ML credential cannot invoke them directly through that role.
revoke execute on function public.pf_touch_updated_at()
  from public, anon, authenticated, priceflag_ml_readonly;
revoke execute on function public.pf_journal_is_append_only()
  from public, anon, authenticated, priceflag_ml_readonly;
revoke execute on function public.pf_journal_reject_truncate()
  from public, anon, authenticated, priceflag_ml_readonly;
revoke execute on function public.pf_compliance_audit_is_append_only()
  from public, anon, authenticated, priceflag_ml_readonly;

-- Restore only the documented ML read surface.
grant usage on schema public to priceflag_ml_readonly;

grant select on public.ml_product_days     to priceflag_ml_readonly;
grant select on public.ml_products         to priceflag_ml_readonly;
grant select on public.ml_price_history    to priceflag_ml_readonly;
grant select on public.ml_rollout_windows  to priceflag_ml_readonly;

grant select on public.order_days       to priceflag_ml_readonly;
grant select on public.products         to priceflag_ml_readonly;
grant select on public.journal_entries  to priceflag_ml_readonly;
grant select on public.rollouts         to priceflag_ml_readonly;
grant select on public.rollout_variants to priceflag_ml_readonly;

grant select (id, shop_domain, name, currency, timezone, mode, created_at)
  on public.shops to priceflag_ml_readonly;

grant select on public.elasticity_fits to priceflag_ml_readonly;
grant select on public.expected_bands  to priceflag_ml_readonly;
grant select on public.model_runs      to priceflag_ml_readonly;
grant select on public.rollout_reports to priceflag_ml_readonly;

-- Required by ml_price_history/ml_rollout_windows; safe, stable and
-- security-invoker. No other routine is part of the ML credential surface.
grant execute on function public.pf_shop_day(timestamptz, text)
  to priceflag_ml_readonly;

-- Prove the effective column surface after grants are restored. This catches
-- PUBLIC or differently-granted ACLs that the migration identity could see but
-- could not revoke, including write privileges scoped to individual columns.
do $$
declare
  unexpected_column_privileges text[];
begin
  select array_agg(description order by description)
    into strict unexpected_column_privileges
    from (
      select format(
               '%I.%I.%I:%s%s',
               namespace.nspname,
               relation.relname,
               attribute.attname,
               case when has_column_privilege(
                 'priceflag_ml_readonly', relation.oid, attribute.attnum, 'SELECT'
               ) then 'SELECT' else '' end,
               case when has_column_privilege(
                 'priceflag_ml_readonly', relation.oid, attribute.attnum,
                 'INSERT,UPDATE,REFERENCES'
               ) then '+WRITE' else '' end
             ) as description
        from pg_class relation
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        join pg_attribute attribute on attribute.attrelid = relation.oid
       where namespace.nspname <> 'information_schema'
         and namespace.nspname !~ '^pg_'
         and relation.relkind in ('r', 'p', 'v', 'm', 'f')
         and attribute.attnum > 0
         and not attribute.attisdropped
         and (
           has_column_privilege(
             'priceflag_ml_readonly', relation.oid, attribute.attnum,
             'INSERT,UPDATE,REFERENCES'
           )
           or (
             has_column_privilege(
               'priceflag_ml_readonly', relation.oid, attribute.attnum, 'SELECT'
             )
             and not (
               namespace.nspname = 'public'
               and (
                 relation.relname = any(array[
                   'ml_product_days', 'ml_products', 'ml_price_history',
                   'ml_rollout_windows', 'order_days', 'products',
                   'journal_entries', 'rollouts', 'rollout_variants',
                   'elasticity_fits', 'expected_bands', 'model_runs',
                   'rollout_reports'
                 ])
                 or (
                   relation.relname = 'shops'
                   and attribute.attname = any(array[
                     'id', 'shop_domain', 'name', 'currency',
                     'timezone', 'mode', 'created_at'
                   ])
                 )
               )
             )
           )
         )
       order by namespace.nspname, relation.relname, attribute.attnum
       limit 30
    ) unexpected;

  if coalesce(cardinality(unexpected_column_privileges), 0) <> 0 then
    raise exception using
      errcode = '42501',
      message = 'priceflag_ml_readonly retains column privileges outside the approved read surface: '
        || array_to_string(unexpected_column_privileges, ', ');
  end if;
end
$$;

comment on role priceflag_ml_readonly is
  'Lane C LOGIN credential. NOINHERIT/non-superuser; SELECT only on the attested ML read surface; no token-column access.';
