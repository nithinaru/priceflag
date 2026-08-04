/**
 * Shopify OAuth — the authorization code grant, offline token.
 *
 * Offline, not per-user: the evaluator has to be able to restore a price at 3am
 * with nobody logged in. An online token would expire and auto-rollback would
 * silently stop working, which is the one failure this product cannot have.
 *
 * Verified against shopify.dev for Admin API 2026-07.
 */

import { randomBytes } from 'node:crypto';

import { getAppUrl, getShopifyApiVersion, getShopifyScopes, requireEnv } from '../config';
import { safeEqual } from '../crypto';

export class ShopifyAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_shop_domain'
      | 'invalid_hmac'
      | 'state_mismatch'
      | 'token_exchange_failed'
      | 'scope_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ShopifyAuthError';
  }
}

/**
 * Shopify's own rule: a valid hostname ending in `myshopify.com`, containing only
 * letters, numbers, periods and hyphens. Anchored at both ends here — Shopify's
 * published regex is not anchored at the end, which would accept
 * `evil.myshopify.com.attacker.test`. This value ends up in a URL we send a
 * client secret to, so it gets the stricter check.
 */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  const candidate = shop.trim().toLowerCase();
  if (candidate.length > 255 || candidate.includes('..')) return false;
  return SHOP_DOMAIN.test(candidate);
}

export function normalizeShopDomain(shop: string): string {
  const candidate = shop.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!isValidShopDomain(candidate)) {
    throw new ShopifyAuthError('invalid_shop_domain', `not a Shopify shop domain: ${JSON.stringify(shop)}`);
  }
  return candidate;
}

/** Opaque, single-use nonce. Kept in an HttpOnly cookie and checked on callback. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function verifyOAuthState(received: string | null, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  return safeEqual(received, expected);
}

export const OAUTH_STATE_COOKIE = 'priceflag_oauth_state';

/**
 * Carries the `host` param Shopify sent when the install started from inside the
 * admin. Its presence at callback time is what tells us to land the merchant
 * back in the embedded app rather than on our own origin.
 */
export const OAUTH_HOST_COOKIE = 'priceflag_oauth_host';

export function buildAuthorizeUrl(options: {
  shop: string;
  state: string;
  scopes?: readonly string[];
  redirectUri?: string;
  clientId?: string;
}): string {
  const shop = normalizeShopDomain(options.shop);
  const clientId = options.clientId ?? requireEnv('SHOPIFY_API_KEY', 'From the app\'s API credentials.');
  const scopes = options.scopes ?? getShopifyScopes();

  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', scopes.join(','));
  url.searchParams.set('redirect_uri', options.redirectUri ?? defaultRedirectUri());
  url.searchParams.set('state', options.state);
  // `grant_options[]` is deliberately omitted: present with `per-user` it yields
  // an online token, absent it yields the offline token the evaluator needs.
  return url.toString();
}

export function defaultRedirectUri(): string {
  return `${getAppUrl()}/api/auth/callback`;
}

export interface AccessTokenResponse {
  access_token: string;
  scope: string;
  /** Present only for expiring tokens, which we do not request. */
  expires_in?: number;
  refresh_token?: string;
}

/**
 * Exchange the authorization code for an offline access token.
 *
 * `fetchImpl` is injectable so the request shape and the response handling can be
 * tested without a Shopify store.
 */
export async function exchangeCodeForToken(options: {
  shop: string;
  code: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}): Promise<AccessTokenResponse> {
  const shop = normalizeShopDomain(options.shop);
  const clientId = options.clientId ?? requireEnv('SHOPIFY_API_KEY');
  const clientSecret = options.clientSecret ?? requireEnv('SHOPIFY_API_SECRET');
  const doFetch = options.fetchImpl ?? fetch;

  const response = await doFetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: options.code }),
  });

  if (!response.ok) {
    // Deliberately does not include the response body: on a misconfiguration
    // Shopify can echo request details, and this string reaches logs.
    throw new ShopifyAuthError(
      'token_exchange_failed',
      `Shopify rejected the token exchange for ${shop} (HTTP ${response.status}). ` +
        'Check SHOPIFY_API_KEY / SHOPIFY_API_SECRET and that the redirect URL is allow-listed on the app.',
    );
  }

  const payload = (await response.json()) as Partial<AccessTokenResponse>;
  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw new ShopifyAuthError('token_exchange_failed', `Shopify returned no access token for ${shop}`);
  }

  return {
    access_token: payload.access_token,
    scope: payload.scope ?? '',
    expires_in: payload.expires_in,
    refresh_token: payload.refresh_token,
  };
}

/**
 * Did we get the scopes we asked for?
 *
 * `read_all_orders` is the one that matters: without it the Admin API silently
 * caps order history at 60 days, and every elasticity fit would be quietly built
 * on two months of data while the UI claimed 180 days. Better to fail the install.
 */
export function missingScopes(granted: string, required: readonly string[] = getShopifyScopes()): string[] {
  const have = new Set(
    granted
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  return required.filter((scope) => !have.has(scope));
}

/**
 * Where to send the merchant after a successful install.
 *
 * An embedded install (Shopify sent a `host` param) must land back inside the
 * Shopify admin — redirecting to our own origin would leave the merchant on a
 * bare top-level page with no App Bridge and no session. The admin then reloads
 * the app iframe with fresh launch params. The store handle is the myshopify
 * subdomain.
 */
export function postInstallUrl(shop: string, host?: string | null): string {
  const domain = normalizeShopDomain(shop);
  if (host) {
    const handle = domain.replace(/\.myshopify\.com$/, '');
    const clientId = requireEnv('SHOPIFY_API_KEY');
    return `https://admin.shopify.com/store/${handle}/apps/${clientId}`;
  }
  return `${getAppUrl()}/?shop=${encodeURIComponent(domain)}&installed=1`;
}

/** The Admin GraphQL endpoint for a shop, at the pinned API version. */
export function adminGraphqlUrl(shop: string, apiVersion = getShopifyApiVersion()): string {
  return `https://${normalizeShopDomain(shop)}/admin/api/${apiVersion}/graphql.json`;
}
