"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/cn";
import { Button } from "@/components/ui/button";
import { IconClose } from "@/components/ui/icons";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal is only used to confirm something the merchant cannot easily undo —
 * putting prices back, reverting everything. It states what will happen in
 * plain language and names the number of products affected, because the whole
 * point of the app is that nobody is surprised by a price change.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  tone = "default",
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: "default" | "breach";
  size?: "sm" | "md";
}) {
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => setMounted(true), []);

  const focusables = useCallback(() => {
    const root = dialogRef.current;
    if (!root) return [] as HTMLElement[];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }, []);

  // Move focus in on open, put it back where it was on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const [first] = focusables();
      (first ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      restoreFocusTo.current?.focus?.();
    };
  }, [open, focusables]);

  // Escape closes; Tab cycles inside the dialog.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, focusables]);

  // Freeze the page behind the dialog.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl " +
            "border border-border bg-surface shadow-lg outline-none sm:rounded-xl",
          size === "sm" ? "sm:max-w-sm" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="min-w-0 space-y-1.5">
            <h2
              id={titleId}
              className={cn(
                "text-lg font-semibold",
                tone === "breach" ? "text-breach" : "text-ink",
              )}
            >
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="text-base text-ink-muted">
                {description}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={
              "-mr-1.5 -mt-1.5 rounded-md p-1.5 text-ink-subtle outline-none " +
              "hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            }
          >
            <IconClose size={18} />
          </button>
        </div>

        {children ? <div className="pf-scroll-x mt-4 px-5">{children}</div> : null}

        <div className="mt-5 flex flex-col-reverse gap-2 border-t border-border bg-surface-muted px-5 py-4 sm:flex-row sm:justify-end">
          {footer ?? (
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
