import { Skeleton } from "@/components/ui/skeleton";

/** Vertriebs-Skeleton: Titel + Knopf, Liste links, Detail rechts (§7). */
export default function Loading() {
  return (
    <div className="flex h-[calc(100vh-64px)] flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3.5 w-56" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-full max-w-sm space-y-1 rounded-lg border border-border p-1">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
        <Skeleton className="flex-1 rounded-lg" />
      </div>
    </div>
  );
}
