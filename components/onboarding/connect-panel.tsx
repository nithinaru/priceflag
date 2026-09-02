"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, ButtonLink, Card, CardBody, CardFooter, CardHeader, Field, Input, Notice } from "@/components/ui";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import { SyncProgressPanel } from "@/components/onboarding/sync-progress";
import { authenticatedFetch } from "@/components/lib/shopify-fetch";
import { startDemoSync, type StartSyncReply } from "@/app/connect/actions";
import { CONTRACT_VERSION, DEFAULT_HISTORY_DAYS, type SyncProgress } from "@/lib/contracts";

/** What the server already knows about a connected store, for the first paint. */
export interface ConnectedShopState {
  domain: string;
  /** Where the latest sync run stood at render time. */
  syncState: "none" | "running" | "done" | "error";
  /** `syncProgressFromRun` of that run — the same shape `/api/sync/status` returns. */
  progress: SyncProgress;
}

/**
 * Connecting a store.
 *
 * Two honest paths, decided by what is actually configured on the server rather
 * than by a flag in the UI:
 *
 * - **Shopify credentials present** → the install link is real; it hands off to
 *   `GET /api/auth`.
 * - **Not present, demo mode** → a scripted sync, labelled as scripted.
 * - **Not present, real mode** → the button is disabled. Offering a demo catalog
 *   as if it were an install would be a lie.
 */
