"use client";

// Inhalt des Dashboards (ohne Laden/Cache — das macht die Seite):
// Kopf (Datum, Gruss, Status-Satz, Kennzahlen) und darunter das feste Raster
// aus drei Reihen zu je zwei Plaetzen (links 58 %, rechts 42 %), definiert in
// src/components/dashboard/raster.ts:
//   [Braucht Aufmerksamkeit | Team]
//   [Anwesenheit           | Als Naechstes]
//   [Naechster Einsatz     | Mein Monat]
// Fehlt ein Nachbar, nimmt die Karte die ganze Reihe; leere Reihen entfallen;
// die Karten einer Reihe sind gleich hoch (CSS-Grid, align-items: stretch),
// ihr Inhalt fuellt den Platz (Ruhe-Flaeche und Listen wachsen, Fusszeilen
// stehen unten). Unter 840 px Inhaltsbreite eine Spalte in Dokument-
// Reihenfolge (Container-Query). Nur eine Karte insgesamt: max. 720 px breit.
// (Mischa 2026-10-03: «viel leerer Raum, Seite gleichmaessig fuellen».)

import type { ReactNode } from "react";
import { Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardDaten } from "@/components/dashboard/typen";
import type { Auftakt } from "@/components/dashboard/use-auftakt";
import { belegteReihen, type RasterKey } from "@/components/dashboard/raster";
import { DashboardKopf } from "@/components/dashboard/dashboard-kopf";
import { AufmerksamkeitKarte } from "@/components/dashboard/aufmerksamkeit-karte";
import { AnwesenheitskalenderCard } from "@/components/dashboard/anwesenheit-card";
import { TeamKarte } from "@/components/dashboard/team-karte";
import { NaechsteKarte } from "@/components/dashboard/naechste-karte";
import { EinsatzKarte } from "@/components/dashboard/einsatz-karte";
import { MonatKarte } from "@/components/dashboard/monat-karte";

export function DashboardInhalt({ daten, auftakt }: { daten: DashboardDaten; auftakt: Auftakt }) {
  const b = new Set(daten.bereiche);
  // Belegte Plaetze: die Rolle sieht den Bereich UND Daten dazu kamen —
  // sonst bleibt der Platz leer und der Nachbar nimmt die Reihe.
  const plaetze = new Map<RasterKey, ReactNode>();
  if (b.has("aufmerksamkeit") && daten.aufmerksamkeit) {
    plaetze.set(
      "aufmerksamkeit",
      <AufmerksamkeitKarte daten={daten.aufmerksamkeit} anteil={auftakt.anteil} haken={auftakt.haken} />,
    );
  }
  if (b.has("team") && daten.team) plaetze.set("team", <TeamKarte daten={daten.team} />);
  if (b.has("anwesenheit")) plaetze.set("anwesenheit", <AnwesenheitskalenderCard />);
  if (b.has("naechste") && daten.naechste) plaetze.set("naechste", <NaechsteKarte daten={daten.naechste} />);
  if (b.has("einsatz") && daten.einsatz) plaetze.set("einsatz", <EinsatzKarte daten={daten.einsatz} />);
  if (b.has("monat") && daten.monat) plaetze.set("monat", <MonatKarte daten={daten.monat} />);
  const reihen = belegteReihen(plaetze);
  const anzahl = reihen.reduce((n, r) => n + r.length, 0);

  return (
    <div className="page-enter @container">
      <div className={cn("mx-auto flex flex-col gap-7", anzahl > 1 ? "max-w-[1180px]" : "max-w-[720px]")}>
        <DashboardKopf daten={daten} anteil={auftakt.anteil} />

        {anzahl === 0 ? (
          // Rolle ohne jeden Bereich: ruhiger Hinweis statt leerer Seite.
          <section className="flex items-start gap-4 rounded-xl border bg-card p-5">
            <Sun className="mt-0.5 h-[22px] w-[22px] shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
            <span className="flex flex-col gap-0.5">
              <b className="text-[15px] font-semibold">Schön, dass du da bist.</b>
              <span className="text-[13px] text-foreground/75">
                Für deine Rolle zeigt das Dashboard keine Bereiche. Alles Weitere erreichst du über die Navigation.
              </span>
            </span>
          </section>
        ) : (
          // Ab 840 px Inhaltsbreite zwei Spalten (58/42), darunter eine Spalte
          // in Dokument-Reihenfolge. Karten einer Reihe sind gleich hoch
          // (Grid-Standard align-items: stretch); eine Karte ohne Nachbar
          // nimmt beide Spalten.
          <div className="grid grid-cols-1 gap-5 @min-[840px]:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
            {reihen.flatMap((r) =>
              r.map((p) => (
                // grid: die Karte streckt sich auf die Hoehe der Reihe.
                <div key={p.key} className={cn("grid min-w-0", r.length === 1 && "@min-[840px]:col-span-2")}>
                  {p.inhalt}
                </div>
              )),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
