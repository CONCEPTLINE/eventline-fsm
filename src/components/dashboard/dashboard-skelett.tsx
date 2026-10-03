// Lade-Skelett des Dashboards — dasselbe feste Raster wie die Seite
// (raster.ts, gezeichnet von raster-gitter.tsx): Kopf mit Kennzahl-Pillen,
// darunter bis zu drei Reihen zu je zwei Plaetzen (links 58 %, rechts 42 %,
// rechts unten Einsatz und Monat gestapelt). Mit der zuletzt bekannten
// Bereichs-Liste der Sitzung (session-cache.ts) zeigt es genau die Karten,
// die gleich kommen — ein Platz ohne Nachbar nimmt wie im Inhalt die ganze
// Reihe, leere Reihen entfallen, ohne jedes Paar die schmale Spalte. Ohne
// Kenntnis (erster Besuch, anderer User) das volle Raster. Genutzt von
// loading.tsx (Navigation) und von der Seite beim Laden ohne Session-Cache.

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";
import { RASTER_KEYS, belegteReihen, type RasterKey } from "@/components/dashboard/raster";
import { RasterGitter, rasterBreite } from "@/components/dashboard/raster-gitter";

/** Grobe Form je Karte: Zeilen-Liste oder eine hohe Flaeche. */
type Form = { zeilen: number } | "hoch";

const FORM: Record<RasterKey, Form> = {
  aufmerksamkeit: { zeilen: 4 },
  todos: { zeilen: 4 },
  anwesenheit: "hoch",
  team: { zeilen: 3 },
  naechste: { zeilen: 4 },
  einsatz: "hoch",
  monat: "hoch",
};

function KartenSkelett({ form }: { form: Form }) {
  return (
    <div className="flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-5">
      <Skeleton className="h-5 w-44" />
      {form === "hoch" ? (
        <Skeleton className="min-h-20 w-full flex-1" />
      ) : (
        Array.from({ length: form.zeilen }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-[34px] w-[34px] rounded-[10px]" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ))
      )}
    </div>
  );
}

export function DashboardSkelett({
  bereiche,
}: {
  /** Zuletzt bekannte sichtbare Bereiche; null/undefined = unbekannt → volles Raster. */
  bereiche?: readonly DashboardBereichKey[] | null;
}) {
  const bekannt = bereiche ? new Set<DashboardBereichKey>(bereiche) : null;
  const zeigt = (k: DashboardBereichKey) => bekannt === null || bekannt.has(k);
  const karten = new Map<RasterKey, Form>();
  for (const k of RASTER_KEYS) if (zeigt(k)) karten.set(k, FORM[k]);
  const reihen = belegteReihen(karten);
  // Kopf wie die Seite: Status-Satz nur mit Aufmerksamkeit, Todos oder
  // Einsatz, Pillen nur mit Kennzahlen.
  const mitSatz = zeigt("aufmerksamkeit") || zeigt("todos") || zeigt("einsatz");
  const mitPillen = zeigt("kennzahlen");

  return (
    <div className="page-enter @container" aria-busy="true">
      <div className={cn("mx-auto flex flex-col gap-7", rasterBreite(reihen))}>
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-2.5">
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-9 w-72" />
            {mitSatz && <Skeleton className="h-5 w-80 max-w-full" />}
          </div>
          {mitPillen && (
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-10 w-44 rounded-full" />
              <Skeleton className="h-10 w-48 rounded-full" />
            </div>
          )}
        </div>
        {reihen.length === 0 ? (
          // Rolle ohne Bereiche: die Seite zeigt einen einzeiligen Hinweis.
          <div className="flex items-start gap-4 rounded-xl border bg-card p-5">
            <Skeleton className="h-[22px] w-[22px] rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3.5 w-full max-w-[420px]" />
            </div>
          </div>
        ) : (
          <RasterGitter reihen={reihen} karte={(form) => <KartenSkelett form={form} />} />
        )}
      </div>
    </div>
  );
}
