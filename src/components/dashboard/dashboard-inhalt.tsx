"use client";

// Inhalt des Dashboards (ohne Laden/Cache — das macht die Seite):
// Kopf (Datum, Gruss, Status-Satz, Kennzahlen) und darunter das feste Raster
// aus drei Reihen zu je zwei Plaetzen (links 58 %, rechts 42 %), definiert in
// src/components/dashboard/raster.ts, gezeichnet von raster-gitter.tsx:
//   [Braucht Aufmerksamkeit | Meine Todos]
//   [Anwesenheit           | Team]
//   [Als Naechstes         | Naechster Einsatz ueber Mein Monat]
// Fehlt ein Nachbar, nimmt der Platz die ganze Reihe; leere Reihen
// entfallen; die Karten einer Reihe sind gleich hoch, ihr Inhalt fuellt den
// Platz (Ruhe-Flaeche und Listen wachsen, Fusszeilen stehen unten). Unter
// 840 px Inhaltsbreite eine Spalte in Dokument-Reihenfolge. Hat keine Reihe
// ein Paar (z. B. Techniker): eine zentrierte Spalte, max. 720 px.
// (Mischa 2026-10-03: «viel leerer Raum, Seite gleichmaessig fuellen»;
// «beim Dashboard sollten auch Todos angezeigt werden».)

import type { ReactNode } from "react";
import { Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardDaten } from "@/components/dashboard/typen";
import type { Auftakt } from "@/components/dashboard/use-auftakt";
import { belegteReihen, type RasterKey } from "@/components/dashboard/raster";
import { RasterGitter, rasterBreite } from "@/components/dashboard/raster-gitter";
import { DashboardKopf } from "@/components/dashboard/dashboard-kopf";
import { AufmerksamkeitKarte } from "@/components/dashboard/aufmerksamkeit-karte";
import { TodosKarte } from "@/components/dashboard/todos-karte";
import { AnwesenheitskalenderCard } from "@/components/dashboard/anwesenheit-card";
import { TeamKarte } from "@/components/dashboard/team-karte";
import { NaechsteKarte } from "@/components/dashboard/naechste-karte";
import { EinsatzKarte } from "@/components/dashboard/einsatz-karte";
import { MonatKarte } from "@/components/dashboard/monat-karte";

export function DashboardInhalt({
  daten,
  auftakt,
  neuLaden,
}: {
  daten: DashboardDaten;
  auftakt: Auftakt;
  /** Daten still neu laden (stabil) — fuer «Meine Todos» nach einem Fehler
   *  oder zum Nachruecken nach dem Abhaken. */
  neuLaden: () => void;
}) {
  const b = new Set(daten.bereiche);
  // Belegte Bereiche: die Rolle sieht den Bereich UND Daten dazu kamen —
  // sonst bleibt er leer (und mit ihm ggf. der Platz, der Nachbar nimmt die
  // Reihe).
  const karten = new Map<RasterKey, ReactNode>();
  if (b.has("aufmerksamkeit") && daten.aufmerksamkeit) {
    karten.set(
      "aufmerksamkeit",
      <AufmerksamkeitKarte daten={daten.aufmerksamkeit} anteil={auftakt.anteil} haken={auftakt.haken} />,
    );
  }
  if (b.has("todos") && daten.todos) {
    karten.set("todos", <TodosKarte daten={daten.todos} haken={auftakt.haken} neuLaden={neuLaden} />);
  }
  if (b.has("anwesenheit")) karten.set("anwesenheit", <AnwesenheitskalenderCard />);
  if (b.has("team") && daten.team) karten.set("team", <TeamKarte daten={daten.team} />);
  if (b.has("naechste") && daten.naechste) karten.set("naechste", <NaechsteKarte daten={daten.naechste} />);
  if (b.has("einsatz") && daten.einsatz) karten.set("einsatz", <EinsatzKarte daten={daten.einsatz} />);
  if (b.has("monat") && daten.monat) karten.set("monat", <MonatKarte daten={daten.monat} />);
  const reihen = belegteReihen(karten);

  return (
    <div className="page-enter @container">
      <div className={cn("mx-auto flex flex-col gap-7", rasterBreite(reihen))}>
        <DashboardKopf daten={daten} anteil={auftakt.anteil} />

        {reihen.length === 0 ? (
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
          <RasterGitter reihen={reihen} karte={(inhalt) => inhalt} />
        )}
      </div>
    </div>
  );
}
