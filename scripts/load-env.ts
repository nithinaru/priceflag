/**
 * Minimal `.env.local` loader for the standalone scripts.
 *
 * Next.js loads `.env.local` itself, but `tsx scripts/*.ts` does not, and adding
 * dotenv for eight lines of parsing is not worth a dependency. Existing
 * environment variables always win, so `SUPABASE_URL=… npm run smoke` overrides
 * the file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(files = ['.env.local', '.env']): string[] {
  const loaded: string[] = [];

  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();

      // Strip one layer of matching quotes, which is how multi-word values like
      // RESEND_FROM are usually written.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = value;
      }
    }
    loaded.push(file);
  }

  return loaded;
}
