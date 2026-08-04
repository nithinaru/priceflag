import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

const ASSERTION = 'if coalesce(cardinality(unexpected_column_privileges), 0) <> 0 then';
const DIAGNOSTIC_ASSERTION = 'if false and coalesce(cardinality(unexpected_column_privileges), 0) <> 0 then';
const NORMALIZER_CALL = 'select priceflag_internal.pf_normalize_extension_privileges();';
const DIAGNOSTIC_NORMALIZER_CALL = '-- diagnostic copy invokes the normalizer after startup';

export function buildDiagnosticMigration(source) {
  const assertionParts = String(source).split(ASSERTION);
  if (assertionParts.length !== 2) {
    throw new Error('Expected exactly one ML privilege post-assertion');
  }
  const withoutAssertion = `${assertionParts[0]}${DIAGNOSTIC_ASSERTION}${assertionParts[1]}`;
  const normalizerParts = withoutAssertion.split(NORMALIZER_CALL);
  if (normalizerParts.length !== 2) {
    throw new Error('Expected exactly one extension privilege normalizer call');
  }
  return `${normalizerParts[0]}${DIAGNOSTIC_NORMALIZER_CALL}${normalizerParts[1]}`;
}

export function formatPrivilegeDiagnostics(rows) {
  if (rows.length === 0) return 'No unexpected ML column privilege was reproduced.';
  const descriptions = rows.map((row) => {
    const privileges = [
      row.can_select && 'SELECT',
      row.can_insert && 'INSERT',
      row.can_update && 'UPDATE',
      row.can_reference && 'REFERENCES',
    ].filter(Boolean);
    return `${row.schema_name}.${row.relation_name} (${row.column_count} columns) [${privileges.join(',')}]`;
  });
  return `Unexpected ML privilege-bearing relations (${rows.length}, maximum 50 shown):\n${descriptions.join('\n')}`;
}

function sanitizeDiagnosticText(value) {
  return String(value ?? '')
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gi, '[REDACTED_SUPABASE_KEY]')
    .replace(/\b(?:password|token|api[_ -]?key|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_+/=-]{80,}\b/g, '[REDACTED_TOKEN]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 600);
}

export function formatNormalizerFailure(cause) {
  const record = cause && typeof cause === 'object' ? cause : {};
  const rawCode = typeof record.code === 'string' ? record.code : '';
  const code = /^[0-9A-Z]{5}$/.test(rawCode) ? ` [${rawCode}]` : '';
  const message = sanitizeDiagnosticText(record.message || cause)
    || 'Postgres rejected the normalizer without a message.';
  return `Extension privilege normalizer failed${code}: ${message}`;
}

export function formatExtensionAccessContext(row) {
  if (!row) return 'Extension access context was unavailable.';
  const memberships = Array.isArray(row.ml_memberships) && row.ml_memberships.length > 0
    ? row.ml_memberships.join(',')
    : 'none';
  return [
    `Extension access context: current=${sanitizeDiagnosticText(row.current_role) || 'unknown'}`,
    `net_owner=${sanitizeDiagnosticText(row.net_owner) || 'unknown'}`,
    `ml_inherit=${Boolean(row.ml_inherit)}`,
    `ml_memberships=${sanitizeDiagnosticText(memberships)}`,
    `net_acl=${sanitizeDiagnosticText(row.net_acl) || 'none'}`,
  ].join(' ');
}

const UNEXPECTED_COLUMN_PRIVILEGES = `
  select namespace.nspname as schema_name,
         relation.relname as relation_name,
         count(*)::int as column_count,
         bool_or(has_column_privilege(
           'priceflag_ml_readonly', relation.oid, attribute.attnum, 'SELECT'
         )) as can_select,
         bool_or(has_column_privilege(
           'priceflag_ml_readonly', relation.oid, attribute.attnum, 'INSERT'
         )) as can_insert,
         bool_or(has_column_privilege(
           'priceflag_ml_readonly', relation.oid, attribute.attnum, 'UPDATE'
         )) as can_update,
         bool_or(has_column_privilege(
           'priceflag_ml_readonly', relation.oid, attribute.attnum, 'REFERENCES'
         )) as can_reference
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
   group by namespace.nspname, relation.relname
   order by namespace.nspname, relation.relname
   limit 50
`;

async function inspect() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error('SUPABASE_DB_URL is required');

  const client = new pg.Client({
    connectionString,
    application_name: 'priceflag-ci-privilege-diagnostic',
  });
  try {
    await client.connect();
    try {
      await client.query(NORMALIZER_CALL);
    } catch (cause) {
      process.stdout.write(`${formatNormalizerFailure(cause)}\n`);
      try {
        const context = await client.query(`
          select current_user as current_role,
                 namespace.nspowner::regrole::text as net_owner,
                 namespace.nspacl::text as net_acl,
                 reader.rolinherit as ml_inherit,
                 coalesce((
                   select array_agg(parent.rolname order by parent.rolname)
                     from pg_auth_members membership
                     join pg_roles parent on parent.oid = membership.roleid
                    where membership.member = reader.oid
                 ), array[]::name[]) as ml_memberships
            from pg_namespace namespace
            join pg_roles reader on reader.rolname = 'priceflag_ml_readonly'
           where namespace.nspname = 'net'
        `);
        process.stdout.write(`${formatExtensionAccessContext(context.rows[0])}\n`);
      } catch {
        process.stdout.write('Extension access context was unavailable.\n');
      }
      return;
    }
    const result = await client.query(UNEXPECTED_COLUMN_PRIVILEGES);
    process.stdout.write(`${formatPrivilegeDiagnostics(result.rows)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command === 'prepare' && path) {
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, buildDiagnosticMigration(source));
    return;
  }
  if (command === 'inspect') {
    await inspect();
    return;
  }
  throw new Error('Usage: ml-privilege-diagnostics.mjs prepare <migration> | inspect');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Unable to produce the sanitized ML privilege diagnostic.\n');
    process.exitCode = 1;
  });
}
