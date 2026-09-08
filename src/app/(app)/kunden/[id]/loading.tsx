import { Skeleton } from "@/components/ui/skeleton";

/**
 * Kunden-Detail-Skeleton: Back + Titel + Card-Stack (Stammdaten, Auftraege,
 * Rechnungen).
 */
export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <Skeleton className="h-6 w-40" />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-64" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </div>
  );
}
