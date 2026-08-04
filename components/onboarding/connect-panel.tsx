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
 *   `GET /api/auth`, which is Lane B's OAuth start.
 * - **Not present** → the button says so and does not pretend. A dead install
 *   button that silently 404s is worse than one that explains itself.
 *
 * The demo path runs a scripted sync so the whole first-run sequence can be
 * walked end to end without credentials, and it is labelled as scripted
 * throughout — a demo that implies it touched Shopify is a lie the merchant
 * finds out about later.
 */
export function ConnectPanel({
  shopifyConfigured,
  installBase,
  connected = null,
  installedNow = false,
}: {
  shopifyConfigured: boolean;
  installBase: string;
  /** Set when this render already knows which store is connected (real mode). */
  connected?: ConnectedShopState | null;
  /** True when the page URL carries `?installed=1` — the OAuth flow just finished. */
  installedNow?: boolean;
}) {
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  const normalized = normalizeDomain(domain);

  async function connect() {
    if (!normalized) {
      setError("Enter your store's address, like my-store.myshopify.com.");
      return;
    }
    setError(null);

    if (shopifyConfigured) {
      // Real install: hand off to Lane B's OAuth start.
      window.location.href = `${installBase}?shop=${encodeURIComponent(normalized)}`;
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

        {!shopifyConfigured ? (
          <Notice tone="hold" title="This copy of Priceflag has no Shopify credentials yet">
            You can still walk through the whole first-run sequence — the next button plays a
            scripted version of it against the demo store. To connect a real store, add your
            Shopify app credentials and reload.
          </Notice>
        ) : null}
      </CardBody>
      <CardFooter>
        <span>
          {shopifyConfigured
            ? "Shopify will ask you to approve the permissions above."
            : "Nothing here contacts Shopify."}
        </span>
        <Button
          variant="primary"
          loading={running}
          loadingLabel="Loading your store"
          onClick={() => void connect()}
          iconRight={<IconArrowRight size={15} />}
        >
          {shopifyConfigured ? "Install on my store" : "Show me how this works"}
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
 * polls the same endpoint. The kickoff itself is fire-and-forget: the status
 * endpoint is the single source of truth for what actually happened.
 */
function ConnectedSyncCard({ connected }: { connected: ConnectedShopState }) {
  const [progress, setProgress] = useState(connected.progress);
  // Remounts the panel after a kickoff so it starts polling from the new queued
  // state instead of staying frozen on the old error.
  const [attempt, setAttempt] = useState(0);

  const kickSync = useCallback(() => {
    setProgress(kickoffProgress());
    setAttempt((n) => n + 1);
    void authenticatedFetch("/api/sync", { method: "POST" }).catch(() => {
      // Fire-and-forget. If the trigger itself failed, the next status poll
      // simply shows no new run — the retry button stays available.
    });
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

/** Accepts what merchants actually paste: a bare handle, or a full admin URL. */
function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const withoutScheme = trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const handle = withoutScheme.replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
  return `${handle}.myshopify.com`;
}
