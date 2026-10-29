"use client";

/**
 * Wartungsmodus im Browser: der Stand kommt vom Server-Layout der Seite
 * (WartungSeite in wartung-seite.tsx) und gilt für Tabs/Karten darin, z. B.
 * Einstellungen › Mitarbeiter (Bereich «Rechte») oder Sicherheit › Vertraute
 * Geräte (Bereich «Geräte»). Ohne Layout-Kontext gilt «frei» — die API-Routen
 * prüfen ohnehin selbst (503).
 *
 *   <WartungBereichSchranke bereich="rechte"><TeamTab /></WartungBereichSchranke>
 */

import { createContext, useContext, type ReactNode } from "react";
import type { WartungAnfrage, WartungBereich, WartungZugang } from "@/lib/wartung";
import { WartungBalken, WartungHinweis } from "./wartung-hinweis";

const WartungCtx = createContext<WartungAnfrage | null>(null);

export function WartungKontext({ wert, children }: { wert: WartungAnfrage; children: ReactNode }) {
  return <WartungCtx.Provider value={wert}>{children}</WartungCtx.Provider>;
}

export function useWartung(bereich: WartungBereich): { zugang: WartungZugang; grund: string | null } {
  const wert = useContext(WartungCtx);
  return { zugang: wert?.zugang[bereich] ?? "frei", grund: wert?.grund ?? null };
}

/** Gesperrt → Hinweis statt Inhalt (der Inhalt wird gar nicht erst
 *  gerendert, also auch nichts geladen). Ausnahme → Balken + Inhalt. */
export function WartungBereichSchranke({ bereich, children }: { bereich: WartungBereich; children: ReactNode }) {
  const { zugang, grund } = useWartung(bereich);
  if (zugang === "gesperrt") return <WartungHinweis bereich={bereich} />;
  if (zugang === "ausnahme") {
    return (
      <>
        <WartungBalken bereich={bereich} grund={grund} />
        {children}
      </>
    );
  }
  return <>{children}</>;
}
