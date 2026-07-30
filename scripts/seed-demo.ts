/**
 * Load the generated demo store into Supabase.
 *
 *   npx tsx scripts/seed-demo.ts                       # into .env.local's project
 *   npx tsx scripts/seed-demo.ts --domain my-store.myshopify.com
 *   npx tsx scripts/seed-demo.ts --seed 42 --days 240
 *
 * Useful for two things: giving Lane C real rows to pull without a Shopify
 * account, and checking that the migrations actually accept what the engine
 * produces. Idempotent — every write is an upsert keyed the same way the sync
 * pipeline keys it, so running it twice changes nothing.
 */

import { loadEnv } from './load-env';

loadEnv();

import { SupabaseAdapter } from '../lib/adapters/supabase';
import { hasSupabaseConfig } from '../lib/config';
import { DEFAULT_HISTORY_DAYS } from '../lib/contracts';
import { DEMO_SHOP_DOMAIN, generateDemoStore } from '../lib/demo/generator';
import { buildJournalEntry } from '../lib/engine/journal';

interface Args {
  domain: string;
  seed: number | undefined;
  days: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { domain: DEMO_SHOP_DOMAIN, seed: undefined, days: DEFAULT_HISTORY_DAYS };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--domain' && value) {
      args.domain = value.toLowerCase();
      i += 1;
    } else if (flag === '--seed' && value) {
      args.seed = Number(value);
      i += 1;
    } else if (flag === '--days' && value) {
      args.days = Number(value);
      i += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!hasSupabaseConfig()) {
    process.stderr.write(
      'Cannot seed: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.\n\n' +
        '  1. cp .env.example .env.local\n' +
        '  2. Fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API)\n' +
        '  3. npx supabase db push        # apply supabase/migrations\n' +
        '  4. npm run seed:demo\n\n' +
        'To run without Supabase at all, use demo mode: PRICEFLAG_MODE=demo npm run dev\n',
    );
    process.exit(1);
  }

  const adapter = new SupabaseAdapter();
  const ping = await adapter.ping();
  if (!ping.ok) {
    process.stderr.write(`Cannot reach Supabase: ${ping.detail ?? 'unknown error'}\n`);
    process.exit(1);
  }

  const store = generateDemoStore({ seed: args.seed, historyDays: args.days });
  process.stdout.write(`Seeding ${args.domain} (${store.window.days} days, ${store.products.length} variants)…\n`);

  const shop = await adapter.upsertShop({
    ...store.shop,
    shop_domain: args.domain,
    // Demo data must never be mistaken for a connected store: no token, and the
    // mode says what it is.
    mode: 'demo',
    access_token_enc: null,
  });
  process.stdout.write(`  shop            ${shop.id}\n`);

  const products = await adapter.upsertProducts(shop.id, store.products);
  process.stdout.write(`  products        ${products}\n`);

  const orderDays = await adapter.upsertOrderDays(shop.id, store.orderDays);
  process.stdout.write(`  order_days      ${orderDays}\n`);

  // Seed the price journal so the trail is complete from the first day, and so
  // Lane C's ml_price_history view has the list price on every historical day.
  const journal = store.priceHistory.map((change) =>
    buildJournalEntry(
      {
        variant_gid: change.variant_gid,
        product_gid: change.product_gid,
        title: change.title,
        sku: change.sku,
        before_price_cents: change.before_price_cents,
        after_price_cents: change.after_price_cents,
        before_compare_at_cents: null,
        after_compare_at_cents: null,
        currency: shop.currency,
      },
      {
        source: 'seed',
        actor: 'system',
        applied_at: `${change.day}T12:00:00.000Z`,
        // Keyed so re-running the seed does not duplicate the trail.
        idempotency_key: `seed:${change.variant_gid}:${change.day}:${change.after_price_cents}`,
      },
    ),
  );
  const written = await adapter.appendJournalEntries(shop.id, journal);
  process.stdout.write(`  journal         ${written.length} new (${journal.length} total price changes)\n`);

  const syncRun = await adapter.createSyncRun(shop.id, 'full');
  await adapter.updateSyncRun(syncRun.id, {
    stage: 'done',
    products_total: store.products.length,
    products_synced: store.products.length,
    days_target: store.window.days,
    days_synced: store.window.days,
    orders_processed: store.orderDays.reduce((sum, row) => sum + row.orders, 0),
    catalog_ready_at: new Date().toISOString(),
    history_ready_at: new Date().toISOString(),
    eta_seconds: 0,
    finished_at: new Date().toISOString(),
    message: `Loaded ${store.products.length} products and ${store.window.days} days of order history.`,
  });

  process.stdout.write(
    `\nDone. Ground truth for Lane C's harness (the elasticities this data was generated from):\n\n` +
      `  variant_gid                                   true_elasticity  price_levels  honest_tier\n`,
  );
  for (const row of store.truth) {
    process.stdout.write(
      `  ${row.variant_gid.padEnd(44)}  ${row.true_elasticity.toFixed(2).padStart(15)}  ` +
        `${String(row.price_levels).padStart(12)}  ${row.expected_confidence}\n`,
    );
  }
  process.stdout.write(
    `\nA product with one price level can only ever be an honest "assumption" — that is the point of including them.\n`,
  );
}

void main().catch((cause: unknown) => {
  process.stderr.write(`\nSeed failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exit(1);
});
