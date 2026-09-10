/**
 * The store is the identity.
 *
 * Priceflag has one door: installing the Shopify app. There is no separate
 * sign-up, no password, and no emailed link — completing OAuth *is* the account
 * creation, and this module is the step that turns a finished install into
 * somebody the app can recognise on their next visit.
 *
 * The account id is the `shops.id` uuid rather than a freshly allocated one.
 * That is the whole trick: the session cookie a merchant carries resolves to
 * their store by construction, so there is no window in which somebody is
 * signed in but unattached, and nothing to stitch together afterwards. The old
 * flow minted an identity from an email address and then tried to find it a
 * store; this one never has an identity without a store.
 *
 * What this is NOT: authorisation. The email here is contact information read
 * from Shopify, and the `pf_user` cookie only decides which store's dashboard to
 * render. Every price write still verifies a Shopify session token in the route
 * handler, and every Admin API call still uses the encrypted offline token.
 */

import { linkAccountToShop, rememberAccount } from './account-shops';
import type { AccountSession } from './account';
import { AdminGraphqlClient } from '../shopify/client';
import { credentialsFromShop } from '../shopify/credentials';
import { SHOP_OWNER } from '../shopify/queries';
import type { Shop } from '../types';

export interface StoreIdentity {
  /** Display name of the store, as Shopify has it. */
  name: string | null;
  /** Shop owner's email. Contact only. */
  email: string;
}

/**
 * A stand-in address for when Shopify will not tell us who owns the store.
 *
 * `accounts.email` is `not null`, and an install must not fail because one
 * cosmetic read timed out. `.myshopify.com` is a real domain Shopify controls
 * and does not accept mail on, so this is unambiguously a placeholder rather
 * than something a support tool would try to write to. The next sync overwrites
 * `shops.email` with the store's real contact address regardless.
 */
export function placeholderEmail(shopDomain: string): string {
  return `owner@${shopDomain.toLowerCase()}`;
}

/**
 * Ask Shopify who owns this store.
 *
 * Returns `null` rather than throwing: this runs inside the merchant's redirect
 * at the end of an install Shopify already considers complete, and there is no
 * version of "we could not read your store name" that justifies losing it.
 */
export async function fetchStoreIdentity(
  shop: Shop,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<StoreIdentity | null> {
  try {
    const client = new AdminGraphqlClient(credentialsFromShop(shop), {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      // One attempt at a two-field query. A retry storm here would spend the
      // redirect's budget on something the app degrades past without noticing.
      maxRetries: 1,
    });
    const result = await client.request<{ shop: { name: string | null; email: string | null } }>(
      SHOP_OWNER,
    );
    const email = result.shop.email;
    return {
      name: result.shop.name,
      email:
        typeof email === 'string' && email.includes('@')
          ? email.trim().toLowerCase()
          : placeholderEmail(shop.shop_domain),
    };
  } catch (cause) {
    console.error(
      `[install] could not read shop owner for ${shop.shop_domain}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    return null;
  }
}

/**
 * Create (or refresh) the account for a store that has just finished installing,
 * and return the session to put in a cookie.
 *
 * Ordering matters in one direction only: the account row must exist before the
 * link, because `account_shops.user_id` references it. Both writes are
 * best-effort — a database hiccup must not cost somebody an install they have
 * already granted — and the returned session is valid either way, because it is
 * derived from the shop row rather than read back from a table.
 */
export async function establishStoreAccount(
  shop: Shop,
  identity: StoreIdentity | null,
): Promise<AccountSession> {
  const email = identity?.email ?? placeholderEmail(shop.shop_domain);
  const session: AccountSession = { userId: shop.id, email };

  try {
    await rememberAccount(session.userId, email);
    await linkAccountToShop(session.userId, shop.id);
  } catch (cause) {
    // Losing these rows costs a merchant one trip through `/connect` on a later
    // visit. Losing the install costs them the install.
    console.error(
      `[install] could not record the account for ${shop.shop_domain}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }

  return session;
}
