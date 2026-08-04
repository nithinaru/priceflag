"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { IconAlert } from "@/components/ui/icons";
import { countOf } from "@/components/format";
import { authenticatedFetch } from "@/components/lib/shopify-fetch";

/**
 * The store-level kill switch (R21): put back every price Priceflag ever changed,
 * in one action.
 *
 * Deliberately quiet and deliberately last on the page. It is the thing a
 * merchant reaches for when they have lost confidence in the app itself, so it
 * must be findable — but it is not the action anyone is here to take, so it never
 * competes with the screen's primary button.
 *
 * The confirmation is armed by an explicit acknowledgement rather than being one
 * click, because unlike a single rollback this touches every rollout at once and
 * cannot be scoped down afterwards. Wired against `POST /api/kill-switch`
 * (contracts/api.md), which returns `{ ok, affected_skus, message }` and is
 * idempotent.
 */
export function KillSwitch({
  affectedSkus,
  demoMode = true,
}: {
  /** How many products currently hold a price Priceflag set. */
  affectedSkus: number;
  demoMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [working, setWorking] = useState(false);
  const { toast } = useToast();

  function close() {
    if (working) return;
    setOpen(false);
    setArmed(false);
  }

  async function confirm() {
    setWorking(true);
    const result = await engage(affectedSkus, demoMode);
    setWorking(false);
    setOpen(false);
    setArmed(false);
    toast({
      tone: result.ok ? "success" : "error",
      title: result.ok ? "Putting every price back" : "That did not go through",
      description: result.message,
    });
  }

  const nothingLive = affectedSkus === 0;

  return (
    <div className="rounded-lg border border-border px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 max-w-prose">
          <h2 className="text-base font-semibold text-ink">Put everything back</h2>
          <p className="mt-0.5 text-base text-ink-muted">
            {nothingLive
              ? "Priceflag is not holding a price on any product right now, so there is nothing to undo."
              : `Undo every price Priceflag has ever changed, across every price change at once. ${countOf(
                  affectedSkus,
                  "product",
                )} would go back to the price it had before Priceflag touched it.`}
          </p>
        </div>
        <Button
          variant="danger-quiet"
          disabled={nothingLive}
          onClick={() => setOpen(true)}
          iconLeft={<IconAlert size={15} />}
        >
          Put every price back
        </Button>
      </div>

      <Modal
        open={open}
        onClose={close}
        tone="breach"
        title="Put every price back?"
        description="This is the big one. It undoes every price change Priceflag has made on this store, not just the one you were looking at."
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirm}
              disabled={!armed}
              loading={working}
              loadingLabel="Putting every price back"
            >
              Yes, put everything back
            </Button>
          </>
        }
      >
        <div className="space-y-3 pb-1">
          <ul className="space-y-2 text-base text-ink-muted">
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>
                {countOf(affectedSkus, "product")} go back to the price captured before each change
                started. Nothing else in your store is touched.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>Every running price change stops. None of them will resume on their own.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>Every price we set back is recorded in your price journal.</span>
            </li>
          </ul>
          <Checkbox
            id="kill-switch-ack"
            checked={armed}
            onChange={(event) => setArmed(event.target.checked)}
            label="I understand this undoes every price change, not just one"
          />
        </div>
      </Modal>
    </div>
  );
}

async function engage(
  affectedSkus: number,
  demoMode: boolean,
): Promise<{ ok: boolean; affected_skus: number; message: string }> {
  if (demoMode) {
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    return {
      ok: true,
      affected_skus: affectedSkus,
      message: `This is the demo store, so no real prices moved. On a connected store, ${countOf(
        affectedSkus,
        "product",
      )} would be back at their original price within a minute, and every write would be journalled.`,
    };
  }

  try {
    const response = await authenticatedFetch("/api/kill-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Kill switch from the overview" }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: { message?: string } }).error?.message ?? "")
          : "";
      return {
        ok: false,
        affected_skus: 0,
        message: message || "We could not put the prices back. Nothing was changed.",
      };
    }
    return body as { ok: boolean; affected_skus: number; message: string };
  } catch {
    return {
      ok: false,
      affected_skus: 0,
      message: "We could not reach Priceflag, so nothing was changed. Try again in a moment.",
    };
  }
}
