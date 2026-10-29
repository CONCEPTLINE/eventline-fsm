import { Skeleton } from "@/components/ui/skeleton";

/** Vertriebs-Skeleton: Titel, Tab-Zeile, Kennzahlen + Filter, Tabellenzeilen (§7). */
export default function Loading() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-32" />
      <div className="flex gap-2 border-b pb-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-28 rounded-xl" />)}
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="overflow-hidden rounded-xl border">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-none border-t" />
        ))}
      </div>
    </div>
  );
}
