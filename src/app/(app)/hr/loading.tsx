import { Skeleton } from "@/components/ui/skeleton";

/**
 * /hr leitet nur weiter (Anträge, Stempelzeiten, Abwesenheit, Lohn …) —
 * neutrales Seiten-Skeleton (Titel + Untertitel + Zeilen), bis die
 * Zielseite steht. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
