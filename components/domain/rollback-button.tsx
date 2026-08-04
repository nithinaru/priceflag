"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { IconUndo } from "@/components/ui/icons";
import { countOf } from "@/components/format";
import { authenticatedFetch } from "@/components/lib/shopify-fetch";

/**
 * The undo. It is on every screen where a change is live, because the merchant
 * has to be able to answer "how do I undo this?" without hunting (R16).
 *
 * Deliberately not hidden in a menu and not styled as a scary red button: using
 * it is a *good* outcome. The confirm dialog exists only because prices are
 * outward-facing, and it names exactly what will happen.
 *
 * Wired against the response shape of `POST /api/rollouts/[id]/rollback`
 * (contracts/api.md): `{ ok, affected_skus, message }`, idempotent — calling it
 * twice restores once. That route lands in B4; until then this resolves locally
 * and the toast says so, because a demo store must never imply a real write.
 */

type RollbackResponse = {
  ok: boolean;
  affected_skus: number;
  message: string;
};

export function RollbackButton({
  rolloutId,
  rolloutName,
  productCount,
  variant = "secondary",
  size = "md",
  label = "Put prices back",
  demoMode = true,
}: {
  rolloutId: string;
  rolloutName: string;
  productCount: number;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md" | "lg";
  label?: string;
  demoMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const { toast } = useToast();

  async function confirm() {
    setWorking(true);
    const result = await rollback(rolloutId, productCount, demoMode);
    setWorking(false);
    setOpen(false);

    toast({
      tone: result.ok ? "success" : "error",
      title: result.ok ? "Putting prices back" : "That did not go through",
      description: result.message,
    });
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        iconLeft={<IconUndo size={15} />}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>

      <Modal
        open={open}
        onClose={() => (working ? undefined : setOpen(false))}
        title="Put prices back?"
        description={
          <>
            Every product in <strong className="font-medium text-ink">{rolloutName}</strong> goes
            back to the price it had before this change started.
          </>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={working}>
              Keep the new prices
            </Button>
            <Button
              variant="danger"
              onClick={confirm}
              loading={working}
              loadingLabel="Putting prices back"
            >
              Yes, put prices back
            </Button>
          </>
        }
      >
        <ul className="space-y-2 pb-1 text-base text-ink-muted">
          <li className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>
              {countOf(productCount, "product")} affected. Nothing else in your store is touched.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>
              The prices we put back are the ones captured when this change was created — not
              recalculated now.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>Every price we set back is recorded in your price journal.</span>
          </li>
        </ul>
      </Modal>
    </>
  );
}

async function rollback(
  rolloutId: string,
  productCount: number,
  demoMode: boolean,
): Promise<RollbackResponse> {
  if (demoMode) {
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    return {
      ok: true,
      affected_skus: productCount,
      message: `This is the demo store, so no real prices moved. On a connected store, ${countOf(
        productCount,
        "product",
      )} would be back at their old price within a minute, each one recorded in your journal.`,
    };
  }

  try {
    const response = await authenticatedFetch(`/api/rollouts/${rolloutId}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        reason: "Put back from the rollout page",
      }),
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
    return body as RollbackResponse;
  } catch {
    return {
      ok: false,
      affected_skus: 0,
      message: "We could not reach Priceflag, so nothing was changed. Try again in a moment.",
    };
  }
}
