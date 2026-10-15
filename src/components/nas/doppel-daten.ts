"use client";

// Doppel-Liste der lokalen KI im Browser (GET/POST /api/ablage/doppel, Migration 330, lib/ki/doppel).
// Einsortieren (Chip je ZZ-Zeile) und «Doppelte» (ganze Liste) lesen dieselben Daten: ein Abruf je Takt,
// laufende Abrufe werden geteilt. Nur Pfade/Groessen/Werte — nie Inhalte.

import { useCallback, useEffect, useRef, useState } from "react";
import { behaltenPaar, type DoppelGruppe } from "@/lib/ki/doppel";

export interface DoppelDaten {
  gruppen: DoppelGruppe[];
  /** «Beide behalten»-Paare als Schluessel behaltenSchluessel(a, b). */
  behalten: Set<string>;
  stand: { aktualisiert: string; lauf_id: string } | null;
}

export function behaltenSchluessel(a: string, b: string): string {
  return behaltenPaar(a, b).join("\n");
}

let laufend: Promise<DoppelDaten> | null = null;

/** Ein Abruf (geteilt, solange er laeuft). Wirft mit deutscher Meldung. */
export function ladeDoppelDaten(): Promise<DoppelDaten> {
  if (laufend) return laufend;
  laufend = (async () => {
    try {
      const res = await fetch("/api/ablage/doppel", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
      const behalten = new Set<string>();
      for (const p of (json.behalten ?? []) as [string, string][]) {
        if (Array.isArray(p) && p.length === 2) behalten.add(behaltenSchluessel(p[0], p[1]));
      }
      return { gruppen: (json.gruppen ?? []) as DoppelGruppe[], behalten, stand: json.stand ?? null };
    } finally {
      laufend = null;
    }
  })();
  return laufend;
}

/** Daten laden bei Mount und je Takt; `neuLaden` nach einer Aktion. Fehler einmal melden (onFehler). */
export function useDoppelDaten(takt: number, onFehler?: (meldung: string) => void) {
  const [daten, setDaten] = useState<DoppelDaten | null>(null);
  const nr = useRef(0);
  const gemeldet = useRef(false);
  const neuLaden = useCallback(async () => {
    const meine = ++nr.current;
    try {
      const d = await ladeDoppelDaten();
      if (meine !== nr.current) return;
      gemeldet.current = false;
      setDaten(d);
    } catch (e) {
      if (meine !== nr.current) return;
      setDaten((alt) => alt ?? { gruppen: [], behalten: new Set(), stand: null });
      if (!gemeldet.current) {
        gemeldet.current = true;
        onFehler?.(e instanceof Error ? e.message : "Doppel-Liste nicht geladen");
      }
    }
  }, [onFehler]);
  useEffect(() => {
    // State wird erst nach der Antwort gesetzt (asynchron).
    void (async () => { await neuLaden(); })();
  }, [neuLaden, takt]);
  return { daten, neuLaden };
}

export type DoppelAktion =
  | { aktion: "entfernen"; pfad: string }
  | { aktion: "behalten"; pfad: string; anderer: string }
  | { aktion: "fassung"; pfad: string; anderer: string; vorschlag_id: string; name?: string };

/** Aktion ausfuehren (POST /api/ablage/doppel). Fehler → { ok: false, meldung } fuer den Toast. */
export async function doppelAktion(a: DoppelAktion): Promise<{ ok: true; ziel?: string; historie?: string | null } | { ok: false; meldung: string }> {
  try {
    const res = await fetch("/api/ablage/doppel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) return { ok: false, meldung: json?.error ?? `HTTP ${res.status}` };
    return { ok: true, ziel: json.ziel, historie: json.historie };
  } catch {
    return { ok: false, meldung: "Netzwerkfehler" };
  }
}

export function groesseText(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

const DATUM = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
const ZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function datumText(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATUM.format(d);
}

export function zeitText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ZEIT.format(d);
}
