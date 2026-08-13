/**
 * Where a sign-in is allowed to send somebody afterwards.
 *
 * The obvious check — "starts with `/`, and not `//`" — is wrong, and wrong in a
 * way that reads as correct. WHATWG URL treats a backslash like a forward slash
 * for special schemes, so `/\evil.com` passes both of those tests and then
 * resolves to `https://evil.com/`:
 *
 *     new URL('/\\evil.com', 'https://dashboard.priceflag.org')
 *       → https://evil.com/
 *
 * That matters more here than in a normal open redirect: this value travels
 * inside a genuine Priceflag email, from a genuine Priceflag domain, and is
 * followed immediately after a successful sign-in — the single most trusted
 * moment in the flow.
 *
 * So validate by *resolution*, never by prefix. Resolve the candidate against
 * our own origin and require that it stayed there. Anything that leaves, or
 * that fails to parse at all, falls back to the app root.
 */

const DEFAULT_DESTINATION = '/';

export function safeDestination(raw: string | null | undefined, appUrl: string): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DESTINATION;

  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    return DEFAULT_DESTINATION;
  }

  let resolved: URL;
  try {
    resolved = new URL(raw, base);
  } catch {
    return DEFAULT_DESTINATION;
  }

  // The whole test. An absolute URL, a protocol-relative one, a backslash trick,
  // and a `javascript:` scheme all fail it for the same reason: they do not
  // resolve to our origin.
  if (resolved.origin !== base.origin) return DEFAULT_DESTINATION;

  // Rebuild from the parsed parts rather than returning the caller's string, so
  // what comes back is always a plain same-origin path. The fragment is dropped:
  // it is never meaningful to a server-side redirect and is a place to hide
  // things from logs.
  return `${resolved.pathname}${resolved.search}`;
}
