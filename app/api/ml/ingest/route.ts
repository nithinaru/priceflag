/**
 * `POST /api/ml/ingest` — the write path for Lane C (their request 9).
 *
 * Lane C's role is read-only by design and stays that way. So the nightly refit
 * does not write to Postgres at all: it posts contract rows here, and this
 * endpoint — which already holds the service role — does the writing. One place
 * to authenticate, one place to validate, one place that can say no.
 *
 * Three gates, in order, and a payload has to clear all of them:
 *
 *   1. **`ML_INGEST_SECRET`**, compared in constant time. These rows drive
 *      auto-rollback; anyone who can write them can move a real store's prices.
 *   2. **The JSON Schemas.** Lane C writes from Python on its own schedule, so
 *      "it looked like a fit" is not good enough — a band with `low > expected`
 *      is rejected at the door rather than discovered by the evaluator at 3am.
 *   3. **The honesty gate (R28).** A run that did not beat its incumbent is
 *      *recorded* and its rows are *discarded*. Failed challengers are part of
 *      the story; deploying them is not.
 *
 * Writes are all-or-nothing per request: if any row fails validation, none are
 * stored. A half-written band set is worse than none, because the evaluator would
 * read the half that landed and believe it was complete.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { env } from '@/lib/config';
import { safeEqual } from '@/lib/crypto';
import { validateElasticityFits, validateExpectedBands, type ValidationProblem } from '@/lib/contracts/validate';
import type { ElasticityFit, ExpectedBand } from '@/lib/contracts';
import type { ElasticityFitRow, ExpectedBandRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface IngestBody {
  shop_domain?: string;
  model_run?: {
    kind?: 'elasticity' | 'baseline' | 'counterfactual' | 'report';
    model_version?: string;
    git_sha?: string | null;
    gate_passed?: boolean;
    incumbent_version?: string | null;
    metrics?: Record<string, unknown>;
    notes?: string | null;
  };
  fits?: unknown[];
  bands?: unknown[];
}

function fail(code: string, message: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: { code, message, retryable: false, details: null }, ...extra }, { status });
}

function authorised(request: NextRequest): boolean {
  const secret = env('ML_INGEST_SECRET');
  if (secret === undefined) return false;
  const header = request.headers.get('authorization');
  if (header === null) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match !== null && safeEqual(match[1] as string, secret);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorised(request)) {
    return fail('unauthorized', 'Missing or invalid ML ingest secret.', 401);
  }

  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return fail('invalid_request', 'Body is not valid JSON.', 400);
  }

  const run = body.model_run;
  if (run?.model_version === undefined || run.kind === undefined) {
    return fail('invalid_request', 'model_run.kind and model_run.model_version are required.', 400);
  }

  const adapter = getAdapter();

  // The shop: from the payload, or the sole connected store.
  let shopDomain = body.shop_domain?.toLowerCase();
  if (shopDomain === undefined) {
    const shops = await adapter.listShops();
    shopDomain = shops.length === 1 ? shops[0]?.shop_domain : undefined;
  }
  const shop = shopDomain === undefined ? null : await adapter.getShopByDomain(shopDomain);
  if (shop === null) {
    return fail('shop_not_connected', `No connected store for ${shopDomain ?? '(unspecified)'}.`, 404);
  }

  const fitRows = Array.isArray(body.fits) ? body.fits : [];
  const bandRows = Array.isArray(body.bands) ? body.bands : [];

  // --- gate 2: the contracts ------------------------------------------------
  const fits = validateElasticityFits<ElasticityFit>(fitRows);
  const bands = validateExpectedBands<ExpectedBand>(bandRows);
  const problems: ValidationProblem[] = [
    ...fits.problems.map((problem) => ({ ...problem, path: `fits[${problem.index}]${problem.path}` })),
    ...bands.problems.map((problem) => ({ ...problem, path: `bands[${problem.index}]${problem.path}` })),
  ];

  if (problems.length > 0) {
    // Recorded as a failed run so a broken producer is visible in the registry
    // rather than only in a CI log that nobody reads.
    const failed = await adapter.recordModelRun({
      shop_id: shop.id,
      kind: run.kind,
      model_version: run.model_version,
      git_sha: run.git_sha ?? null,
      status: 'failed',
      gate_passed: run.gate_passed ?? null,
      incumbent_version: run.incumbent_version ?? null,
      metrics: run.metrics ?? {},
      rows_written: 0,
      notes: run.notes ?? null,
      error: `${problems.length} row(s) failed contract validation`,
      finished_at: new Date().toISOString(),
    });

    return NextResponse.json(
      {
        accepted: false,
        reason: 'contract_validation_failed',
        model_run_id: failed.id,
        rows_written: 0,
        // Capped: a producer emitting 5000 bad rows should not get 5000 errors back.
        problems: problems.slice(0, 25),
        problem_count: problems.length,
      },
      { status: 422 },
    );
  }

  // --- gate 3: the honesty gate (R28) ---------------------------------------
  if (run.gate_passed !== true) {
    const rejected = await adapter.recordModelRun({
      shop_id: shop.id,
      kind: run.kind,
      model_version: run.model_version,
      git_sha: run.git_sha ?? null,
      status: 'rejected',
      gate_passed: false,
      incumbent_version: run.incumbent_version ?? null,
      metrics: run.metrics ?? {},
      rows_written: 0,
      notes: run.notes ?? null,
      error: null,
      finished_at: new Date().toISOString(),
    });

    // 200, not an error: the nightly job did its job correctly by telling us the
    // challenger lost. Failing the Action here would train people to ignore it.
    return NextResponse.json({
      accepted: false,
      reason: 'gate_not_passed',
      model_run_id: rejected.id,
      rows_written: 0,
      message:
        `Recorded ${run.model_version} as rejected: it did not beat ` +
        `${run.incumbent_version ?? 'the incumbent'}. No fits or bands were stored.`,
    });
  }

  // --- accepted -------------------------------------------------------------
  const modelRun = await adapter.recordModelRun({
    shop_id: shop.id,
    kind: run.kind,
    model_version: run.model_version,
    git_sha: run.git_sha ?? null,
    status: 'running',
    gate_passed: true,
    incumbent_version: run.incumbent_version ?? null,
    metrics: run.metrics ?? {},
    rows_written: 0,
    notes: run.notes ?? null,
    error: null,
    finished_at: null,
  });

  try {
    const fitPayload: Omit<ElasticityFitRow, 'id'>[] = fits.valid.map((fit) => ({
      shop_id: shop.id,
      variant_gid: fit.variant_gid,
      elasticity: fit.elasticity,
      se: fit.se ?? null,
      low: fit.low ?? null,
      high: fit.high ?? null,
      interval_nominal: fit.interval ?? null,
      n_obs: fit.n_obs,
      price_variation_pct: fit.price_variation_pct,
      confidence: fit.confidence,
      confidence_explanation: fit.confidence_explanation ?? null,
      method: fit.method ?? null,
      shrinkage_weight: fit.shrinkage_weight ?? null,
      prior_elasticity: fit.prior_elasticity ?? null,
      r2: fit.r2 ?? null,
      model_version: fit.model_version,
      model_run_id: modelRun.id,
      window_start: fit.window_start ?? null,
      window_end: fit.window_end ?? null,
      fitted_at: fit.fitted_at,
    }));

    const bandPayload: Omit<ExpectedBandRow, 'id'>[] = bands.valid.map((band) => ({
      shop_id: shop.id,
      variant_gid: band.variant_gid,
      day: band.day,
      expected_units: band.expected_units,
      low: band.low,
      high: band.high,
      interval_nominal: band.interval,
      band_kind: band.band_kind,
      rollout_id: band.rollout_id ?? null,
      breach_probability: band.breach_probability ?? null,
      is_floored: band.is_floored ?? false,
      model_version: band.model_version,
      model_run_id: modelRun.id,
      generated_at: band.generated_at,
    }));

    const fitsWritten = fitPayload.length > 0 ? await (adapter.upsertFits?.(shop.id, fitPayload) ?? 0) : 0;
    const bandsWritten = bandPayload.length > 0 ? await (adapter.upsertExpectedBands?.(shop.id, bandPayload) ?? 0) : 0;

    await adapter.updateModelRun(modelRun.id, {
      status: 'succeeded',
      rows_written: fitsWritten + bandsWritten,
      finished_at: new Date().toISOString(),
    });

    return NextResponse.json({
      accepted: true,
      model_run_id: modelRun.id,
      fits_written: fitsWritten,
      bands_written: bandsWritten,
      rows_written: fitsWritten + bandsWritten,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await adapter.updateModelRun(modelRun.id, {
      status: 'failed',
      error: message,
      finished_at: new Date().toISOString(),
    });
    return fail('write_failed', `Rows validated but could not be stored: ${message}`, 500);
  }
}