export function ConnectPanel({
  shopifyConfigured,
  demoMode = false,
  installBase,
  connected = null,
  installedNow = false,
}: {
  shopifyConfigured: boolean;
  /** Scripted catalog walkthrough is only offered in demo mode. */
  demoMode?: boolean;
  installBase: string;
  /** Set when this render already knows which store is connected (real mode). */
  connected?: ConnectedShopState | null;
  /** True when the page URL carries `?installed=1` — the install flow just finished. */
  installedNow?: boolean;
}) {
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  const normalized = normalizeDomain(domain);
  const canConnect = shopifyConfigured || demoMode;

  async function connect() {
    if (!normalized) {
      setError("Enter your store's address, like my-store.myshopify.com.");
      return;
    }
    setError(null);

    if (shopifyConfigured) {
      // Consent cannot render inside the Shopify Admin iframe. This runs
      // directly from the merchant's click, so `_top` performs the required
      // full-page handoff without opening a popup.
      window.open(`${installBase}?shop=${encodeURIComponent(normalized)}`, "_top");
      return;
    }

    if (!demoMode) {
      setError("This copy of Priceflag cannot connect a store until Shopify is set up on it.");
      return;
    }

    setRunning(true);
    const reply: StartSyncReply = await startDemoSync(normalized);
    setRunning(false);
    if (!reply.ok) {
      setError(reply.message);
      return;
    }
    setProgress(reply.progress);
  }

  // A store is already connected: the form has done its job, and the only
  // honest thing left to show is what the sync is actually doing.
  if (connected !== null) {
    return <ConnectedSyncCard connected={connected} />;
  }

  if (progress) {
    return (
      <Card tone="accent" edge>
        <CardHeader
          eyebrow="Scripted, not connected"
          title={`Loading ${normalized}`}
          description="This is what the real thing looks like. No Shopify store was contacted, and no credentials were used."
        />
        <CardBody>
          <SyncProgressPanel initial={progress} poll={false} />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Connect your Shopify store"
        description="Priceflag reads your products, their costs, and your order history. It changes a price only when you tell it to."
      />
      <CardBody className="space-y-5">
        {installedNow ? (
          <Notice tone="info" title="The install finished, but this page cannot tell which store it was">
            Open Priceflag from the Apps section of your Shopify admin and the sync will pick up
            from there. Nothing was lost.
          </Notice>
        ) : null}
        <Field
          label="Your store's address"
          htmlFor="shop-domain"
          hint="You will find this in your Shopify admin URL. It ends in .myshopify.com."
          error={error ?? undefined}
        >
          <Input
            id="shop-domain"
            value={domain}
            placeholder="my-store.myshopify.com"
            autoComplete="off"
            spellCheck={false}
            invalid={error !== null}
            onChange={(event) => {
              setDomain(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
        </Field>

        <div className="rounded-lg border border-border bg-surface-muted px-4 py-3.5">
          <h3 className="text-base font-semibold text-ink">What Priceflag will do</h3>
          <ul className="mt-2 space-y-1.5">
            {[
              "Read your products, their prices, and the unit costs you have saved in Shopify.",
              "Read your order history, as daily totals only. We never store anything about a customer.",
              "Change a price only as part of a change you set up and started yourself.",
              "Record every price change, including ones you make in Shopify without us.",
            ].map((line) => (
              <li key={line} className="flex gap-2 text-base text-ink-muted">
                <span className="mt-0.5 shrink-0 text-live" aria-hidden="true">
                  <IconCheck size={14} />
                </span>
                <span className="max-w-prose">{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-prose text-base text-ink">
            <span className="font-medium">What it never does:</span> show different prices to
            different shoppers. Everyone who visits your store sees the same price, always.
          </p>
        </div>

        {!shopifyConfigured && demoMode ? (
          <Notice tone="hold" title="Scripted walkthrough — not a real install">
            The next button plays a scripted version of first-run against the demo store. No
            Shopify store is contacted.
          </Notice>
        ) : null}
        {!shopifyConfigured && !demoMode ? (
          <Notice tone="hold" title="Connecting is unavailable">
            Shopify is not set up on this copy of Priceflag, so a store cannot be connected from
            here.
          </Notice>
        ) : null}
      </CardBody>
      <CardFooter>
        <span>
          {shopifyConfigured
            ? "Shopify will ask you to approve the permissions above."
            : demoMode
              ? "Nothing here contacts Shopify. This path is scripted."
              : "Connecting is unavailable until Shopify is set up on this deployment."}
        </span>
        <Button
          variant="primary"
          loading={running}
          loadingLabel="Loading your store"
          disabled={!canConnect}
          onClick={() => void connect()}
          iconRight={<IconArrowRight size={15} />}
        >
          {shopifyConfigured
            ? "Install on my store"
            : demoMode
              ? "Show me how this works"
              : "Connect a store"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The connected store's sync, live.
 *
 * The server told us where the latest run stood at render time; from there this
 * component (1) refreshes that snapshot from `/api/sync/status`, (2) starts a
 * sync when none has run — the install's own kickoff normally beats us to it,
 * so this is the backstop, not the norm — or when the last one failed with a
 * retryable error, and (3) hands live rendering to `SyncProgressPanel`, which
 * polls the same endpoint. A rejected kickoff is surfaced immediately so a
 * webhook-registration failure cannot look like a sync that is merely slow.
 */
function ConnectedSyncCard({ connected }: { connected: ConnectedShopState }) {
  const [progress, setProgress] = useState(connected.progress);
  // Remounts the panel after a kickoff so it starts polling from the new queued
  // state instead of staying frozen on the old error.
  const [attempt, setAttempt] = useState(0);

  const kickSync = useCallback(() => {
    setProgress(kickoffProgress());
    setAttempt((n) => n + 1);
    void (async () => {
      try {
        const response = await authenticatedFetch("/api/sync", { method: "POST" });
        if (response.ok) return;
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        const message =
          body?.error?.message ??
          "Priceflag could not verify the store connection before syncing. Try again.";
        setProgress(kickoffError(message));
      } catch {
        setProgress(
          kickoffError("Priceflag could not reach the store connection service. Try again."),
        );
      }
      // Remount with the error snapshot; the retry button remains available.
      setAttempt((n) => n + 1);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Re-check the server before deciding anything: the post-install kickoff
      // may have started a run after this page was rendered.
      let fresh: SyncProgress | null = null;
      try {
        const response = await authenticatedFetch("/api/sync/status");
        if (response.ok) {
          const body = (await response.json()) as SyncProgress | { error: unknown };
          if (!("error" in body)) fresh = body;
        }
      } catch {
        // No fresh status is not a failed sync; fall back to the server render.
      }
      if (cancelled) return;

      const current = fresh ?? connected.progress;
      const runUnderway = current.stage !== "queued" && current.stage !== "error";
      if (connected.syncState === "none" && !runUnderway) {
        kickSync();
        return;
      }
      if (current.stage === "error" && current.error?.retryable === true) {
        kickSync();
        return;
      }
      if (fresh !== null) setProgress(fresh);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: this is the kickoff decision, not a subscription. Live
    // updates come from SyncProgressPanel's own polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = progress.stage === "done";
  const errored = progress.stage === "error";

  return (
    <Card tone={done ? undefined : "accent"} edge={!done}>
      <CardHeader
        eyebrow={connected.domain}
        title={
          done
            ? "Your store is loaded"
            : errored
              ? "We could not finish loading your store"
              : "Loading your store"
        }
        description={
          done
            ? "Priceflag keeps this fresh on its own from here — every new order and product change flows in automatically."
            : errored
              ? "The details below say what went wrong and what to do about it."
              : "This runs on our side — you can leave this page and nothing is lost."
        }
      />
      <CardBody>
        <SyncProgressPanel
          key={attempt}
          initial={progress}
          poll
          onProgress={setProgress}
          onRetry={kickSync}
        />
      </CardBody>
      {done ? (
        <CardFooter>
          <span>Next: pick the products whose prices you want to test.</span>
          <ButtonLink href="/products" variant="primary" iconRight={<IconArrowRight size={15} />}>
            See your products
          </ButtonLink>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** A just-started sync, in the `sync_progress` contract shape, for first paint. */
function kickoffProgress(): SyncProgress {
  const nowIso = new Date().toISOString();
  return {
    contract_version: CONTRACT_VERSION,
    stage: "queued",
    message: "Starting the sync…",
    catalog: { ready: false, products_synced: 0, products_total: null, ready_at: null },
    history: {
      ready: false,
      days_synced: 0,
      days_target: DEFAULT_HISTORY_DAYS,
      orders_processed: 0,
      ready_at: null,
    },
    eta_seconds: null,
    error: null,
    started_at: nowIso,
    updated_at: nowIso,
    finished_at: null,
  };
}

function kickoffError(message: string): SyncProgress {
  const progress = kickoffProgress();
  return {
    ...progress,
    stage: "error",
    message,
    error: { code: "shopify_error", message, retryable: true },
    finished_at: progress.updated_at,
  };
}

/** Accepts what merchants actually paste: a bare handle, or a full admin URL. */
function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const withoutScheme = trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const handle = withoutScheme.replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
  return `${handle}.myshopify.com`;
}
