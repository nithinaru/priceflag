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
  unexpected_column_privileges integer;
begin
  select count(*)::integer
    into strict unexpected_column_privileges
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
     );

  if unexpected_column_privileges <> 0 then
    raise exception using
      errcode = '42501',
      message = 'priceflag_ml_readonly retains column privileges outside the approved read surface';
  end if;
end
$$;

comment on role priceflag_ml_readonly is
  'Lane C LOGIN credential. NOINHERIT/non-superuser; SELECT only on the attested ML read surface; no token-column access.';
