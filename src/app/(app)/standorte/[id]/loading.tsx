import { Skeleton } from "@/components/ui/skeleton";

/**
 * Standort-Detail-Skeleton: Sticky-Header (Name + Meta + Tab-Leiste) +
 * Content-Cards in der max-w-5xl-Spalte. CLAUDE.md §7 — deckt
 * auch /standorte/[id]/report als Kind-Segment mit ab.
 */
export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <Skeleton className="h-5 w-32" />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex gap-1 border-b">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-none" />
        ))}
      </div>
      <Skeleton className="h-48" />
      <Skeleton className="h-36" />
    </div>
  );
}
