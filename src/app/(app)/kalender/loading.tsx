import { Skeleton } from "@/components/ui/skeleton";

/**
 * Kalender-Skeleton. Desktop (ab md): Header + Toolbar + grosser Kalender-
 * bereich. Handy (< md): Tagesliste (Tagestrenner + Zeilen 76 px), passend
 * zu src/components/mobile/einsaetze-liste.tsx.
 */
export default function Loading() {
  return (
    <>
      <div className="hidden md:block space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="space-y-2">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-56" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
        <Skeleton className="h-[600px]" />
      </div>

      <div className="md:hidden -mx-4" aria-busy>
        {[3, 2, 2].map((n, gi) => (
          <div key={gi}>
            <div className="flex h-8 items-center border-y border-border px-4">
              <Skeleton className="h-3.5 w-28" />
            </div>
            <div className="divide-y divide-border">
              {Array.from({ length: n }).map((_, i) => (
                <div key={i} className="flex min-h-[76px] items-start gap-3 px-4 py-2.5">
                  <div className="w-12 shrink-0 space-y-1.5 pt-0.5">
                    <Skeleton className="h-4 w-11" />
                    <Skeleton className="h-3.5 w-9" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="h-3.5 w-3/5" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
