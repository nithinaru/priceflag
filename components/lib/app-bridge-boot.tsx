"use client";

import { useEffect } from "react";

import { authenticatedFetch } from "./shopify-fetch";

/**
 * One job: turn a short-lived App Bridge session token into the `pf_shop`
 * cookie, so server-rendered navigations and plain links carry shop identity.
 *
 * Rendered from the root layout whenever Shopify is configured. On mount, if App
 * Bridge is present, it POSTs to `/api/auth/session` (which verifies the token
 * and mints the cookie). When the server minted a *new* cookie — meaning this
 * page was server-rendered without shop identity — it reloads once so SSR can
 * re-run with the cookie attached. The sessionStorage flag makes "once" mean
 * once: a second mount in the same tab never reloads again, so a broken cookie
 * cannot become a reload loop.
 */

const BOOT_RELOAD_FLAG = "pf-shop-boot-reloaded";

export function AppBridgeBoot() {
  useEffect(() => {
    if (typeof window.shopify?.idToken !== "function") return;

    let cancelled = false;
    void authenticatedFetch("/api/auth/session", { method: "POST" })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { refreshed?: boolean };
        if (body.refreshed !== true) return;
        if (window.sessionStorage.getItem(BOOT_RELOAD_FLAG) !== null) return;
        window.sessionStorage.setItem(BOOT_RELOAD_FLAG, "1");
        window.location.reload();
      })
      .catch(() => {
        // No cookie means SSR stays shopless until the next fetch succeeds;
        // API calls still work via per-request tokens, so stay quiet.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
