"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/components/cn";
import { IconAlert, IconCheckCircle, IconClose, IconInfo } from "@/components/ui/icons";

export type ToastTone = "info" | "success" | "warning" | "error";

export type Toast = {
  id: string;
  tone: ToastTone;
  title: string;
  /** What happens next, if the merchant needs to know. */
  description?: string;
};

type ToastInput = Omit<Toast, "id">;

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** Errors stay until dismissed; everything else clears itself. */
const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  info: 6000,
  success: 6000,
  warning: 9000,
  error: null,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      nextId.current += 1;
      const id = `toast-${nextId.current}`;
      setToasts((current) => [...current, { ...input, id }]);
      const ttl = AUTO_DISMISS_MS[input.tone];
      if (ttl !== null) {
        window.setTimeout(() => dismiss(id), ttl);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}

const TONES: Record<ToastTone, { card: string; icon: ReactNode }> = {
  info: {
    card: "border-border bg-surface",
    icon: <IconInfo size={18} className="text-accent" />,
  },
  success: {
    card: "border-border bg-surface",
    icon: <IconCheckCircle size={18} className="text-live" />,
  },
  warning: {
    card: "border-border bg-surface",
    icon: <IconAlert size={18} className="text-hold" />,
  },
  error: {
    card: "border-border bg-surface",
    icon: <IconAlert size={18} className="text-breach" />,
  },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      // Assertive would interrupt; these are confirmations, not alarms. Errors
      // that matter get their own inline state on the page as well.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border " +
              "px-4 py-3 shadow-md",
            TONES[item.tone].card,
          )}
        >
          <div className="mt-0.5 shrink-0">{TONES[item.tone].icon}</div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-medium text-ink">{item.title}</p>
            {item.description ? (
              <p className="mt-0.5 text-sm text-ink-muted">{item.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(item.id)}
            aria-label="Dismiss"
            className={
              "-mr-1 -mt-1 shrink-0 rounded-md p-1 text-ink-subtle outline-none " +
              "hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            }
          >
            <IconClose size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
