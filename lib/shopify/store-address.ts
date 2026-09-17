/**
 * Turning what a merchant types into a shop domain.
 *
 * The sign-in screen is one field, so this function is the entire difference
 * between "it worked" and "it told me my store address was wrong". It accepts
 * every shape a merchant plausibly has to hand — the bare handle, the full
 * `.myshopify.com` domain, a pasted admin URL — because the alternative is
 * making somebody work out that Shopify calls their store something other than
 * what the address bar shows them.
 *
 * Permissive on input, strict on output: whatever comes back is a domain
 * `normalizeShopDomain` in `oauth.ts` will also accept, and that one is
 * deliberately stricter than Shopify's own published regex because the value
 * ends up in a URL we send a client secret to. This is a convenience layer in
 * front of that check, never a replacement for it.
 */

const HANDLE = /^[a-z0-9][a-z0-9-]*$/;
const SUFFIX = '.myshopify.com';

/** The handle out of `admin.shopify.com/store/<handle>/…`, the most-pasted shape. */
const ADMIN_URL = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/;

export function normalizeStoreAddress(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value === '') return null;
  value = value.replace(/^https?:\/\//, '');

  const admin = ADMIN_URL.exec(value);
  if (admin !== null) return `${admin[1] as string}${SUFFIX}`;

  value = value.replace(/\/.*$/, '');

  if (value.endsWith(SUFFIX)) {
    const handle = value.slice(0, -SUFFIX.length);
    return HANDLE.test(handle) ? value : null;
  }
  if (!HANDLE.test(value)) return null;
  return `${value}${SUFFIX}`;
}
