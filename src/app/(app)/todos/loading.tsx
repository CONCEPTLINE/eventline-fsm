import { Skeleton } from "@/components/ui/skeleton";

/**
 * Aufgaben-Skeleton: Header (Titel + Action) + Eingabezeile +
 * gruppierte Aufgaben-Zeilen. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-11" />
      <div className="space-y-6">
        {Array.from({ length: 2 }).map((_, s) => (
          <div key={s} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
