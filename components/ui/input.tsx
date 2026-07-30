import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "@/components/cn";
import { IconAlert, IconSearch } from "@/components/ui/icons";

/**
 * Controls are 16px text below `sm` so iOS Safari does not zoom on focus, and
 * 14px above it to match the dense desktop layout.
 */
const CONTROL =
  "w-full rounded-md border bg-surface text-md text-ink placeholder:text-ink-subtle " +
  "outline-none transition-[border-color,box-shadow] focus-visible:border-accent " +
  "focus-visible:ring-2 focus-visible:ring-focus/35 disabled:cursor-not-allowed " +
  "disabled:bg-surface-muted disabled:text-ink-subtle sm:text-base";

const CONTROL_HEIGHT = "h-9";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  /** Renders "Optional" next to the label instead of marking required fields. */
  optional = false,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-base font-medium text-ink">
          {label}
        </label>
        {optional ? <span className="text-xs text-ink-subtle">Optional</span> : null}
      </div>
      {children}
      {hint && !error ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-sm text-breach">
          <IconAlert size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** Static text inside the control, e.g. "$" or "%". Never a placeholder. */
  prefix?: string;
  suffix?: string;
};

export function Input({ invalid = false, prefix, suffix, className, ...props }: InputProps) {
  const control = (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        CONTROL_HEIGHT,
        invalid ? "border-breach" : "border-border-strong",
        prefix ? "pl-7" : "pl-3",
        suffix ? "pr-8" : "pr-3",
        className,
      )}
      {...props}
    />
  );

  if (!prefix && !suffix) return control;

  return (
    <div className="relative">
      {prefix ? (
        <span
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-ink-subtle"
          aria-hidden="true"
        >
          {prefix}
        </span>
      ) : null}
      {control}
      {suffix ? (
        <span
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base text-ink-subtle"
          aria-hidden="true"
        >
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

export function SearchInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <div className="relative">
      <IconSearch
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
      />
      <input
        type="search"
        className={cn(CONTROL, CONTROL_HEIGHT, "border-border-strong pl-9 pr-3", className)}
        {...props}
      />
    </div>
  );
}

export function Select({
  invalid = false,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        CONTROL_HEIGHT,
        "appearance-none bg-[length:16px] bg-[right_0.625rem_center] bg-no-repeat pl-3 pr-9",
        invalid ? "border-breach" : "border-border-strong",
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2366707f' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9.5 6 6 6-6'/%3E%3C/svg%3E\")",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  description,
  className,
  id,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={id}
        type="checkbox"
        className={
          "mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border border-border-strong " +
          "accent-accent outline-none focus-visible:ring-2 focus-visible:ring-focus " +
          "focus-visible:ring-offset-2 focus-visible:ring-offset-surface " +
          "disabled:cursor-not-allowed disabled:opacity-50"
        }
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-base text-ink">
          {label}
        </label>
        {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
      </div>
    </div>
  );
}
