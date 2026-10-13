import { Skeleton } from "@/components/ui/skeleton";

/**
 * Locations-Skeleton: Titel + Untertitel + Zaehler/Anlegen-Zeile +
 * Such-/Filterzeile + Karten-Grid.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Skeleton className="h-4 w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Skeleton className="h-9 flex-1 min-w-[200px]" />
        <Skeleton className="h-9 w-56" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
