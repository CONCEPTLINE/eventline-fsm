import { Skeleton } from "@/components/ui/skeleton";

/**
 * Anträge-Skeleton: Titel + Untertitel + Karte «Zu bearbeiten» (Zeilen) +
 * Karte Mitarbeiter-Ampel. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="rounded-xl border border-border bg-card p-4 space-y-2">
        <Skeleton className="h-3 w-28" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card p-4 space-y-2">
        <Skeleton className="h-3 w-24" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
