import { Card, Skeleton, SkeletonCard, SkeletonTable } from "@/components/ui";

/**
 * Shape-matched loading, so nothing jumps when the real page arrives. A route
 * with a distinctly different shape gets its own loading.tsx.
 */
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="space-y-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <SkeletonCard />
      <Card>
        <div className="px-4 py-3.5 sm:px-5">
          <Skeleton className="h-4 w-40" />
        </div>
        <SkeletonTable rows={6} columns={5} />
      </Card>
    </div>
  );
}
