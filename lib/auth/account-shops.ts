/**
 * Which store does this account own?
 *
 * The link between an account and a `shops` row. It exists so that a merchant
 * who opens the dashboard directly — with no Shopify admin iframe and therefore
 * no session token — still lands on their own data instead of the connect
 * screen every time.
 *
 * Since the install is the sign-up, an account id is a `shops.id`, so the link
 * is now mostly a record of *when* a store was connected rather than the only
 * way to find it. `account_shops` is kept because support and compliance
 * deletion both start from "who connected this store", and because accounts
 * created before that change have ids that name no shop at all.
 *
 * This is a *convenience* claim, not an authorisation one, and the distinction
 * matters. The row says "this person connected this store at some point". It is
 * written at the end of the OAuth install, when Shopify has just told us both
 * facts at once, and it is only ever read for someone whose `pf_user` cookie has
 * already verified. It is never a substitute for a session token on a price
 * write — those still go through `resolveShopFromRequest`.
 *
 * Server-only: it uses the service role client.
 */

import { getServiceClient, unwrap, unwrapMaybe } from '../db/client';
import { hasSupabaseConfig } from '../config';

const ACCOUNTS_TABLE = 'accounts';
const LINKS_TABLE = 'account_shops';
const SHOPS_TABLE = 'shops';

/** Upsert the account row. Called on every successful sign-in. */
export async function rememberAccount(userId: string, email: string): Promise<void> {
  if (!hasSupabaseConfig()) return;

  const client = getServiceClient();
  unwrap(
    await client
      .from(ACCOUNTS_TABLE)
      .upsert(
        { id: userId, email, last_seen_at: new Date().toISOString() },
        { onConflict: 'id' },
      )
      .select('id')
      .single(),
    'upsert account',
  );
}

/**
 * The domain of the store this account most recently connected, or `null`.
 *
 * "Most recent" rather than "the one" because a person may connect more than one
 * store over time. Multi-store switching is not built yet; when it is, this is
 * the function that grows a shop picker behind it rather than a new concept.
 *
 * Returns the domain rather than the id so that callers can go through
 * `getShopByDomain`, which every adapter already implements — the demo adapter
 * included, which has no accounts table to join against.
 *
 * Two sources, in order of how much they can be trusted to exist: the shop row
 * the account id already names, then the `account_shops` link for the older
 * accounts whose ids name nothing.
 */
export async function getShopDomainForAccount(userId: string): Promise<string | null> {
  if (!hasSupabaseConfig()) return null;

  const client = getServiceClient();

  // The account id *is* the `shops.id` of the store whose install created it
  // (`store-account.ts`), so the authoritative answer is one lookup on the shop
  // row itself — no join, and nothing that can be missing.
  //
  // Tried first, and deliberately so: `account_shops` is a record of a past
  // event, and a record can fail to be written. If that insert lost a race, hit
  // a constraint, or simply has not been backfilled, resolving through it would
  // strand a merchant whose store is sitting right there under the id they are
  // already carrying. Reading the shop directly cannot have that failure mode.
  const direct = unwrapMaybe(
    await client.from(SHOPS_TABLE).select('shop_domain').eq('id', userId).maybeSingle(),
    'read shop for account',
  );
  const directDomain = (direct as { shop_domain?: unknown } | null)?.shop_domain;
  if (typeof directDomain === 'string') return directDomain;

  // Fallback for accounts that predate store-keyed ids — the magic-link era,
  // whose ids are Supabase Auth uuids matching no shop. For those the link row
  // is the only thing that knows.
  const row = unwrapMaybe(
    await client
      .from(LINKS_TABLE)
      // The embedded select is the join: one round trip instead of id-then-domain.
      .select('shops(shop_domain)')
      .eq('user_id', userId)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'read account shop link',
  );

  if (row === null) return null;
  // PostgREST returns an embedded to-one either as an object or, depending on
  // how it infers the relationship, as a one-element array. Handle both.
  const embedded = (row as { shops?: unknown }).shops;
  const shop = Array.isArray(embedded) ? embedded[0] : embedded;
  const domain = (shop as { shop_domain?: unknown } | undefined)?.shop_domain;
  return typeof domain === 'string' ? domain : null;
}

/**
 * Record that this account connected this store. Called from the OAuth callback,
 * which is the one moment both facts are established at the same time.
 */
export async function linkAccountToShop(userId: string, shopId: string): Promise<void> {
  if (!hasSupabaseConfig()) return;

  const client = getServiceClient();
  unwrap(
    await client
      .from(LINKS_TABLE)
      .upsert(
        { user_id: userId, shop_id: shopId, connected_at: new Date().toISOString() },
        { onConflict: 'user_id,shop_id' },
      )
      .select('user_id')
      .single(),
    'link account to shop',
  );
}
