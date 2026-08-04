-- Supabase no longer guarantees that newly created Data API objects inherit
-- service_role privileges. Priceflag intentionally uses the server-only
-- service key after Shopify session-token authentication, so make that access
-- explicit and reproducible instead of relying on project-age defaults.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select, update on sequences to service_role;

-- The audit trail remains append-only even for the application role. Inserts
-- and reads are required; rewrites and ordinary deletes are not. Compliance
-- deletion cascades from shops inside the dedicated purge transaction.
revoke update, delete, truncate on table public.journal_entries from service_role;
