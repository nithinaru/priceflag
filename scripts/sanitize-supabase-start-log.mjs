import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DIAGNOSTIC_LINE = /(?:error|failed|failure|fatal|panic|migration|migrat|unhealthy|timed?\s*out|timeout|exited?|container|syntax|permission|does not exist|cannot|could not)/i;
const SQL_FAILURE = /effect\/sql\/SqlError|failed to execute statement/i;
const SENSITIVE_ASSIGNMENT = /\b(?:anon(?:[_ -]?key)?|service[_ -]?role(?:[_ -]?key)?|secret(?:[_ -]?key)?|publishable(?:[_ -]?key)?|password|token|api[_ -]?key|jwt)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi;
const POSTGRES_CREDENTIALS = /\b(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const SUPABASE_KEY = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_+/=-]{80,}\b/g;

export function sanitizeSupabaseStartLog(input) {
  const rawLines = String(input)
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.replace(ANSI_ESCAPE, ''));
  const sqlFailureIndex = rawLines.findIndex((line) => SQL_FAILURE.test(line));
  const selectedLines = sqlFailureIndex === -1
    ? rawLines.filter((line) => DIAGNOSTIC_LINE.test(line))
    : rawLines.slice(Math.max(0, sqlFailureIndex - 40));
  const lines = selectedLines
    .map((line) => line
      .replace(POSTGRES_CREDENTIALS, '$1[REDACTED]@')
      .replace(JWT, '[REDACTED_JWT]')
      .replace(SUPABASE_KEY, '[REDACTED_SUPABASE_KEY]')
      .replace(SENSITIVE_ASSIGNMENT, (assignment) => {
        const separator = assignment.search(/[:=]/);
        return separator === -1
          ? '[REDACTED_SECRET]'
          : `${assignment.slice(0, separator + 1)}[REDACTED]`;
      })
      .replace(LONG_TOKEN, '[REDACTED_TOKEN]')
      .slice(0, 1_000));

  const unique = [];
  for (const line of lines) {
    if (line.trim() !== '' && unique.at(-1) !== line) unique.push(line);
  }
  return unique.slice(-220).join('\n');
}

function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/sanitize-supabase-start-log.mjs <log-file>');

  const diagnostic = sanitizeSupabaseStartLog(readFileSync(path, 'utf8'));
  process.stdout.write(
    diagnostic === ''
      ? 'Supabase startup failed without a safely reportable diagnostic line.\n'
      : `${diagnostic}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (cause) {
    process.stderr.write('Unable to sanitize the Supabase startup diagnostic.\n');
    process.exitCode = 1;
  }
}
