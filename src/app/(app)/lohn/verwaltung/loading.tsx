import { Skeleton } from "@/components/ui/skeleton";

/** Lohnverwaltung-Skeleton (befristet, Phase 2 entfernt): Titel, Reiter, Inhalt. CLAUDE.md §7. */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-6 border-b border-border pb-2.5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="space-y-2 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
