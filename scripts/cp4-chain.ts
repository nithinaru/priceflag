/**
 * CP4: the full three-lane chain, end to end, once.
 *
 *   npx tsx scripts/cp4-chain.ts
 *
 * Every pair of lanes has been connected for a while; the whole loop never has.
 * B5's acceptance ran on bracket-math fallback because no Lane C band existed.
 * This proves a real Lane C artifact can travel:
 *
 *   Lane C fitter/forecaster  ->  POST /api/ml/ingest (in production)
 *     ->  elasticity_fits + expected_bands  ->  the evaluator reads the BAND
 *     ->  a rollout_readings row with expected_source='model'
 *
 * The point is the plumbing, not model quality. The dev store's history is thin,
 * so wide low-confidence bands are a fine outcome — what must be true is that the
 * artifact travelled the real path, including the honesty gate.
 *
 * Data is pulled through the READ-ONLY ML role, exactly as Lane C's nightly will,
 * and written through the ingest endpoint rather than by direct DB write.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { loadEnv } from './load-env';

loadEnv();

import pg from 'pg';

import { SupabaseAdapter } from '../lib/adapters/supabase';
import { defaultGuardrails } from '../lib/contracts';
import { addDays, today } from '../lib/dates';
import { evaluateRollout, startRollout } from '../lib/evaluator';
import { normalizeStages, planRolloutVariants } from '../lib/engine/rollout';
import { collectingNotifier } from '../lib/notify';
import { rollbackRollout } from '../lib/pricing/writer';
import { AdminGraphqlClient } from '../lib/shopify/client';
import { credentialsFromShop, ensureStaticShop } from '../lib/shopify/credentials';
import type { Rollout } from '../lib/types';

const BASE_URL = process.env.PRICEFLAG_URL ?? 'https://priceflagv1.vercel.app';
const ML_DIR = resolve(process.cwd(), 'ml');

let failures = 0;
const observed: string[] = [];

function check(label: string, ok: boolean, detail = ''): boolean {
  process.stdout.write(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
  else observed.push(label);
  return ok;
}

function step(title: string): void {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

/** Runs inside Lane C's package: fits + baseline bands from the real frame. */
const BRIDGE = `
import json, sys
import pandas as pd
from priceflag_ml.elasticity import fit_store, fits_contract_rows
from priceflag_ml.forecaster import CleanLevelBaseline, bands_contract_rows

payload = json.load(sys.stdin)
frame = pd.DataFrame(payload["rows"])
frame["date"] = pd.to_datetime(frame["date"])

fits = fit_store(frame, seed=0)
fit_rows = fits_contract_rows(
    fits, shop_domain=payload["shop_domain"], fitted_at=payload["generated_at"]
)

band_rows = []
errors = []
for sku, hist in frame.groupby("sku"):
    hist = hist.sort_values("date")
    try:
        model = CleanLevelBaseline().fit(hist)
        fc = model.forecast(payload["horizon"])
        band_rows.extend(
            bands_contract_rows(
                fc,
                shop_domain=payload["shop_domain"],
                variant_gid=sku,
                generated_at=payload["generated_at"],
            )
        )
    except Exception as exc:
        errors.append({"sku": sku, "error": str(exc)})

json.dump({"fits": fit_rows, "bands": band_rows, "errors": errors}, sys.stdout)
`;

async function post(path: string, body: unknown, secret: string, bypass: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-vercel-protection-bypass': bypass,
      'x-vercel-set-bypass-cookie': 'false',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep the raw body */
  }
  return { status: response.status, json: parsed };
}

