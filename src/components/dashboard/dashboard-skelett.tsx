// Lade-Skelett des Dashboards — dasselbe feste Raster wie die Seite
// (src/components/dashboard/raster.ts): Kopf mit Kennzahl-Pillen, darunter
// bis zu drei Reihen zu je zwei Karten (links 58 %, rechts 42 %). Mit der
// zuletzt bekannten Bereichs-Liste der Sitzung (session-cache.ts) zeigt es
// genau die Karten, die gleich kommen — ein Platz ohne Nachbar nimmt wie im
// Inhalt die ganze Reihe, leere Reihen entfallen. Ohne Kenntnis (erster
// Besuch, anderer User) das volle Raster. Genutzt von loading.tsx
// (Navigation) und von der Seite beim Laden ohne Session-Cache.

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";
import { RASTER, belegteReihen, type RasterKey } from "@/components/dashboard/raster";

/** Grobe Form je Karte: Zeilen-Liste oder eine hohe Flaeche. */
type Form = { zeilen: number } | "hoch";

const FORM: Record<RasterKey, Form> = {
  aufmerksamkeit: { zeilen: 4 },
  team: { zeilen: 3 },
  anwesenheit: "hoch",
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
  const plaetze = new Map<RasterKey, Form>();
  for (const reihe of RASTER) {
    for (const k of reihe) if (zeigt(k)) plaetze.set(k, FORM[k]);
  }
  const reihen = belegteReihen(plaetze);
  const anzahl = reihen.reduce((n, r) => n + r.length, 0);
  // Kopf wie die Seite: Status-Satz nur mit Aufmerksamkeit oder Einsatz,
  // Pillen nur mit Kennzahlen.
  const mitSatz = zeigt("aufmerksamkeit") || zeigt("einsatz");
  const mitPillen = zeigt("kennzahlen");

  return (
    <div className="page-enter @container" aria-busy="true">
      <div className={cn("mx-auto flex flex-col gap-7", anzahl > 1 ? "max-w-[1180px]" : "max-w-[720px]")}>
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
        {anzahl === 0 ? (
          // Rolle ohne Bereiche: die Seite zeigt einen einzeiligen Hinweis.
          <div className="flex items-start gap-4 rounded-xl border bg-card p-5">
            <Skeleton className="h-[22px] w-[22px] rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3.5 w-full max-w-[420px]" />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 @min-[840px]:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
            {reihen.flatMap((r) =>
              r.map((p) => (
                <div key={p.key} className={cn("grid min-w-0", r.length === 1 && "@min-[840px]:col-span-2")}>
                  <KartenSkelett form={p.inhalt} />
                </div>
              )),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
