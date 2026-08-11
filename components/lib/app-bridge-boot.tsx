"use client";

import { useEffect } from "react";

import { authenticatedFetch } from "./shopify-fetch";

/**
 * Keep embedded-app identity and safety webhooks healthy while this tab lives.
 *
 * Rendered from the persistent root layout whenever Shopify is configured. It
 * refreshes page identity before the ten-minute cookie expires and whenever a
 * sleeping/backgrounded tab becomes visible again. It also repairs operational
 * webhook subscriptions independently of catalog-sync status, so a transient
 * post-install failure cannot leave the merchant with silently stale data.
 */

const BOOT_RELOAD_FLAG = "pf-shop-boot-reloaded";
const SESSION_REFRESH_MS = 4 * 60 * 1000;
const WEBHOOK_RECONCILE_MS = 5 * 60 * 1000;

export function AppBridgeBoot() {
  useEffect(() => {
    if (typeof window.shopify?.idToken !== "function") return;

    let cancelled = false;

    async function refreshSession(reloadWhenNew: boolean): Promise<void> {
      try {
        const response = await authenticatedFetch("/api/auth/session", { method: "POST" });
        if (cancelled || !response.ok || !reloadWhenNew) return;
        const body = (await response.json()) as { refreshed?: boolean };
        if (body.refreshed !== true) return;
        if (window.sessionStorage.getItem(BOOT_RELOAD_FLAG) !== null) return;
        window.sessionStorage.setItem(BOOT_RELOAD_FLAG, "1");
        window.location.reload();
      } catch {
        // A later timer/focus event retries with a new App Bridge token.
      }
    }

    async function reconcileWebhooks(): Promise<void> {
      try {
        await authenticatedFetch("/api/webhook-subscriptions", { method: "POST" });
      } catch {
        // Retry independently below; never fall back to an unauthenticated call.
      }
    }

    void refreshSession(true);
    void reconcileWebhooks();
    const sessionTimer = window.setInterval(() => void refreshSession(false), SESSION_REFRESH_MS);
    const webhookTimer = window.setInterval(
      () => void reconcileWebhooks(),
      WEBHOOK_RECONCILE_MS,
    );
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshSession(false);
      void reconcileWebhooks();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(sessionTimer);
      window.clearInterval(webhookTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return null;
}