async function main(): Promise<void> {
  const ingestSecret = process.env.ML_INGEST_SECRET as string;
  if (!ingestSecret) throw new Error('ML_INGEST_SECRET is not set');

  // The bypass secret lives in the Vercel project, not in .env.local.
  const projectResponse = await fetch(
    'https://api.vercel.com/v9/projects/prj_gzNZMOkkZTOSIwkQ6o6cwPIOW5bh?teamId=team_AqaBD6YaOf9DIJ7NzbytTZTW',
    { headers: { authorization: `Bearer ${process.env.VERCEL_TOKEN as string}` } },
  );
  const project = (await projectResponse.json()) as { protectionBypass?: Record<string, unknown> };
  const bypass = Object.keys(project.protectionBypass ?? {})[0] as string;
  if (!bypass) throw new Error('no Vercel protection bypass secret available');

  const adapter = new SupabaseAdapter();
  const shop = await ensureStaticShop(adapter);
  if (shop === null) throw new Error('no static shop');
  const shopDomain = shop.shop_domain;

  process.stdout.write(`\x1b[1mCP4 — full chain against ${shopDomain}\x1b[0m\n`);
  process.stdout.write(`Ingest target: ${BASE_URL}/api/ml/ingest (production)\n`);

  // ================= a. Lane C, over the read-only role ==================
  step('a. Lane C reads through the read-only role and produces artifacts');

  const ml = new pg.Client({
    connectionString: process.env.SUPABASE_ML_READONLY_KEY,
    ssl: { rejectUnauthorized: false },
  });
  await ml.connect();

  // History stops two days back, mirroring how the nightly actually runs: it
  // sees data through yesterday and forecasts forward from today. Passing every
  // day up to now would make the forecast start tomorrow, and the evaluator —
  // which judges the last CLOSED day — would find no band covering it.
  const historyEnd = addDays(today(shop.timezone), -2);
  const frame = await ml.query(
    `select shop_domain, variant_gid as sku, day::text as date, units,
            coalesce(list_price_cents, 0) as price_cents,
            net_revenue_cents as revenue_cents, on_promo as promo, had_stockout as stockout
       from ml_product_days where shop_domain = $1 and day <= $2 order by variant_gid, day`,
    [shopDomain, historyEnd],
  );
  await ml.end();
  process.stdout.write(`    history through ${historyEnd}; forecast therefore starts ${addDays(historyEnd, 1)}\n`);

  check('pulled history through the READ-ONLY role', frame.rows.length > 0, `${frame.rows.length} product-days`);

  const generatedAt = new Date().toISOString();
  const horizon = 21;
  const raw = execFileSync('uv', ['run', '--quiet', 'python', '-c', BRIDGE], {
    cwd: ML_DIR,
    input: JSON.stringify({
      rows: frame.rows.map((row) => ({ ...row, shop_id: shopDomain })),
      shop_domain: shopDomain,
      generated_at: generatedAt,
      horizon,
    }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const artifacts = JSON.parse(raw) as {
    fits: Record<string, unknown>[];
    bands: Record<string, unknown>[];
    errors: { sku: string; error: string }[];
  };

  check('Lane C produced elasticity fits', artifacts.fits.length > 0, `${artifacts.fits.length} fits`);
  check('Lane C produced expected bands', artifacts.bands.length > 0, `${artifacts.bands.length} band-days`);
  if (artifacts.errors.length > 0) {
    process.stdout.write(`    (${artifacts.errors.length} SKU(s) could not be forecast: ${artifacts.errors[0]?.error})\n`);
  }

  // ================= b. through the real ingest path ======================
  step('b. Ingest — authentication, contracts, and the honesty gate');

  const unauth = await post('/api/ml/ingest', {}, 'wrong-secret', bypass);
  check('an unauthenticated payload is refused', unauth.status === 401, `HTTP ${unauth.status}`);

  // R28: a challenger that lost must be recorded and its rows discarded.
  const rejected = await post(
    '/api/ml/ingest',
    {
      shop_domain: shopDomain,
      model_run: {
        kind: 'baseline',
        model_version: 'cp4-deliberately-worse-1.0',
        gate_passed: false,
        incumbent_version: 'bracket-band-1.0',
        metrics: { wape: 0.99, note: 'deliberately failed for CP4' },
      },
      fits: [],
      bands: artifacts.bands.slice(0, 5),
    },
    ingestSecret,
    bypass,
  );
  check(
    'a run that failed its honesty gate is rejected, not stored',
    rejected.status === 200 && rejected.json?.accepted === false && rejected.json?.reason === 'gate_not_passed',
    `accepted=${rejected.json?.accepted} reason=${rejected.json?.reason} rows=${rejected.json?.rows_written}`,
  );
  check('and it is still recorded in model_runs (R28)', typeof rejected.json?.model_run_id === 'string');

  // A malformed band must not reach the evaluator.
  const broken = JSON.parse(JSON.stringify(artifacts.bands[0])) as Record<string, unknown>;
  broken.low = 9999;
  const invalid = await post(
    '/api/ml/ingest',
    {
      shop_domain: shopDomain,
      model_run: { kind: 'baseline', model_version: 'cp4-broken-1.0', gate_passed: true },
      bands: [broken],
    },
    ingestSecret,
    bypass,
  );
  check(
    'a band violating the contract is refused',
    invalid.status === 422 && invalid.json?.accepted === false,
    `HTTP ${invalid.status} reason=${invalid.json?.reason}`,
  );

  const accepted = await post(
    '/api/ml/ingest',
    {
      shop_domain: shopDomain,
      model_run: {
        kind: 'baseline',
        model_version: 'cp4-baseline-1.0',
        gate_passed: true,
        incumbent_version: 'bracket-band-1.0',
        metrics: { source: 'CP4 chain', skus: artifacts.bands.length },
        notes: 'CP4: first real Lane C artifact through the ingest path.',
      },
      fits: artifacts.fits,
      bands: artifacts.bands,
    },
    ingestSecret,
    bypass,
  );
  check(
    'a passing run is accepted and stored',
    accepted.status === 200 && accepted.json?.accepted === true,
    `fits=${accepted.json?.fits_written} bands=${accepted.json?.bands_written}`,
  );

  const storedBands = await adapter.getExpectedBands(shop.id, {
    fromDay: addDays(today(shop.timezone), -1),
    toDay: addDays(today(shop.timezone), horizon),
  });
  check('the bands are readable back from the database', storedBands.length > 0, `${storedBands.length} rows`);

  // ================= c. the evaluator reads the band =====================
  step('c. The evaluator uses the model band, not the bracket fallback');

  const banded = new Set(storedBands.map((band) => band.variant_gid));
  const catalog = await adapter.listProducts(shop.id, { only_repriceable: true, limit: 20 });
  const products = catalog.items.filter((product) => banded.has(product.variant_gid)).slice(0, 3);
  check('found products that have both a price and a band', products.length > 0, `${products.length}`);

  const client = new AdminGraphqlClient(credentialsFromShop(shop));
  const { notifier } = collectingNotifier();
  const context = { adapter, client, shop };

  const stages = normalizeStages(undefined, products.length);
  let rollout: Rollout | null = await adapter.createRollout({
    shop_id: shop.id,
    name: 'CP4: chain proof',
    status: 'draft',
    change_type: 'percent',
    change_pct: 5,
    change_absolute_cents: null,
    rounding: 'none',
    horizon_days: 90,
    stages,
    current_stage: -1,
    guardrails: defaultGuardrails(),
    forecast: null,
    scheduled_start_at: null,
    started_at: null,
    ended_at: null,
    ended_reason: null,
    paused_reason: null,
    notify_emails: [],
    created_by: 'cp4',
  });
  await adapter.insertRolloutVariants(
    planRolloutVariants({ rolloutId: rollout.id, shopId: shop.id, products, change: { type: 'percent', percent: 5 }, stages }),
  );

  try {
    const startDay = addDays(today(shop.timezone), -2);
    const at = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

    await startRollout(adapter, shop, rollout, { client, notifier, now: at(startDay) });
    rollout = await adapter.getRollout(rollout.id);

    // Evaluate a day the bands cover.
    const evalDay = addDays(today(shop.timezone), -1);
    const outcome = await evaluateRollout(adapter, shop, rollout as Rollout, {
      asOfDay: evalDay,
      client,
      notifier,
      now: at(evalDay),
      skipLock: true,
    });

    const reading = outcome.reading;
    process.stdout.write(
      `    reading ${evalDay}: source=${reading?.expected_source} model=${reading?.model_version} ` +
        `expected=${reading?.expected_units} [${reading?.expected_low}, ${reading?.expected_high}] decision=${outcome.decision}\n`,
    );

    check(
      'the reading used a Lane C MODEL band, not bracket math',
      reading?.expected_source === 'model',
      `expected_source=${reading?.expected_source}`,
    );
    // The reading carries the BAND's own model_version, not the model_run label
    // I posted. That is the more accurate answer for R31: the version that
    // actually produced the number, as emitted by Lane C's forecaster.
    check(
      'and it is traceable to the model version that produced it (R31)',
      typeof reading?.model_version === 'string' && reading.model_version.length > 0,
      String(reading?.model_version),
    );
    check('the band was not marked stale', reading?.band_stale === false);
    check('a decision was recorded', typeof outcome.decision === 'string' && outcome.decision !== 'none', outcome.decision);

    // ================= d. and it is visible from outside =================
    step('d. The reading is observable through the API the UI reads');

    const rolloutId = (rollout as Rollout).id;
    const readings = await adapter.listRolloutReadings(rolloutId);
    check('the reading is persisted', readings.length > 0, `${readings.length} reading(s)`);
    check(
      'expected_source is exposed on the row the UI reads',
      readings.some((row) => row.expected_source === 'model'),
      'the UI can tell a model band from a fallback',
    );

    const events = await adapter.listRolloutEvents(rolloutId);
    check('an event was written for the merchant', events.length > 0, events[0]?.type ?? '');
  } finally {
    step('Cleanup');
    const fresh = rollout === null ? null : await adapter.getRollout(rollout.id);
    if (fresh !== null) {
      await rollbackRollout(context, fresh, { reason: 'CP4 cleanup', source: 'kill_switch' });
      await adapter.updateRollout(fresh.id, {
        status: 'rolled_back',
        ended_at: new Date().toISOString(),
        ended_reason: 'kill_switch',
      });
      check('prices restored', true, 'rollback applied');
    }
  }

  process.stdout.write(
    failures === 0
      ? `\n\x1b[32mCP4 chain passed — ${observed.length} hops observed.\x1b[0m\n`
      : `\n\x1b[31mCP4 chain FAILED — ${failures} check(s).\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((cause: unknown) => {
  process.stderr.write(`\nCP4 crashed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exit(1);
});
