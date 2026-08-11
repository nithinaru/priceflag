/**
 * Where an Admin API token comes from.
 *
 * Priceflag supports two Shopify app types, and they authenticate differently:
 *
 *   **Path A — admin-created custom app** (`SHOPIFY_ADMIN_ACCESS_TOKEN`).
 *   Created in a store's own admin. Authenticates with a static token, has no
 *   install flow, and already has full order history without `read_all_orders`.
 *   This is what the dev store uses and what B3's sync runs against.
 *
 *   **Path B — Partner-Dashboard app with custom distribution** (OAuth).
 *   Required to install on stores you do not own, i.e. every pilot. The offline
 *   token lands encrypted in `shops.access_token_enc`.
 *
 * Both exist on purpose. Everything above this module — the sync pipeline, the
 * price writer, the evaluator — takes credentials from here and never reads env
 * or the token column itself, so neither path is special-cased twice.
 *
 * Server-only.
 */

import { env, getShopifyApiVersion, getStaticShopDomain, hasStaticShopifyToken } from '../config';
import { decryptSecret, isEncryptedSecret } from '../crypto';
import type { StoreAdapter } from '../adapters/types';
import type { Shop } from '../types';
import { normalizeShopDomain } from './oauth';

export type CredentialSource = 'static_env' | 'oauth_stored';

export interface ShopCredentials {
  shopDomain: string;
  /** Plaintext Admin API token. Never log this, never return it from a route. */
  accessToken: string;
  apiVersion: string;
  source: CredentialSource;
}

