"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { IconUndo } from "@/components/ui/icons";
import { countOf } from "@/components/format";

/**
 * The undo. It is on every screen where a change is live, because the merchant
 * has to be able to answer "how do I undo this?" without hunting (PRD R16).
 *
 * Deliberately not hidden behind a menu and not styled as a scary red button:
 * using it is a *good* outcome. The confirm dialog exists only because prices
 * are outward-facing, and it names exactly what will happen.
 *
 * A1 wires the interaction against a mocked call. Lane B's real server action is
 * requested in contracts/requests-lane-a.md (REQ-A-003).
 */
export function RollbackButton({
  rolloutName,
  productCount,
  variant = "secondary",
  size = "md",
  label = "Put prices back",
}: {
  rolloutName: string;
  productCount: number;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const { toast } = useToast();

  async function confirm() {
    setWorking(true);
    // Mocked: Lane B's rollback action goes here (REQ-A-003).
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    setWorking(false);
    setOpen(false);
    toast({
      tone: "success",
      title: "Putting prices back",
      description: `${countOf(
        productCount,
        "product",
      )} will be back at their old price within a minute. You'll see it in your price journal.`,
    });
  }

  return (
    <>
      <Button variant={variant} size={size} iconLeft={<IconUndo size={15} />} onClick={() => setOpen(true)}>
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
            <span>Usually done within a minute. We email you when it finishes.</span>
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
