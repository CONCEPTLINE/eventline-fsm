import { Skeleton } from "@/components/ui/skeleton";

/**
 * Akquise-Skeleton: Titel, grosse Suchzeile, Kennzahlen, Filterchips und
 * die Trefferliste — bildet das echte Layout nach (§7).
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-56" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-11 w-full max-w-md" />
          <Skeleton className="h-11 w-28" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-28" />)}
      </div>
      <div className="space-y-1 rounded-lg border border-border p-1">
        <Skeleton className="h-7 w-full" />
        {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-11" />)}
      </div>
    </div>
  );
}
