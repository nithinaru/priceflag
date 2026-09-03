/**
 * Which store does this account own?
 *
 * The link between a Supabase account and a `shops` row. It exists so that a
 * merchant who signed in from signin.priceflag.org — with no Shopify admin
 * iframe and therefore no session token — still lands on their own data instead
 * of the connect screen every time.
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
 */
export async function getShopDomainForAccount(userId: string): Promise<string | null> {
  if (!hasSupabaseConfig()) return null;

  const client = getServiceClient();
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

/**
 * Every signed-in person who has connected this store, for notifications.
 *
 * The fallback recipient list: a shop whose owner never filled in
 * `notify_emails` and whose Shopify contact email is empty would otherwise have
 * its guardrail alerts sent to nobody, silently.
 */
export async function listAccountEmailsForShop(shopId: string): Promise<string[]> {
  if (!hasSupabaseConfig()) return [];
  const client = getServiceClient();
  const rows = unwrap(
    await client.from(LINKS_TABLE).select('accounts(email)').eq('shop_id', shopId),
    'read account emails for shop',
  ) as { accounts?: { email?: unknown } | { email?: unknown }[] | null }[];
  const emails = new Set<string>();
  for (const row of rows) {
    const embedded = Array.isArray(row.accounts) ? row.accounts : [row.accounts];
    for (const account of embedded) {
      if (typeof account?.email === 'string' && account.email.includes('@')) emails.add(account.email);
    }
  }
  return [...emails];
}
