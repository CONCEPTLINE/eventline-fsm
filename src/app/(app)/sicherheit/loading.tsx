import { Skeleton } from "@/components/ui/skeleton";

/**
 * Sicherheit-Skeleton: Titel + Untertitel + Tab-Leiste (Underline-Nav,
 * 3 Bereiche) + Portal-Kasten-Zeile (Default-Tab Anmeldungen) + Content-Card.
 * CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-[28rem] max-w-full" />
      </div>
      <div>
        <div className="flex gap-1 border-b">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-32 rounded-none" />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 mt-10">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-36" />
          ))}
        </div>
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
