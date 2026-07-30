"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/cn";
import { Button, ButtonLink, Notice } from "@/components/ui";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import { countOf, formatUnits } from "@/components/format";
import type { SyncProgress } from "@/lib/contracts";

/**
 * Sync progress, rendering `contracts/sync_progress.schema.json`.
 *
 * The contract's whole design point is that **the catalog is usable long before
 * the order history finishes** (R24), so this component never shows one
 * undifferentiated bar. It shows two things finishing independently, and the
 * moment `catalog.ready` flips it hands the merchant a real next action rather
 * than making them watch history download.
 *
 * `eta_seconds` is `null` when unknown and the UI must not invent one — so a
 * missing ETA renders as no ETA, not as "calculating…".
 */
export function SyncProgressPanel({
  initial,
  /** Poll the real endpoint. Off in demo mode, which plays a scripted sync. */
  poll = true,
  onCatalogReady,
}: {
  initial: SyncProgress;
  poll?: boolean;
  onCatalogReady?: () => void;
}) {
  const [progress, setProgress] = useState(initial);
  const announced = useRef(false);

  useEffect(() => {
    if (progress.catalog.ready && !announced.current) {
      announced.current = true;
      onCatalogReady?.();
    }
  }, [progress.catalog.ready, onCatalogReady]);

  useEffect(() => {
    if (!poll) return;
    if (progress.stage === "done" || progress.stage === "error") return;

    const timer = window.setInterval(() => {
      void fetch("/api/sync/status")
        .then((response) => (response.ok ? response.json() : null))
        .then((body: SyncProgress | null) => {
          if (body) setProgress(body);
        })
        .catch(() => {
          // A failed poll is not a failed sync. The sync runs server-side; we
          // simply do not know its state this second, so we say nothing and try
          // again rather than inventing an error state.
        });
    }, 2000);

    return () => window.clearInterval(timer);
  }, [poll, progress.stage]);

  if (progress.stage === "error" && progress.error) {
    return (
      <Notice
        tone="breach"
        title="We could not finish loading your store"
        action={
          progress.error.retryable ? (
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              Try again
            </Button>
          ) : null
        }
      >
        {progress.error.message}
      </Notice>
    );
  }

  const catalogPct = percent(
    progress.catalog.products_synced,
    progress.catalog.products_total,
    progress.catalog.ready,
  );
  const historyPct = percent(
    progress.history.days_synced,
    progress.history.days_target,
    progress.history.ready,
  );

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-base text-ink">{progress.message}</p>

      <div className="space-y-3">
        <Track
          label="Your products, prices and costs"
          done={progress.catalog.ready}
          percent={catalogPct}
          detail={
            progress.catalog.ready
              ? `${countOf(progress.catalog.products_synced, "product")} loaded`
              : progress.catalog.products_total === null
                ? "Counting what is in your store…"
                : `${formatUnits(progress.catalog.products_synced)} of ${formatUnits(
                    progress.catalog.products_total,
                  )}`
          }
        />
        <Track
          label="Your sales history"
          done={progress.history.ready}
          percent={historyPct}
          detail={
            progress.history.ready
              ? `${countOf(progress.history.days_synced, "day")} read`
              : `${formatUnits(progress.history.days_synced)} of ${formatUnits(
                  progress.history.days_target,
                )} days${
                  progress.eta_seconds !== null && progress.eta_seconds !== undefined
                    ? ` · about ${etaWords(progress.eta_seconds)} left`
                    : ""
                }`
          }
        />
      </div>

      {progress.catalog.ready && !progress.history.ready ? (
        <Notice
          tone="info"
          title="You can start choosing products now"
          action={
            <ButtonLink
              href="/products"
              variant="primary"
              size="sm"
              iconRight={<IconArrowRight size={15} />}
            >
              See your products
            </ButtonLink>
          }
        >
          Your catalog is ready. Sales history keeps loading in the background — you do not have to
          wait here, and nothing is lost if you close this tab.
        </Notice>
      ) : null}
    </div>
  );
}

function Track({
  label,
  detail,
  percent: value,
  done,
}: {
  label: string;
  detail: string;
  percent: number;
  done: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-base font-medium text-ink">
          {done ? (
            <span className="text-live" aria-hidden="true">
              <IconCheck size={14} />
            </span>
          ) : null}
          {label}
        </span>
        <span className="text-sm tabular-nums text-ink-muted">{detail}</span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-inset"
        role="progressbar"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            done ? "bg-live" : "bg-accent",
          )}
          style={{ width: `${Math.max(value, 2)}%` }}
        />
      </div>
    </div>
  );
}

function percent(done: number, total: number | null | undefined, ready: boolean): number {
  if (ready) return 100;
  if (!total || total <= 0) return 6;
  return Math.min(99, (done / total) * 100);
}

function etaWords(seconds: number): string {
  if (seconds < 60) return "a few seconds";
  const minutes = Math.round(seconds / 60);
  return countOf(minutes, "minute");
}