export class CredentialError extends Error {
  constructor(
    readonly code:
      | 'no_credentials'
      | 'shop_not_connected'
      | 'shop_uninstalled'
      | 'static_credentials_forbidden'
      | 'token_undecryptable'
      | 'kill_switch_engaged',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** The shop the static token belongs to, if one is configured. */
export function staticShopDomain(): string | null {
  if (!hasStaticShopifyToken()) return null;
  const domain = getStaticShopDomain();
  return domain === undefined ? null : normalizeShopDomain(domain);
}

function isProductionRuntime(): boolean {
  return env('VERCEL_ENV') === 'production' || env('NODE_ENV') === 'production';
}

function staticCredentialsFor(shopDomain: string, apiVersion: string): ShopCredentials {
  if (isProductionRuntime()) {
    throw new CredentialError(
      'static_credentials_forbidden',
      'SHOPIFY_ADMIN_ACCESS_TOKEN is restricted to local development and cannot authorize a production Shopify operation. Install the OAuth app for this store.',
    );
  }
  return {
    shopDomain,
    accessToken: env('SHOPIFY_ADMIN_ACCESS_TOKEN') as string,
    apiVersion,
    source: 'static_env',
  };
}

/**
 * Resolve credentials for a shop.
 *
 * The static token wins when it is configured *for that same shop* — it needs no
 * `ENCRYPTION_KEY` and cannot go stale, so on the dev store it is strictly the
 * more reliable path. A static token for a different shop is ignored rather than
 * used, because sending one store's token at another store's API is the kind of
 * mistake that is very hard to see in a log.
 */
export async function resolveShopCredentials(
  adapter: StoreAdapter,
  shopDomain?: string,
): Promise<ShopCredentials> {
  const staticDomain = staticShopDomain();
  const wanted = shopDomain === undefined ? staticDomain : normalizeShopDomain(shopDomain);

  if (wanted === null) {
    throw new CredentialError(
      'no_credentials',
      'No shop specified and no SHOPIFY_SHOP_DOMAIN configured. Pass a shop domain or set the static-token env vars.',
    );
  }

  const shop = await adapter.getShopByDomain(wanted);
  if (shop !== null) return credentialsFromShop(shop);
  if (staticDomain !== null && staticDomain === wanted) {
    return staticCredentialsFor(wanted, getShopifyApiVersion());
  }
  throw new CredentialError('shop_not_connected', `${wanted} has not been connected to Priceflag.`);
}

/** Same resolution from an already-loaded shop row. */
export function credentialsFromShop(shop: Shop): ShopCredentials {
  // This check must precede every credential source. In particular, a matching
  // local static token must never resurrect a shop after app/uninstalled.
  if (shop.uninstalled_at !== null) {
    throw new CredentialError(
      'shop_uninstalled',
      `${shop.shop_domain} uninstalled Priceflag on ${shop.uninstalled_at}. Reinstall to reconnect.`,
    );
  }

  const staticDomain = staticShopDomain();
  if (staticDomain !== null && staticDomain === shop.shop_domain) {
    // Production falls through to the encrypted OAuth token when one exists;
    // the static environment token is never a production capability.
    if (!isProductionRuntime()) {
      return staticCredentialsFor(shop.shop_domain, shop.api_version || getShopifyApiVersion());
    }
  }
  if (shop.access_token_enc === null || shop.access_token_enc === '') {
    if (staticDomain !== null && staticDomain === shop.shop_domain && isProductionRuntime()) {
      throw new CredentialError(
        'static_credentials_forbidden',
        'SHOPIFY_ADMIN_ACCESS_TOKEN is restricted to local development and cannot authorize a production Shopify operation. Install the OAuth app for this store.',
      );
    }
    throw new CredentialError(
      'shop_not_connected',
      `${shop.shop_domain} has no stored Shopify token. Reinstall the app.`,
    );
  }
  if (!isEncryptedSecret(shop.access_token_enc)) {
    throw new CredentialError(
      'token_undecryptable',
      `${shop.shop_domain}'s stored token is not in the expected encrypted format.`,
    );
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(shop.access_token_enc);
  } catch (cause) {
    // Almost always a rotated or mismatched ENCRYPTION_KEY. Say so, because the
    // fix is different from every other auth failure.
    throw new CredentialError(
      'token_undecryptable',
      `Could not decrypt ${shop.shop_domain}'s token. ENCRYPTION_KEY may have changed since install; ` +
        'the merchant needs to reinstall. ' +
        (cause instanceof Error ? cause.message : ''),
    );
  }

  return {
    shopDomain: shop.shop_domain,
    accessToken,
    apiVersion: shop.api_version || getShopifyApiVersion(),
    source: 'oauth_stored',
  };
}

/**
 * R21: refuse to hand out credentials for a shop whose kill switch is engaged.
 *
 * Enforced at the credential boundary rather than in each writer, so a future
 * writer cannot forget it. Read paths call `credentialsFromShop` directly.
 */
export function assertWritable(shop: Shop): void {
  if (shop.kill_switch_engaged_at !== null) {
    throw new CredentialError(
      'kill_switch_engaged',
      `The kill switch is engaged for ${shop.shop_domain} (since ${shop.kill_switch_engaged_at}). ` +
        'No prices can be written until it is released.',
    );
  }
}

/**
 * Ensure a shop row exists for the statically-configured store.
 *
 * The static-token path has no install flow, so nothing else would ever create
 * the row that every other table's foreign key points at. Idempotent.
 */
export async function ensureStaticShop(adapter: StoreAdapter): Promise<Shop | null> {
  const domain = staticShopDomain();
  if (domain === null) return null;

  const existing = await adapter.getShopByDomain(domain);
  if (existing !== null) return existing;

  return adapter.upsertShop({
    shop_domain: domain,
    name: domain.replace(/\.myshopify\.com$/, ''),
    mode: 'real',
    api_version: getShopifyApiVersion(),
    // No token stored: the static path reads it from env every time, so there is
    // no plaintext or ciphertext of it in the database at all.
    access_token_enc: null,
    scopes: 'read_products,write_products,read_orders,read_all_orders(implicit)',
    installed_at: new Date().toISOString(),
  });
}
