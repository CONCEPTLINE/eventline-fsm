/**
 * Wartungsmodus — Darstellung (ohne Hooks, nutzbar in Server- und
 * Client-Komponenten). Regeln und Texte: src/lib/wartung.ts.
 *
 *   WartungHinweis  ruhige Hinweisseite statt des Inhalts (gesperrt)
 *   WartungBalken   gut sichtbarer Balken «Wartung aktiv» für die Ausnahmen
 *
 * Kontakt als Kasten-Knöpfe (globals.css .kasten): Mail = mailto:, Telefon = tel:.
 */

import { Mail, Phone, Wrench } from "lucide-react";
import { WARTUNG_BEREICH_INFO, WARTUNG_KONTAKT, type WartungBereich } from "@/lib/wartung";

export function WartungHinweis({ bereich }: { bereich: WartungBereich }) {
  return (
    <div className="page-enter flex justify-center py-10 md:py-16">
      <section
        aria-labelledby="wartung-titel"
        className="w-full max-w-lg rounded-2xl border border-border bg-card px-5 py-8 md:px-8 text-center space-y-4"
      >
        <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
          <Wrench className="h-7 w-7 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {WARTUNG_BEREICH_INFO[bereich].label} · Wartung
          </p>
          <h2 id="wartung-titel" className="font-semibold text-lg">
            Im Umbau
          </h2>
        </div>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Diese Funktion ist im Moment wegen Umbauten nicht möglich. Bitte {WARTUNG_KONTAKT.name} kontaktieren:
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <a href={`mailto:${WARTUNG_KONTAKT.mail}`} className="kasten max-md:min-h-[34px]">
            <Mail className="h-4 w-4" aria-hidden />
            {WARTUNG_KONTAKT.mail}
          </a>
          <span className="hidden sm:inline text-muted-foreground/60 text-xs" aria-hidden>
            ·
          </span>
          <a href={WARTUNG_KONTAKT.telefonLink} className="kasten max-md:min-h-[34px]">
            <Phone className="h-4 w-4" aria-hidden />
            {WARTUNG_KONTAKT.telefon}
          </a>
        </div>
      </section>
    </div>
  );
}

export function WartungBalken({ bereich, grund }: { bereich: WartungBereich; grund: string | null }) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-xl border-2 border-amber-500 bg-amber-500/15 dark:bg-amber-500/25 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
    >
      <Wrench className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        <span className="font-semibold">Wartung aktiv</span>
        {" — "}
        {WARTUNG_BEREICH_INFO[bereich].label} ist für alle anderen gesperrt; du arbeitest als Ausnahme.
        {grund && <span className="text-amber-800/80 dark:text-amber-100/80"> Grund: {grund}</span>}
      </p>
    </div>
  );
}
