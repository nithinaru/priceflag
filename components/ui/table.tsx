import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/components/cn";

/**
 * Tables are the app's main surface, so the rules are strict:
 * - the page body never scrolls sideways; the table scrolls inside itself
 * - every table has a caption (visually hidden by default) so screen readers
 *   get a name without the design carrying a redundant heading
 * - numbers are right-aligned and tabular (see globals.css) so columns of money
 *   can be compared by eye
 */

export function Table({
  caption,
  showCaption = false,
  /**
   * `fit` (default) lets cells wrap so the table always fits its container —
   * right for a table inside a narrow card. `intrinsic` refuses to wrap and
   * scrolls sideways instead — right for the wide data tables, where a wrapped
   * price column is harder to read than a scrollbar.
   */
  layout = "fit",
  className,
  children,
}: {
  caption: string;
  showCaption?: boolean;
  layout?: "fit" | "intrinsic";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="pf-scroll-x w-full min-w-0">
      <table
        className={cn(
          "w-full border-collapse text-base",
          layout === "intrinsic" && "min-w-max",
          className,
        )}
      >
        <caption
          className={cn(
            showCaption ? "px-4 pb-2 text-left text-sm text-ink-muted sm:px-5" : "sr-only",
          )}
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

export function THead({
  className,
  children,
  sticky = false,
}: {
  className?: string;
  children: ReactNode;
  /** For long catalogs. Requires a scroll container with a height. */
  sticky?: boolean;
}) {
  return (
    <thead
      className={cn(
        "border-y border-border bg-surface-muted",
        sticky && "sticky top-0 z-10",
        className,
      )}
    >
      {children}
    </thead>
  );
}

export function TBody({ className, children }: { className?: string; children: ReactNode }) {
  return <tbody className={cn("divide-y divide-border", className)}>{children}</tbody>;
}

export function TR({
  className,
  children,
  interactive = false,
  tone,
}: {
  className?: string;
  children: ReactNode;
  /** Hover affordance. Only when the whole row leads somewhere. */
  interactive?: boolean;
  tone?: "live" | "hold" | "breach";
}) {
  return (
    <tr
      className={cn(
        interactive && "transition-colors hover:bg-surface-muted",
        tone === "live" && "bg-live-tint/40",
        tone === "hold" && "bg-hold-tint/40",
        tone === "breach" && "bg-breach-tint/40",
        className,
      )}
    >
      {children}
    </tr>
  );
}

type CellProps = {
  numeric?: boolean;
  className?: string;
  children?: ReactNode;
};

export function TH({
  numeric = false,
  className,
  children,
  scope = "col",
  ...props
}: CellProps & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cn(
        "px-3 py-2 text-left align-middle text-xs font-semibold text-ink-muted first:pl-4 " +
          "last:pr-4 sm:first:pl-5 sm:last:pr-5",
        numeric && "text-right",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({
  numeric = false,
  className,
  children,
  ...props
}: CellProps & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn(
        "px-3 py-2.5 align-middle text-base text-ink first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        numeric && "text-right",
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}

/** Secondary text inside a cell — SKU under a product name, "from Shopify". */
export function CellNote({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("text-xs text-ink-subtle", className)}>{children}</div>;
}

/**
 * The in-table empty state. Every table needs one: a table that renders a
 * header and no rows is a dead end (PRD R26).
 */
export function TableEmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-base text-ink-muted sm:px-5">
        {children}
      </td>
    </tr>
  );
}
