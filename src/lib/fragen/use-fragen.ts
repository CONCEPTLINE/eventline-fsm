"use client";

// «Fragen an dich» — gemeinsamer Stand für das Pflicht-Modal (Layout) und
// «Mein Konto › Meine Antworten»: einmal laden, nach jeder eigenen Antwort
// aus der Server-Antwort nachführen (kein Ticker). Quelle: /api/profile/fragen.

import { useSyncExternalStore } from "react";
import type { Frage } from "./katalog";

export interface EigeneAntwort {
  antwort: string;
  text_version: string;
  beantwortet_at: string;
  quelle: string;
}

export interface FragenStand {
  status: "leer" | "laedt" | "bereit" | "fehler";
  ansichtAls: boolean;
  fragen: Frage[];
  antworten: Record<string, EigeneAntwort>;
  offen: string[];
}

const LEER: FragenStand = { status: "leer", ansichtAls: false, fragen: [], antworten: {}, offen: [] };
let stand: FragenStand = LEER;
let laufend: Promise<void> | null = null;
const hoerer = new Set<() => void>();

function setze(neu: FragenStand) {
  stand = neu;
  for (const h of hoerer) h();
}

function ausAntwort(j: Record<string, unknown>): FragenStand {
  return {
    status: "bereit",
    ansichtAls: j.ansicht_als === true,
    fragen: Array.isArray(j.fragen) ? (j.fragen as Frage[]) : [],
    antworten: j.antworten && typeof j.antworten === "object" ? (j.antworten as Record<string, EigeneAntwort>) : {},
    offen: Array.isArray(j.offen) ? (j.offen as string[]) : [],
  };
}

/** Stand (neu) laden. Fehler/Wartung = keine offenen Fragen anzeigen (nie blockieren, wenn unklar). */
export function ladeFragen(): Promise<void> {
  if (laufend) return laufend;
  if (stand.status === "leer") setze({ ...stand, status: "laedt" });
  laufend = (async () => {
    try {
      const res = await fetch("/api/profile/fragen", { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || j.success !== true) {
        setze({ ...LEER, status: "fehler" });
        return;
      }
      setze(ausAntwort(j));
    } catch {
      setze({ ...LEER, status: "fehler" });
    } finally {
      laufend = null;
    }
  })();
  return laufend;
}

/** Antwort speichern (neuer Verlaufseintrag). Wirft mit der Meldung des Servers. */
export async function speichereAntwort(frage: Frage, antwort: string): Promise<void> {
  const res = await fetch("/api/profile/fragen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frage: frage.schluessel, antwort, text_version: frage.version }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || j.success !== true) {
    if (j.code === "neue_fassung") void ladeFragen();
    throw new Error(typeof j.error === "string" ? j.error : "Speichern fehlgeschlagen.");
  }
  setze(ausAntwort(j));
}

function abonniere(h: () => void) {
  hoerer.add(h);
  return () => hoerer.delete(h);
}

export function useFragen(): FragenStand {
  return useSyncExternalStore(abonniere, () => stand, () => LEER);
}

/** Beim Abmelden/Kontowechsel vergessen. */
export function vergissFragen() {
  setze(LEER);
}
