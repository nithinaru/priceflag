/**
 * Shopify global ids.
 *
 * Priceflag stores and passes full GIDs ("gid://shopify/ProductVariant/42")
 * everywhere, never bare numeric ids. A bare `42` is ambiguous across resource
 * types and the Admin GraphQL API wants the GID back anyway; converting at the
 * edges is where mismatched ids come from.
 */

export type GidResource =
  | 'Product'
  | 'ProductVariant'
  | 'InventoryItem'
  | 'Order'
  | 'Shop'
  | 'SellingPlan';

const GID_PATTERN = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/;

export function toGid(resource: GidResource, id: string | number): string {
  const numeric = String(id);
  if (!/^\d+$/.test(numeric)) {
    throw new TypeError(`${resource} id must be numeric, got ${JSON.stringify(id)}`);
  }
  return `gid://shopify/${resource}/${numeric}`;
}

export function parseGid(gid: string): { resource: string; id: string } | null {
  const match = GID_PATTERN.exec(gid);
  if (!match) return null;
  return { resource: match[1] as string, id: match[2] as string };
}

/** Numeric id from a GID. Throws rather than returning a misleading empty string. */
export function gidId(gid: string): string {
  const parsed = parseGid(gid);
  if (!parsed) throw new TypeError(`not a Shopify gid: ${JSON.stringify(gid)}`);
  return parsed.id;
}

export function isGid(value: unknown, resource?: GidResource): value is string {
  if (typeof value !== 'string') return false;
  const parsed = parseGid(value);
  if (!parsed) return false;
  return resource === undefined || parsed.resource === resource;
}

export const isVariantGid = (value: unknown): value is string => isGid(value, 'ProductVariant');
export const isProductGid = (value: unknown): value is string => isGid(value, 'Product');

/**
 * Accepts a GID or a bare numeric id and returns a GID. For hand-typed input in
 * scripts and runbooks only — application code should already hold GIDs.
 */
export function coerceGid(resource: GidResource, value: string | number): string {
  if (typeof value === 'string' && value.startsWith('gid://')) {
    const parsed = parseGid(value);
    if (!parsed) throw new TypeError(`not a Shopify gid: ${JSON.stringify(value)}`);
    if (parsed.resource !== resource) {
      throw new TypeError(`expected a ${resource} gid, got a ${parsed.resource} gid`);
    }
    return value;
  }
  return toGid(resource, value);
}
