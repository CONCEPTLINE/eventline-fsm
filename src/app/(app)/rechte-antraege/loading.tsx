import { Skeleton } from "@/components/ui/skeleton";

/**
 * Rechte-Anträge-Skeleton: Titel + Untertitel, eine Karte mit Status,
 * Angaben-Zeilen und zwei Knöpfen. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="rounded-xl border p-5 space-y-4">
        <Skeleton className="h-5 w-36" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
    </div>
  );
}
