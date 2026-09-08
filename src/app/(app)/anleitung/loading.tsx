import { Skeleton } from "@/components/ui/skeleton";

/**
 * Anleitung-Skeleton: Titel + Tab-Leiste (Underline-Nav) + Content-Spalte
 * mit rechter Neben-Spalte (Mock-Vorschau, 260px auf md+). CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-40" />
      <div className="flex gap-1 border-b">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-none" />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_260px] gap-4 items-start">
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
