import { Card, Skeleton, SkeletonCard, SkeletonTable } from "@/components/ui";

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading this price change">
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <SkeletonCard />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <div className="px-4 py-3.5 sm:px-5">
            <Skeleton className="h-4 w-40" />
          </div>
          <SkeletonTable rows={6} columns={5} />
        </Card>
        <div className="space-y-6">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    </div>
  );
}
