import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mitarbeiter-Skeleton: Titel + Untertitel + Hinweis-Zeile mit «Neuer
 * Benutzer» + Benutzer-Zeilen. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-80 max-w-full" />
          <Skeleton className="h-9 w-36 shrink-0" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      </div>
    </div>
  );
}
