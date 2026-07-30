/**
 * Generate demo-mode elasticity fits by running **Lane C's real fitter**.
 *
 *   npx tsx scripts/seed-demo-fits.ts
 *
 * Services Lane A's REQ-A-006: demo mode could never reach the `fitted`
 * confidence tier, because fits live in `elasticity_fits` and that needs Supabase
 * plus a nightly run. So the fitted range and its band — an A3 deliverable and
 * CP2's acceptance criterion — could not be seen without a database.
 *
 * ## Why this is not a ground-truth leak
 *
 * `lib/demo/generator.ts` knows each SKU's true elasticity, and writing those
 * numbers into `elasticity_fits` would be exactly the leak CLAUDE.md forbids:
 * demo mode would show a perfect forecast that no real store could ever produce,
 * and `Product.hiddenElasticity` must never influence a forecast.
 *
 * What this does instead: hands Lane C's `fit_store` the **observable** columns
 * only — units, list price, promo and stockout flags, exactly what a real store's
 * `order_days` contains — and stores whatever it estimates. `truth[]` is not read
 * here, and the fitter has no access to it. Some SKUs come back `assumption`, and
 * the estimates miss the true values, because that is what really happens.
 *
 * The output is committed as a fixture so demo mode needs neither Python nor a
 * database at runtime. Re-run it whenever Lane C ships a new champion.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { generateDemoStore, DEMO_SHOP_DOMAIN } from '../lib/demo/generator';

const OUTPUT = resolve(process.cwd(), 'lib/demo/elasticity-fits.json');
const ML_DIR = resolve(process.cwd(), 'ml');

/** Runs inside Lane C's package. Reads the frame on stdin, writes rows on stdout. */
const BRIDGE = `
import json, sys
import pandas as pd
from priceflag_ml.elasticity import fit_store, fits_contract_rows

payload = json.load(sys.stdin)
frame = pd.DataFrame(payload["rows"])
fits = fit_store(frame, seed=0)
rows = fits_contract_rows(
    fits,
    shop_domain=payload["shop_domain"],
    fitted_at=payload["fitted_at"],
    window_start=payload["window_start"],
    window_end=payload["window_end"],
)
json.dump(rows, sys.stdout)
`;

function main(): void {
  const store = generateDemoStore();

  // Observable columns only. Lane C's canonical frame is
  // shop_id, sku, date, units, price_cents, revenue_cents, promo, stockout.
  const rows = store.orderDays.map((row) => ({
    shop_id: DEMO_SHOP_DOMAIN,
    sku: row.variant_gid,
    date: row.day,
    units: row.units,
    price_cents: row.list_price_cents,
    revenue_cents: row.net_revenue_cents,
    promo: row.on_promo,
    stockout: row.had_stockout,
  }));

  const payload = {
    rows,
    shop_domain: DEMO_SHOP_DOMAIN,
    // Fixed, so re-running produces a byte-identical fixture rather than a diff.
    fitted_at: `${store.window.to}T12:00:00.000Z`,
    window_start: store.window.from,
    window_end: store.window.to,
  };

  process.stdout.write(`Running Lane C's fitter over ${rows.length} product-days…\n`);

  const output = execFileSync('uv', ['run', '--quiet', 'python', '-c', BRIDGE], {
    cwd: ML_DIR,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const fits = JSON.parse(output) as {
    variant_gid: string;
    elasticity: number;
    confidence: string;
    se: number | null;
    price_variation_pct: number;
  }[];

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(fits, null, 2)}\n`, 'utf8');

  const byTier = new Map<string, number>();
  for (const fit of fits) byTier.set(fit.confidence, (byTier.get(fit.confidence) ?? 0) + 1);

  process.stdout.write(`\nWrote ${fits.length} fits to lib/demo/elasticity-fits.json\n`);
  process.stdout.write(`Confidence tiers: ${[...byTier].map(([tier, n]) => `${tier}=${n}`).join(', ')}\n\n`);

  // Printed for review only — the comparison is deliberately NOT used to adjust
  // anything. It is here so a human can see the estimates are honest rather than
  // suspiciously perfect.
  process.stdout.write('  variant                                        fitted    true    tier\n');
  for (const fit of fits) {
    const truth = store.truth.find((row) => row.variant_gid === fit.variant_gid);
    process.stdout.write(
      `  ${fit.variant_gid.padEnd(44)} ${fit.elasticity.toFixed(2).padStart(6)}  ` +
        `${(truth?.true_elasticity ?? 0).toFixed(2).padStart(6)}    ${fit.confidence}\n`,
    );
  }
}

main();
