import { Skeleton } from "@/components/ui/skeleton";

/**
 * Raum-Detail-Skeleton: Back-Zeile + Name + Detail-Cards mit
 * 2-Spalten-Feldern in der schmalen max-w-3xl-Spalte. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <Skeleton className="h-5 w-32" />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-36" />
      </div>
    </div>
  );
}
