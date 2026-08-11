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
 *      rollout guardrails; anyone who can write them can corrupt merchant safety
 *      decisions even while automatic rollback is disabled.
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

import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { isMlPipelineAuthorised } from '@/lib/ml-pipeline-auth';
import {
  validateElasticityFits,
  validateExpectedBands,
  validateRolloutReports,
  type ValidationProblem,
} from '@/lib/contracts/validate';
import type { ElasticityFit, ExpectedBand, RolloutReport } from '@/lib/contracts';
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
  reports?: unknown[];
}

const MAX_ROWS_PER_REQUEST = 20_000;

function fail(code: string, message: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: { code, message, retryable: false, details: null }, ...extra }, { status });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isMlPipelineAuthorised(request)) {
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
  if (shop === null || shop.uninstalled_at !== null) {
    return fail('shop_not_connected', `No connected store for ${shopDomain ?? '(unspecified)'}.`, 404);
  }

  const fitRows = Array.isArray(body.fits) ? body.fits : [];
  const bandRows = Array.isArray(body.bands) ? body.bands : [];
  const reportRows = Array.isArray(body.reports) ? body.reports : [];
  if (fitRows.length + bandRows.length + reportRows.length > MAX_ROWS_PER_REQUEST) {
    return fail('payload_too_large', `A model run may contain at most ${MAX_ROWS_PER_REQUEST} rows.`, 413);
  }
  const wrongSurface =
    (run.kind === 'elasticity' && (bandRows.length > 0 || reportRows.length > 0)) ||
    ((run.kind === 'baseline' || run.kind === 'counterfactual') &&
      (fitRows.length > 0 || reportRows.length > 0)) ||
    (run.kind === 'report' && (fitRows.length > 0 || bandRows.length > 0));
  if (wrongSurface) {
    return fail('invalid_request', `model_run.kind=${run.kind} contains rows from a different model surface.`, 400);
  }

  // --- gate 2: the contracts ------------------------------------------------
  const fits = validateElasticityFits<ElasticityFit>(fitRows);
  const bands = validateExpectedBands<ExpectedBand>(bandRows);
  const reports = validateRolloutReports<RolloutReport>(reportRows);
  const problems: ValidationProblem[] = [
    ...fits.problems.map((problem) => ({ ...problem, path: `fits[${problem.index}]${problem.path}` })),
    ...bands.problems.map((problem) => ({ ...problem, path: `bands[${problem.index}]${problem.path}` })),
    ...reports.problems.map((problem) => ({ ...problem, path: `reports[${problem.index}]${problem.path}` })),
  ];

  for (const [surface, rows] of [
    ['fits', fits.valid],
    ['bands', bands.valid],
  ] as const) {
    rows.forEach((row, index) => {
      if (row.shop_domain.toLowerCase() !== shop.shop_domain.toLowerCase()) {
        problems.push({ index, path: `${surface}[${index}]/shop_domain`, message: 'must match the ingest shop' });
      }
      if (row.model_version !== run.model_version) {
        problems.push({ index, path: `${surface}[${index}]/model_version`, message: 'must match model_run.model_version' });
      }
    });
  }
  reports.valid.forEach((report, index) => {
    if (report.model_version !== run.model_version) {
      problems.push({ index, path: `reports[${index}]/model_version`, message: 'must match model_run.model_version' });
    }
  });

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
        `${run.incumbent_version ?? 'the incumbent'}. No fits, bands or reports were stored.`,
    });
  }

  // --- accepted -------------------------------------------------------------
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
      model_run_id: null,
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
      model_run_id: null,
      generated_at: band.generated_at,
    }));

    const ingestKey = createHash('sha256')
      .update(canonical({ shop_id: shop.id, run, fits: fits.valid, bands: bands.valid, reports: reports.valid }))
      .digest('hex');
    const stored = await adapter.ingestModelRunAtomic({
      shopId: shop.id,
      ingestKey,
      run: {
        kind: run.kind,
        model_version: run.model_version,
        git_sha: run.git_sha ?? null,
        status: 'succeeded',
        gate_passed: true,
        incumbent_version: run.incumbent_version ?? null,
        metrics: run.metrics ?? {},
        rows_written: 0,
        notes: run.notes ?? null,
        error: null,
      },
      fits: fitPayload,
      bands: bandPayload,
      reports: reports.valid,
    });

    const expectedTotal = fitPayload.length + bandPayload.length + reports.valid.length;
    if (
      stored.fits_written !== fitPayload.length ||
      stored.bands_written !== bandPayload.length ||
      stored.reports_written !== reports.valid.length ||
      stored.rows_written !== expectedTotal
    ) {
      return fail(
        'write_count_mismatch',
        `The atomic ingest committed but accounted for ${stored.rows_written} of ${expectedTotal} rows. Retry the identical request.`,
        500,
        { model_run_id: stored.model_run_id },
      );
    }

    return NextResponse.json({
      accepted: true,
      model_run_id: stored.model_run_id,
      fits_written: stored.fits_written,
      bands_written: stored.bands_written,
      reports_written: stored.reports_written,
      rows_written: stored.rows_written,
      deduplicated: stored.deduplicated,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const failed = await adapter.recordModelRun({
      shop_id: shop.id,
      kind: run.kind,
      model_version: run.model_version,
      git_sha: run.git_sha ?? null,
      status: 'failed',
      gate_passed: true,
      incumbent_version: run.incumbent_version ?? null,
      metrics: run.metrics ?? {},
      rows_written: 0,
      notes: run.notes ?? null,
      error: message,
      finished_at: new Date().toISOString(),
    });
    return fail('write_failed', `Rows validated but could not be stored: ${message}`, 500, {
      model_run_id: failed.id,
    });
  }
}
