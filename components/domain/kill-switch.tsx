"use client";

import { useRouter } from "next/navigation";
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
  killSwitchEngaged,
  demoMode = true,
}: {
  /** How many products currently hold a price Priceflag set. */
  affectedSkus: number;
  /** While engaged, every future Priceflag write is blocked server-side. */
  killSwitchEngaged: boolean;
  demoMode?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"engage" | "retry" | "release" | null>(null);
  const [armed, setArmed] = useState(false);
  const [working, setWorking] = useState(false);
  const { toast } = useToast();

  function close() {
    if (working) return;
    setMode(null);
    setArmed(false);
  }

  async function confirm() {
    if (mode === null) return;
    setWorking(true);
    const result =
      mode === "release" ? await release(demoMode) : await engage(affectedSkus, demoMode);
    setWorking(false);
    setMode(null);
    setArmed(false);
    if (!demoMode) router.refresh();
    toast({
      tone: result.ok ? "success" : "error",
      title: result.ok
        ? mode === "release"
          ? "Price changes re-enabled"
          : "Every price was checked"
        : mode === "release"
          ? "Price changes remain disabled"
          : "The undo needs attention",
      description: result.message,
    });
  }

  const nothingLive = affectedSkus === 0;
  const releasing = mode === "release";

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2 className="text-base font-semibold text-ink">
          {killSwitchEngaged ? "Price changes disabled" : "Put everything back"}
        </h2>
        <div className="flex flex-wrap gap-2">
          {killSwitchEngaged ? (
            <Button
              variant="danger-quiet"
              onClick={() => setMode("retry")}
              iconLeft={<IconAlert size={15} />}
            >
              Retry unfinished undo
            </Button>
          ) : null}
          <Button
            variant="danger-quiet"
            disabled={!killSwitchEngaged && nothingLive}
            onClick={() => setMode(killSwitchEngaged ? "release" : "engage")}
            iconLeft={<IconAlert size={15} />}
          >
            {killSwitchEngaged ? "Review and re-enable" : "Put every price back"}
          </Button>
        </div>
      </div>

      <Modal
        open={mode !== null}
        onClose={close}
        tone="breach"
        title={
          releasing
            ? "Re-enable Priceflag price changes?"
            : mode === "retry"
              ? "Retry the unfinished store-wide undo?"
              : "Put every price back?"
        }
        description={
          releasing
            ? "Priceflag will first verify Shopify is at every original pre-Priceflag price. Nothing resumes automatically."
            : mode === "retry"
              ? "Priceflag will retry only unfinished restorations. Already verified prices are left alone and the stop stays engaged if anything still needs attention."
              : "This is the big one. It undoes every price change Priceflag has made on this store, not just the one you were looking at."
        }
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
              loadingLabel={releasing ? "Verifying original prices" : "Putting every price back"}
            >
              {releasing
                ? "Verify and re-enable"
                : mode === "retry"
                  ? "Retry unfinished undo"
                  : "Yes, put everything back"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 pb-1">
          {releasing ? (
            <ul className="space-y-2 text-base text-ink-muted">
              <li className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>Shopify must match every original frozen price and compare-at price.</span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>Any unfinished rollback or active writer keeps the stop engaged.</span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>No old price change resumes. A new rollout still needs your confirmation.</span>
              </li>
            </ul>
          ) : (
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
          )}
          <Checkbox
            id="kill-switch-ack"
            checked={armed}
            onChange={(event) => setArmed(event.target.checked)}
            label={
              releasing
                ? "I understand this only re-enables future writes; nothing resumes automatically"
                : mode === "retry"
                  ? "I understand the stop remains engaged unless every original price is verified"
                  : "I understand this undoes every price change, not just one"
            }
          />
        </div>
      </Modal>
    </div>
  );
}

async function release(
  demoMode: boolean,
): Promise<{ ok: boolean; affected_skus: number; message: string }> {
  if (demoMode) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    return {
      ok: true,
      affected_skus: 0,
      message: "This is the demo store. A connected store would verify every original Shopify price before allowing a new rollout.",
    };
  }

  return callKillSwitch("DELETE", { confirm: true });
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

  return callKillSwitch("POST", { confirm: true, reason: "Kill switch from the overview" });
}

async function callKillSwitch(
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; affected_skus: number; message: string }> {
  try {
    const response = await authenticatedFetch("/api/kill-switch", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json();
    if (!response.ok) {
      const message =
        typeof responseBody === "object" && responseBody !== null && "error" in responseBody
          ? String((responseBody as { error: { message?: string } }).error?.message ?? "")
          : typeof responseBody === "object" && responseBody !== null && "message" in responseBody
            ? String((responseBody as { message?: unknown }).message ?? "")
          : "";
      return {
        ok: false,
        affected_skus: 0,
        message: message || "Priceflag could not complete that safety check. Try again in a moment.",
      };
    }
    return responseBody as { ok: boolean; affected_skus: number; message: string };
  } catch {
    return {
      ok: false,
      affected_skus: 0,
      message: "We could not reach Priceflag. The existing safety state has not been cleared.",
    };
  }
}
