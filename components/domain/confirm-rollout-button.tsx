"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { countOf, formatMoney } from "@/components/format";
import { merchantJson } from "@/components/lib/merchant-api";
import { Button, Checkbox, Modal, Notice } from "@/components/ui";
import { useToast } from "@/components/ui/toast";

type ConfirmVariant = {
  variantGid: string;
  title: string;
  oldPriceCents: number;
  newPriceCents: number;
  cohortStage: number;
};

type ConfirmReply = {
  ok: boolean;
  message?: string;
  rollout?: { status?: string };
};

/** Explicit second-step approval before the first Shopify write. */
export function ConfirmRolloutButton({
  rolloutId,
  rolloutName,
  variants,
  guardrails,
  currency,
  scheduledAt = null,
  demoMode = true,
}: {
  rolloutId: string;
  rolloutName: string;
  variants: ConfirmVariant[];
  guardrails: string[];
  currency: string;
  scheduledAt?: string | null;
  demoMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  function close() {
    if (working) return;
    setOpen(false);
    setAcknowledged(false);
  }

  async function confirm() {
    setWorking(true);
    try {
      if (demoMode) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        toast({
          tone: "success",
          title: "Demo only — no prices changed",
          description:
            "A connected store would now write and verify only the first stage. This demo did not call Shopify.",
        });
      } else {
        const reply = await merchantJson<ConfirmReply>(`/api/rollouts/${rolloutId}/confirm`, {
          method: "POST",
          // Omit scheduled_start_at so a draft's frozen future schedule is
          // preserved. Sending null here means "start now" at the API boundary.
          body: JSON.stringify({ confirm: true }),
        });
        if (!reply.ok) throw new Error(reply.message ?? "The first stage was not verified.");
        toast({
          tone: "success",
          title:
            reply.rollout?.status === "scheduled"
              ? "Rollout confirmed and scheduled"
              : "First stage live and verified",
          description:
            reply.message ??
            (reply.rollout?.status === "scheduled"
              ? "No Shopify price changed now. Priceflag verified the frozen baseline and kept the scheduled start."
              : "Priceflag verified every first-stage price against Shopify."),
        });
        router.refresh();
      }
      setOpen(false);
      setAcknowledged(false);
    } catch (cause) {
      toast({
        tone: "error",
        title: "Nothing was reported as started",
        description:
          cause instanceof Error ? cause.message : "Priceflag could not confirm the first stage.",
      });
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Button variant="neon" onClick={() => setOpen(true)}>
        {scheduledAt === null ? "Review and start" : "Review and confirm"}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={scheduledAt === null ? "Start the first stage?" : "Confirm this scheduled rollout?"}
        description={
          <>
            Review the full staged plan for <strong>{rolloutName}</strong>.{" "}
            {scheduledAt === null
              ? "Priceflag writes only step 1 now, then stops and reports a failure unless every first-step price is verified."
              : "No price changes now; Priceflag verifies the frozen baselines and keeps the scheduled start."}
          </>
        }
        footer={
          <>
            <Button variant="secondary" disabled={working} onClick={close}>
              Keep as draft
            </Button>
            <Button
              variant="primary"
              disabled={!acknowledged}
              loading={working}
              loadingLabel="Writing and verifying"
              onClick={() => void confirm()}
            >
              {scheduledAt === null ? "Confirm first stage" : "Confirm schedule"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Notice tone="hold" title="Automatic rollback is off">
            Crossing a limit pauses and alerts you. Priceflag will not restore prices without a
            separate merchant action during the public beta.
          </Notice>

          <div>
            <p className="text-sm font-medium text-ink">
              {countOf(variants.length, "affected product")}
            </p>
            <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-border">
              {variants.map((variant) => (
                <div
                  key={variant.variantGid}
                  className="flex items-center justify-between gap-4 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 truncate text-sm text-ink">{variant.title}</span>
                  <span className="shrink-0 text-right text-sm text-ink-muted">
                    <span className="block text-xs text-ink-subtle">Step {variant.cohortStage + 1}</span>
                    {formatMoney(variant.oldPriceCents, { currency })} →{" "}
                    <strong className="font-medium text-ink">{formatMoney(variant.newPriceCents, { currency })}</strong>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border bg-surface-muted px-3 py-2.5">
            <p className="text-sm font-medium text-ink">Pause limits</p>
            {guardrails.map((sentence) => (
              <p key={sentence} className="mt-1 text-sm text-ink-muted">
                {sentence}
              </p>
            ))}
          </div>

          <Checkbox
            id={`confirm-rollout-${rolloutId}`}
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            label="I reviewed the affected products, old prices, new prices, and pause limits"
          />
        </div>
      </Modal>
    </>
  );
}
