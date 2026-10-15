import { Skeleton } from "@/components/ui/skeleton";

/**
 * Finanzen-Skeleton im Raster der echten Seite: Kopfzeile (Titel + Abgleich),
 * vier Kacheln, Diagramm | Bankkonten, Debitoren | Kreditoren. Hoehe wie das
 * Dashboard (Viewport minus Huelle), damit beim Umschalten nichts springt.
 */
export default function Loading() {
  return (
    <div
      className="flex flex-col gap-3 md:grid md:h-[max(520px,calc(100dvh-104px))]"
      style={{ gridTemplateRows: "auto auto minmax(0,1fr) minmax(0,1fr)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-72" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[66px]" />
        ))}
      </div>
      <div className="grid gap-3 min-h-0 md:grid-cols-[3fr_2fr]">
        <Skeleton className="min-h-[220px] md:min-h-0" />
        <Skeleton className="min-h-[160px] md:min-h-0" />
      </div>
      <div className="grid gap-3 min-h-0 md:grid-cols-2">
        <Skeleton className="min-h-[160px] md:min-h-0" />
        <Skeleton className="min-h-[160px] md:min-h-0" />
      </div>
    </div>
  );
}
