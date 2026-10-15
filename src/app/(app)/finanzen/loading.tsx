import { Skeleton } from "@/components/ui/skeleton";

/**
 * Finanzen-Skeleton: Kopf, Abgleich-Zeile, vier Kennzahl-Kacheln, Diagramm
 * und zwei Listen — spiegelt die Reihenfolge der echten Seite.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-10" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[0, 1].map((col) => (
          <div key={col} className="space-y-3">
            <Skeleton className="h-4 w-40" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
