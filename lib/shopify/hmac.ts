/**
 * Shopify request authentication.
 *
 * Two different HMAC schemes, and mixing them up is a security bug rather than a
 * bug:
 *
 *   - **OAuth callback** — HMAC-SHA256 over the sorted query string, compared as
 *     **hex**. Every parameter except `hmac` is included.
 *   - **Webhooks** — HMAC-SHA256 over the **raw request body**, compared as
 *     **base64**, against `X-Shopify-Hmac-Sha256`.
 *
 * Both use the app's client secret as the key, and both compare in constant time.
 * Verified against shopify.dev (Admin API 2026-07); the OAuth procedure removes
 * only `hmac` — an older generation of Shopify docs also excluded `signature`, and
 * excluding it today would make valid requests fail.
 */

import { createHmac } from 'node:crypto';

import { safeEqual } from '../crypto';

/**
 * Verify the HMAC on an OAuth callback (or any signed Shopify redirect).
 *
 * Takes the query parameters rather than a URL string so there is no chance of
 * verifying a re-encoded version of what actually arrived.
 */
export function verifyOAuthHmac(params: URLSearchParams, clientSecret: string): boolean {
  const received = params.get('hmac');
  if (received === null || received === '') return false;

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    // Only `hmac` is excluded. Not `signature` — Shopify includes it in the
    // digest, so dropping it here would reject legitimate requests.
    if (key === 'hmac') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const digest = createHmac('sha256', clientSecret).update(pairs.join('&'), 'utf8').digest('hex');
  return safeEqual(digest, received);
}

/**
 * Verify a webhook against the raw body.
 *
 * `rawBody` must be the bytes exactly as received — `await request.text()` before
 * any JSON parsing. Re-serialising parsed JSON changes key order and whitespace
 * and the digest will never match.
 */
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  headerHmac: string | null,
  clientSecret: string,
): boolean {
  if (headerHmac === null || headerHmac === '') return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const digest = createHmac('sha256', clientSecret).update(body).digest('base64');
  return safeEqual(digest, headerHmac);
}

/** For tests and for the local webhook simulator in `scripts/`. */
export function signWebhookBody(rawBody: string | Buffer, clientSecret: string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', clientSecret).update(body).digest('base64');
}

/** For tests: produce the `hmac` Shopify would send for these parameters. */
export function signOAuthParams(params: URLSearchParams, clientSecret: string): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hmac') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return createHmac('sha256', clientSecret).update(pairs.join('&'), 'utf8').digest('hex');
}
