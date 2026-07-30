/**
 * Lane D integration suite entry point.
 *
 *   npx tsx tests/integration/run.ts            # everything that is configured
 *   npx tsx tests/integration/run.ts --demo     # DemoAdapter only, no network
 *
 * Exit code is non-zero on any failure, so it can gate a push.
 */

import { loadEnv } from '../../scripts/load-env';

loadEnv();

import { DemoAdapter } from '../../lib/adapters/demo';
import { SupabaseAdapter } from '../../lib/adapters/supabase';
import { hasSupabaseConfig } from '../../lib/config';
import type { Shop } from '../../lib/types';

import { assertEqual, makeShop, section, skip, summary, test } from './_harness';
import { runInvariantSuite, runPureInvariants } from './invariants.test';
import { runConcurrencySuite, runExternalChangeSuite, runJournalImmutabilitySuite } from './concurrency.test';
import { runGuardrailSuite } from './guardrails.test';

const demoOnly = process.argv.includes('--demo');

async function main(): Promise<void> {
  process.stdout.write('\x1b[1mPriceflag — Lane D integration suite\x1b[0m\n');

  // --- adapter-independent -------------------------------------------------
  await runPureInvariants();
  await runGuardrailSuite();

  // --- DemoAdapter ---------------------------------------------------------
  const demo = new DemoAdapter({ persist: false, autoSeed: false });
  const demoShop = await demo.upsertShop({
    shop_domain: 'lane-d-demo.myshopify.com',
    currency: 'USD',
    timezone: 'America/New_York',
    mode: 'demo',
  });
  await runInvariantSuite(demo, demoShop, 'DemoAdapter');
  await runConcurrencySuite(demo, demoShop, 'DemoAdapter');
  await runExternalChangeSuite(demo, demoShop, 'DemoAdapter');

  // --- SupabaseAdapter -----------------------------------------------------
  if (demoOnly) {
    section('[SupabaseAdapter]');
    skip('supabase invariants', '--demo passed');
  } else if (!hasSupabaseConfig()) {
    section('[SupabaseAdapter]');
    skip('supabase invariants', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  } else {
    const supabase = new SupabaseAdapter();
    const reachable = await supabase.ping().catch(() => ({ ok: false }) as { ok: boolean });
    if (!reachable.ok) {
      section('[SupabaseAdapter]');
      skip('supabase invariants', 'database unreachable or not migrated');
    } else {
      const shop: Shop = await supabase.upsertShop({
        shop_domain: 'lane-d-test.myshopify.com',
        name: 'Lane D Test Store',
        currency: 'USD',
        timezone: 'America/New_York',
        mode: 'demo',
      });
      await runInvariantSuite(supabase, shop, 'SupabaseAdapter');
      await runConcurrencySuite(supabase, shop, 'SupabaseAdapter');
      await runExternalChangeSuite(supabase, shop, 'SupabaseAdapter');

      // Leave nothing active behind. The production evaluator runs hourly over
      // `listActiveRollouts()` across EVERY shop, so a test rollout left in
      // `running` becomes an hourly error in a real cron job. Scoped strictly to
      // Lane D's own test shop.
      section('[SupabaseAdapter] cleanup');
      await test('no Lane D test rollout is left active for the production evaluator', async () => {
        const active = await supabase.listRollouts(shop.id, ['running', 'scheduled', 'paused']);
        for (const rollout of active) {
          await supabase.updateRollout(rollout.id, {
            status: 'cancelled',
            ended_at: new Date().toISOString(),
            ended_reason: 'cancelled',
          });
        }
        const left = await supabase.listRollouts(shop.id, ['running', 'scheduled', 'paused']);
        assertEqual(left.length, 0, `cleaned ${active.length}, ${left.length} still active`);
      });
    }
  }

  // --- real Postgres safety properties ------------------------------------
  if (!demoOnly) await runJournalImmutabilitySuite();

  void makeShop;
  process.exit(summary());
}

main().catch((cause) => {
  process.stderr.write(`\n\x1b[31mfatal: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\x1b[0m\n`);
  process.exit(1);
});
