import { Skeleton } from "@/components/ui/skeleton";

/**
 * Lieferanten-Skeleton: Titel + Untertitel + Suchzeile mit Anlegen-Button +
 * Karten-Grid.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
