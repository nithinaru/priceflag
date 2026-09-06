/**
 * Where the session cookie may be minted, and which hosts are only a door.
 *
 * Shopify OAuth and the magic-link bind cookie are host-only. If the form lives
 * on signin.priceflag.org while APP_URL (and the emailed token URL) is
 * dashboard.priceflag.org, the click lands on a host that never received
 * `pf_link` / `priceflag_oauth_state` and the round-trip fails. One session
 * origin:
 *
 *   - Cookies and callbacks: dashboard.priceflag.org
 *   - signin.priceflag.org / product.priceflag.org: 308 there, do not issue cookies
 *   - priceflag.org: marketing (`priceflagv1`) — this app must never claim it
 */

import { env, getAppUrl } from '../config';

export const SESSION_ORIGIN = 'https://dashboard.priceflag.org';

/** Hosts allowed to mint `pf_user` / OAuth state and to appear in emailed links. */
const PINNED_SESSION_HOSTS = ['dashboard.priceflag.org'] as const;

/**
 * Sibling hosts that, once bound to this app, 308 onto the dashboard.
 * Not the marketing apex — that stays on `priceflagv1`.
 */
const ALIAS_ENTRY_HOSTS = ['signin.priceflag.org', 'product.priceflag.org'] as const;

/** Marketing doors. They must not set the session cookie or appear in emails. */
const BRANDED_ENTRY_HOSTS = ['signin.priceflag.org', 'www.priceflag.org', 'priceflag.org'] as const;

function hostnameOf(value: string): string | null {
  try {
    const withScheme = value.startsWith('http') ? value : `https://${value}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function stripPort(hostname: string): string {
  return hostname.toLowerCase().split(':')[0] ?? hostname.toLowerCase();
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export function isAliasEntryHost(hostname: string): boolean {
  return (ALIAS_ENTRY_HOSTS as readonly string[]).includes(stripPort(hostname));
}

/**
 * Hosts that look public but must never appear in an emailed or Shopify callback
 * URL in production: the Vercel project hostname, localhost leftovers, marketing.
 */
function isUnsafeCallbackHost(hostname: string): boolean {
  const host = stripPort(hostname);
  if ((BRANDED_ENTRY_HOSTS as readonly string[]).includes(host)) return true;
  if (isAliasEntryHost(host)) return true;
  // Vercel sets NODE_ENV=production on preview too. Only the production
  // deployment must refuse localhost / vercel.app in emailed callback URLs.
  if (env('VERCEL_ENV') !== 'production') return false;
  return isLocalHost(host) || host.endsWith('.vercel.app');
}

export function allowedSessionHosts(): string[] {
  const hosts = new Set<string>(PINNED_SESSION_HOSTS);
  const fromApp = hostnameOf(getAppUrl());
  if (fromApp !== null && !isUnsafeCallbackHost(fromApp)) hosts.add(fromApp);

  if (env('VERCEL_ENV') !== 'production') {
    hosts.add('localhost');
    hosts.add('127.0.0.1');
  }
  return [...hosts];
}

export function isAllowedSessionHost(hostname: string): boolean {
  return allowedSessionHosts().includes(stripPort(hostname));
}

export function isBrandedEntryHost(hostname: string): boolean {
  return (BRANDED_ENTRY_HOSTS as readonly string[]).includes(stripPort(hostname));
}

/**
 * Origin that owns the session cookie. Production never returns a marketing
 * host, localhost, or a vercel.app project URL — those are how magic-link
 * emails silently point at a place that cannot complete sign-in.
 */
export function sessionOrigin(appUrl: string = getAppUrl()): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    url = new URL(SESSION_ORIGIN);
  }

  if (isUnsafeCallbackHost(url.hostname) || isBrandedEntryHost(url.hostname) || isAliasEntryHost(url.hostname)) {
    return SESSION_ORIGIN;
  }
  return url.origin;
}

/** Absolute magic-link landing URL. Always the session host, never the request host. */
export function magicLinkCallbackUrl(appUrl: string = getAppUrl()): string {
  return `${sessionOrigin(appUrl)}/auth/callback`;
}

/** Absolute Shopify OAuth redirect_uri. Same host as the authorize-start cookie. */
export function oauthCallbackUrl(appUrl: string = getAppUrl()): string {
  return `${sessionOrigin(appUrl)}/api/auth/callback`;
}

function isPreservedCallbackPath(pathname: string): boolean {
  return (
    pathname === '/auth/callback' ||
    pathname.startsWith('/auth/callback/') ||
    pathname === '/api/auth/callback' ||
    pathname.startsWith('/api/auth/callback/')
  );
}

/**
 * If this request arrived on signin.priceflag.org or product.priceflag.org,
 * the canonical URL on the dashboard. `null` means stay.
 *
 * Apex marketing (`priceflag.org`) is not rewritten here — that host belongs
 * to `priceflagv1`, not this app.
 */
export function canonicalSessionUrl(
  hostname: string,
  pathname: string,
  search: string = '',
): string | null {
  if (!isAliasEntryHost(hostname)) return null;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  // Leftover magic-link / OAuth emails must keep their query on the session host.
  if (isPreservedCallbackPath(path)) {
    return `${SESSION_ORIGIN}${path}${search}`;
  }
  return `${SESSION_ORIGIN}/signin`;
}
