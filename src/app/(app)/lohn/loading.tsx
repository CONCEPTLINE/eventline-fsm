import { Skeleton } from "@/components/ui/skeleton";

/**
 * Lohn-Skeleton: Titel + Untertitel (rechts Meine|Team) + Bereichs-
 * Umschalter + Inhalts-Zeilen. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="space-y-2 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
