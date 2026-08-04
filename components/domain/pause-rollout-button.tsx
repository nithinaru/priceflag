"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { merchantJson } from "@/components/lib/merchant-api";
import { Button, Modal } from "@/components/ui";
import { useToast } from "@/components/ui/toast";

export function PauseRolloutButton({
  rolloutId,
  rolloutName,
  demoMode = true,
}: {
  rolloutId: string;
  rolloutName: string;
  demoMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  async function pause() {
    setWorking(true);
    try {
      if (!demoMode) {
        await merchantJson(`/api/rollouts/${rolloutId}/pause`, {
          method: "POST",
          body: JSON.stringify({ confirm: true, reason: "Paused manually from the rollout page." }),
        });
        router.refresh();
      }
      setOpen(false);
      toast({
        tone: "success",
        title: demoMode ? "Demo pause only" : "Rollout paused",
        description: demoMode
          ? "No real rollout changed. On a connected store, later stages would stop here."
          : "No later stage will start. Prices already live stay in place until you choose what to do.",
      });
    } catch (cause) {
      toast({
        tone: "error",
        title: "The rollout was not reported paused",
        description: cause instanceof Error ? cause.message : "Try again in a moment.",
      });
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Pause rollout
      </Button>
      <Modal
        open={open}
        onClose={() => (working ? undefined : setOpen(false))}
        title="Pause this rollout?"
        description={
          <>
            <strong>{rolloutName}</strong> will stop advancing to later stages. Prices already live
            stay in place; pausing does not roll them back.
          </>
        }
        footer={
          <>
            <Button variant="secondary" disabled={working} onClick={() => setOpen(false)}>
              Keep running
            </Button>
            <Button
              variant="primary"
              loading={working}
              loadingLabel="Pausing"
              onClick={() => void pause()}
            >
              Pause rollout
            </Button>
          </>
        }
      >
        <p className="text-base text-ink-muted">
          You can review performance and manually roll back from this page. Beta rollouts never
          resume or restore prices on their own.
        </p>
      </Modal>
    </>
  );
}
