import { cn } from "@/components/cn";

/**
 * Loading states mirror the shape of the thing that is coming, so the page does
 * not jump. Sync in progress is *not* a skeleton — it is a real state with real
 * counts (PRD R24, built in A5); skeletons are only for a fetch in flight.
 */

export function Skeleton({
  className,
  /** Announced to screen readers once, by the container, not per block. */
  label,
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-inset", className)}
      aria-hidden={label ? undefined : true}
      role={label ? "status" : undefined}
      aria-label={label}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", index === lines - 1 ? "w-2/5" : index % 2 ? "w-4/5" : "w-full")}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({
  rows = 6,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-border">
      <div className="flex gap-3 border-y border-border bg-surface-muted px-4 py-2.5 sm:px-5">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-3 px-4 py-3 sm:px-5">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn("h-3.5 flex-1", columnIndex === 0 && "flex-[2]")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("rounded-lg border border-border bg-surface p-5 shadow-sm", className)}
    >
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-2/5" />
      <SkeletonText lines={2} className="mt-4" />
    </div>
  );
}
