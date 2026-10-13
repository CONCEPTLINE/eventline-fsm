import { Skeleton } from "@/components/ui/skeleton";

/**
 * Kalender-Skeleton. Desktop (ab md): Header + Toolbar + grosser Kalender-
 * bereich. Handy (< md): Monatsansicht (Monatszeile 46 px, Wochentage,
 * 5 Rasterzeilen à 50 px, Tagestitel 32 px + 3 Zeilen à 58 px), passend zu
 * src/components/mobile/kalender-monat.tsx.
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

      <div className="md:hidden -mx-[10px]" aria-busy>
        <div className="flex h-[46px] items-center gap-2 pl-[10px] pr-[10px]">
          <Skeleton className="h-[24px] w-40" />
          <div className="flex-1" />
          <Skeleton className="h-[22px] w-[22px] rounded-full" />
          <Skeleton className="h-[22px] w-[22px] rounded-full" />
        </div>
        <div className="flex h-[20px] items-center border-b border-border">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex flex-1 justify-center">
              <Skeleton className="h-[10px] w-[8px]" />
            </div>
          ))}
        </div>
        {Array.from({ length: 5 }).map((_, w) => (
          <div key={w} className="flex h-[50px] border-b border-border pt-[11px]">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex flex-1 justify-center">
                <Skeleton className="h-[16px] w-[18px]" />
              </div>
            ))}
          </div>
        ))}
        <div className="flex h-[32px] items-center border-b border-border px-[10px]">
          <Skeleton className="h-3.5 w-40" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex min-h-[58px] items-start gap-3 px-[10px] py-2.5">
              <Skeleton className="w-[3px] self-stretch" />
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
    </>
  );
}
