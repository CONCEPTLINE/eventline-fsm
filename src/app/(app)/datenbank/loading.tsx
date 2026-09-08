import { Skeleton } from "@/components/ui/skeleton";

/**
 * Datenbank-Skeleton: Titel + Tab-Leiste (Underline-Nav) + Tabelle.
 * CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-36" />
      <div className="flex gap-1 border-b">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-none" />
        ))}
      </div>
      <div className="border rounded-xl overflow-hidden">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-none border-t" />
        ))}
      </div>
    </div>
  );
}
