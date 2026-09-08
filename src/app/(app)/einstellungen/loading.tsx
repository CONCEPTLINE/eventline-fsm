import { Skeleton } from "@/components/ui/skeleton";

/**
 * Einstellungen-Skeleton: Titel + Portal-Tab-Leiste (Underline-Nav) +
 * Sub-Tab-Kasten-Zeile + Content-Card. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div>
        <div className="flex gap-1 border-b">
          <Skeleton className="h-9 w-32 rounded-none" />
          <Skeleton className="h-9 w-32 rounded-none" />
        </div>
        <div className="flex flex-wrap gap-2 mt-10">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
