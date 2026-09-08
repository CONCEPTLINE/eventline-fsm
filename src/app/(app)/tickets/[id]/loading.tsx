import { Skeleton } from "@/components/ui/skeleton";

/**
 * Ticket-Detail-Skeleton: Back-Zeile + Titel + Detail-Cards (schmale
 * max-w-5xl-Spalte wie die echte Seite). CLAUDE.md §7 — ohne loading.tsx
 * prefetcht Next dynamische Routen nicht und der Klick bleibt ohne Feedback.
 */
export default function Loading() {
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <Skeleton className="h-5 w-32" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-32" />
      <Skeleton className="h-48" />
    </div>
  );
}
