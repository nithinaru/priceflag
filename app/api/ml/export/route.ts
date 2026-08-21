/**
 * `POST /api/ml/export` — the only real-store read surface available to the
 * external ML worker.
 *
 * The worker never receives a PostgreSQL login or the Supabase service key.
 * This route authenticates one server-to-server credential, resolves every
 * requested shop in the application, and emits only the fields required by
 * the pricing models. Shopify tokens, customer identifiers and order-level
 * records are not representable in the response contract.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAdapter } from '@/lib/adapters';
import { env, getMode } from '@/lib/config';
import { dayInTimeZone, today } from '@/lib/dates';
import { isMlPipelineAuthorised } from '@/lib/ml-pipeline-auth';
import { exclusionReasonFor, type JournalEntry, type Product, type Rollout, type Shop } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_PAGE_SIZE = 1_000;
const MAX_RECEIPTS = 100;
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' };

type Surface = 'product_days' | 'products' | 'price_history' | 'rollout_windows';

function isSurface(value: unknown): value is Surface {
  return value === 'product_days' || value === 'products' || value === 'price_history' || value === 'rollout_windows';
}

interface ExportBody {
  operation?: 'attest' | 'read' | 'verify_receipts';
  surface?: Surface;
  shop_domain?: string;
  cursor?: number;
  limit?: number;
  receipts?: Array<{ id?: string; git_sha?: string; rows_written?: number }>;
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function fail(code: string, message: string, status: number, retryable = false): NextResponse {
  return json({ error: { code, message, retryable, details: null } }, status);
}

function projectRef(): string | null {
  const raw = env('SUPABASE_URL');
  if (raw === undefined) return null;
  try {
    const parsed = new URL(raw);
    const match = /^([a-z]{20})\.supabase\.co$/.exec(parsed.hostname);
    if (
      parsed.protocol !== 'https:' ||
      match === null ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      !['', '/'].includes(parsed.pathname) ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    return match[1] as string;
  } catch {
    return null;
  }
}

function sourceEnvironment(): 'staging' | 'production' {
  return env('VERCEL_ENV') === 'production' ? 'production' : 'staging';
}

function isExportableShop(shop: Shop | null): shop is Shop {
  return shop !== null && shop.mode === 'real' && shop.uninstalled_at === null;
}

function pageBounds(body: ExportBody): { cursor: number; limit: number } | null {
  const cursor = body.cursor ?? 0;
  const limit = body.limit ?? MAX_PAGE_SIZE;
  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return null;
  return { cursor, limit };
}

function productRows(shopDomain: string, products: readonly Product[]): Record<string, unknown>[] {
  return products.map((product) => ({
    shop_domain: shopDomain,
    variant_gid: product.variant_gid,
    product_gid: product.product_gid,
    title: product.title,
    variant_title: product.variant_title,
    sku: product.sku,
    vendor: product.vendor,
    product_type: product.product_type,
    status: product.status,
    price_cents: product.price_cents,
    compare_at_cents: product.compare_at_cents,
    cogs_cents: product.cogs_cents,
    cogs_source: product.cogs_source,
    inventory_quantity: product.inventory_quantity,
    excluded_from_pricing: exclusionReasonFor(product) !== null,
    last_synced_at: product.last_synced_at,
  }));
}

async function productDayRows(
  shopId: string,
  shopDomain: string,
  cursor: number,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const adapter = getAdapter();
  const rows = await adapter.getOrderDays(shopId, { offset: cursor, limit });
  const products = await adapter.getProductsByVariantGids(
    shopId,
    [...new Set(rows.map((row) => row.variant_gid))],
  );
  const prices = new Map(products.map((product) => [product.variant_gid, product.price_cents]));
  return rows.map((row) => ({
    shop_domain: shopDomain,
    variant_gid: row.variant_gid,
    day: row.day,
    units: row.units,
    list_price_cents: row.list_price_cents ?? prices.get(row.variant_gid) ?? null,
    net_revenue_cents: row.net_revenue_cents,
    on_promo: row.on_promo,
    had_stockout: row.had_stockout,
  }));
}

async function appliedJournalPage(
  shopId: string,
  shopDomain: string,
  cursor: number,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; nextCursor: number | null }> {
  const adapter = getAdapter();
  const rows: JournalEntry[] = [];
  let offset = cursor;
  let exhausted = false;
  while (rows.length < limit && !exhausted) {
    const batchSize = Math.min(MAX_PAGE_SIZE, limit - rows.length);
    const page = await adapter.listJournalEntries(shopId, { limit: batchSize, offset });
    rows.push(...page.items.filter((entry) => entry.status === 'applied'));
    offset += page.items.length;
    exhausted = offset >= page.total || page.items.length < batchSize;
  }
  const mapped = rows
    .sort((left, right) =>
      left.variant_gid === right.variant_gid
        ? left.applied_at.localeCompare(right.applied_at)
        : left.variant_gid.localeCompare(right.variant_gid),
    )
    .map((entry) => ({
      shop_domain: shopDomain,
      variant_gid: entry.variant_gid,
      applied_at: entry.applied_at,
      before_price_cents: entry.before_price_cents,
      after_price_cents: entry.after_price_cents,
      source: entry.source,
      rollout_id: entry.rollout_id,
      stage_index: entry.stage_index,
    }));
  return { rows: mapped, nextCursor: exhausted ? null : offset };
}

async function rolloutWindowRows(
  shopId: string,
  shopDomain: string,
  timezone: string,
): Promise<Record<string, unknown>[]> {
  const adapter = getAdapter();
  const rollouts = (await adapter.listRollouts(shopId)).filter(
    (rollout): rollout is Rollout & { started_at: string } => rollout.started_at !== null,
  );
  const variants = await adapter.listRolloutVariantsForShop(shopId);
  const gids = new Map<string, string[]>();
  for (const variant of variants) {
    if (variant.excluded) continue;
    const current = gids.get(variant.rollout_id) ?? [];
    current.push(variant.variant_gid);
    gids.set(variant.rollout_id, current);
  }
  return rollouts
    .sort((left, right) => left.started_at.localeCompare(right.started_at))
    .map((rollout) => ({
      shop_domain: shopDomain,
      rollout_id: rollout.id,
      status: rollout.status,
      start_day: dayInTimeZone(new Date(rollout.started_at), timezone),
      end_day:
        rollout.ended_at === null ? today(timezone) : dayInTimeZone(new Date(rollout.ended_at), timezone),
      variant_gids: [...(gids.get(rollout.id) ?? [])].sort(),
    }));
}

async function readSurface(body: ExportBody): Promise<NextResponse> {
  const bounds = pageBounds(body);
  if (bounds === null) return fail('invalid_request', 'cursor or limit is outside the allowed range.', 400);
  if (!isSurface(body.surface)) {
    return fail('invalid_request', 'A supported read surface is required.', 400);
  }
  const shopDomain = body.shop_domain?.trim().toLowerCase();
  if (shopDomain === undefined || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return fail('invalid_request', 'A canonical Shopify shop domain is required.', 400);
  }
  const adapter = getAdapter();
  const shop = await adapter.getShopByDomain(shopDomain);
  if (!isExportableShop(shop)) return fail('shop_not_connected', 'The requested real store is not connected.', 404);

  let page: Record<string, unknown>[];
  let nextCursor: number | null;
  switch (body.surface) {
    case 'products': {
      const products = await adapter.listProducts(shop.id, { limit: bounds.limit, offset: bounds.cursor });
      page = productRows(shop.shop_domain, products.items);
      const next = bounds.cursor + products.items.length;
      nextCursor = next < products.total ? next : null;
      break;
    }
    case 'product_days': {
      page = await productDayRows(shop.id, shop.shop_domain, bounds.cursor, bounds.limit);
      nextCursor = page.length === bounds.limit ? bounds.cursor + page.length : null;
      break;
    }
    case 'price_history': {
      const result = await appliedJournalPage(shop.id, shop.shop_domain, bounds.cursor, bounds.limit);
      page = result.rows;
      nextCursor = result.nextCursor;
      break;
    }
    case 'rollout_windows': {
      const rows = await rolloutWindowRows(shop.id, shop.shop_domain, shop.timezone);
      page = rows.slice(bounds.cursor, bounds.cursor + bounds.limit);
      const next = bounds.cursor + page.length;
      nextCursor = next < rows.length ? next : null;
      break;
    }
  }
  return json({
    schema_version: 1,
    surface: body.surface,
    shop_domain: shop.shop_domain,
    rows: page,
    next_cursor: nextCursor,
  });
}

async function verifyReceipts(body: ExportBody): Promise<NextResponse> {
  const shopDomain = body.shop_domain?.trim().toLowerCase();
  if (shopDomain === undefined || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return fail('invalid_request', 'A canonical Shopify shop domain is required.', 400);
  }
  if (!Array.isArray(body.receipts) || body.receipts.length < 1 || body.receipts.length > MAX_RECEIPTS) {
    return fail('invalid_request', `receipts must contain 1 to ${MAX_RECEIPTS} rows.`, 400);
  }
  const expected = new Map<string, { git_sha: string; rows_written: number }>();
  for (const receipt of body.receipts) {
    if (
      typeof receipt.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.id) ||
      typeof receipt.git_sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(receipt.git_sha) ||
      !Number.isSafeInteger(receipt.rows_written) ||
      (receipt.rows_written as number) < 1 ||
      expected.has(receipt.id)
    ) {
      return fail('invalid_request', 'Every receipt must be unique and contain a valid id, git_sha and row count.', 400);
    }
    expected.set(receipt.id, { git_sha: receipt.git_sha, rows_written: receipt.rows_written as number });
  }

  const adapter = getAdapter();
  const shop = await adapter.getShopByDomain(shopDomain);
  if (!isExportableShop(shop)) return fail('shop_not_connected', 'The requested real store is not connected.', 404);
  const runs = await adapter.getModelRunsByIds(shop.id, [...expected.keys()]);
  const verified = runs.filter((run) => {
    const receipt = expected.get(run.id);
    return (
      receipt !== undefined &&
      run.status === 'succeeded' &&
      run.git_sha === receipt.git_sha &&
      run.rows_written === receipt.rows_written
    );
  });
  if (verified.length !== expected.size) {
    return fail('receipt_mismatch', 'Not every acknowledged model run passed server-side read-back.', 409);
  }
  return json({ schema_version: 1, shop_domain: shop.shop_domain, verified: verified.length });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isMlPipelineAuthorised(request)) {
    return fail('unauthorized', 'Missing or invalid ML pipeline secret.', 401);
  }
  if (getMode() !== 'real') {
    return fail('source_not_real', 'The ML export is unavailable outside real-store mode.', 503);
  }
  let body: ExportBody;
  try {
    body = (await request.json()) as ExportBody;
  } catch {
    return fail('invalid_request', 'Body is not valid JSON.', 400);
  }

  try {
    if (body.operation === 'attest') {
      const ref = projectRef();
      if (ref === null) return fail('source_not_configured', 'The ML source identity is not configured safely.', 503);
      const shops = (await getAdapter().listShops())
        .filter(isExportableShop)
        .map((shop) => shop.shop_domain)
        .sort();
      return json({
        schema_version: 1,
        source: 'priceflag-ml-export',
        project_ref: ref,
        environment: sourceEnvironment(),
        shops,
      });
    }
    // Await inside this try block: returning the promises directly would let a
    // later adapter rejection bypass the structured backend_unavailable catch.
    if (body.operation === 'read') return await readSurface(body);
    if (body.operation === 'verify_receipts') return await verifyReceipts(body);
    return fail('invalid_request', 'A supported operation is required.', 400);
  } catch (cause) {
    // Keep the response machine-readable even when PostgREST, Supabase, or a
    // mapper throws. The raw cause belongs in protected runtime logs; returning
    // it here could expose schema or infrastructure details to the worker log.
    console.error('ML export backend operation failed', cause);
    return fail('backend_unavailable', 'The ML export backend is temporarily unavailable.', 503, true);
  }
}
