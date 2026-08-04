"use client";

/**
 * `authenticatedFetch` — fetch, plus the App Bridge session token when embedded.
 *
 * Inside the Shopify admin, App Bridge exposes `window.shopify.idToken()`, which
 * returns a fresh short-lived JWT (~1 minute). Every API call from the embedded
 * app must carry it as `Authorization: Bearer …` — the server refuses to guess
 * which shop a request is for. Outside the admin (demo mode, local dev, the app
 * opened directly) there is no App Bridge and this degrades to a plain fetch;
 * production merchant routes will correctly answer that request with 401.
 */

declare global {
  interface Window {
    shopify?: {
      idToken?: () => Promise<string>;
    };
  }
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const bridge = typeof window === "undefined" ? undefined : window.shopify;
  if (typeof bridge?.idToken !== "function") return fetch(input, init);

  // Always a fresh token — they expire in about a minute, so caching one would
  // just manufacture intermittent 401s. Deliberately let acquisition failures
  // reject: silently resending without the bearer token turns a reconnect event
  // into a misleading unauthenticated mutation attempt.
  const token = await bridge.idToken();

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
