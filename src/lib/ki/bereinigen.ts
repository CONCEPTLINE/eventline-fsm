// Bereinigung der Rig-Ergebnisse fuer die Arten ohne Datei
// (docs/lokale-ki/MASTERPLAN.md §3.3/§3.4) und ihre Aufbereitung fuer den
// Browser. Rein (kein I/O) — die Routen laden den Datei-Index und reichen
// ihn hier hinein.
//
// Grundsatz: Vom Rig kommt nur, was der Vertrag nennt. Die Suche liefert nie
// Text (nur Pfad, Seite, Score), die Archiv-Frage nur Antworttext und
// Quellenpfade. Alle anderen Felder fallen weg, Laengen werden gekappt,
// Pfade mit `..` oder absolutem Anfang verworfen.

import {
  KI_ARCHIV_ANTWORT_MAX,
  KI_ARCHIV_MAX_QUELLEN,
  KI_PFAD_MAX,
  KI_SUCHE_MAX_TREFFER,
} from "./konstanten";
import type {
  ArchivFrageErgebnis,
  ArchivQuelle,
  ArchivQuelleAnzeige,
  NasSucheErgebnis,
  NasSucheTreffer,
  NasSucheTrefferAnzeige,
} from "./typen";

/** NAS-Pfad, wie ihn das Rig melden darf (MASTERPLAN §3.0): relativ zur
 *  NAS-Wurzel, mit `/`, ohne fuehrenden `/`, ohne `.`/`..`/leere Segmente,
 *  ohne Backslash und Steuerzeichen, hoechstens 1000 Zeichen, Unicode NFC.
 *  Gibt den normalisierten Pfad zurueck oder null. */
export function leseNasPfad(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const pfad = roh.normalize("NFC");
  if (!pfad || pfad.length > KI_PFAD_MAX) return null;
  if (pfad.startsWith("/") || pfad.includes("\\") || /[\u0000-\u001f\u007f]/.test(pfad)) return null;
  if (pfad.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return pfad;
}

/** Seitenzahl: Ganzzahl >= 1, sonst null. */
function leseSeite(roh: unknown): number | null {
  return typeof roh === "number" && Number.isInteger(roh) && roh >= 1 && roh <= 100_000 ? roh : null;
}

function leseDauer(roh: unknown): number {
  const n = Number(roh);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function istObjekt(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Systembereich des NAS (Papierkorb, Sync-Interna) — nie anzeigen. */
export function istSystemPfad(pfad: string): boolean {
  return pfad === "99_System" || pfad.startsWith("99_System/");
}

/** Ergebnis von `nas_suche` (POST /api/ki/sync). Kein `treffer`-Array =
 *  kein gueltiges Ergebnis (null). Je Treffer nur pfad/seite/score, Score
 *  auf 0..1 geklemmt, ohne Doppel, hoechstens 50. */
export function bereinigeNasSucheErgebnis(roh: Record<string, unknown>): NasSucheErgebnis | null {
  if (!Array.isArray(roh.treffer)) return null;
  const treffer: NasSucheTreffer[] = [];
  const gesehen = new Set<string>();
  for (const t of roh.treffer as unknown[]) {
    if (treffer.length >= KI_SUCHE_MAX_TREFFER) break;
    if (!istObjekt(t)) continue;
    const pfad = leseNasPfad(t.pfad);
    const score = typeof t.score === "number" && Number.isFinite(t.score) ? Math.min(1, Math.max(0, t.score)) : null;
    if (!pfad || score === null || gesehen.has(pfad)) continue;
    gesehen.add(pfad);
    treffer.push({ pfad, seite: leseSeite(t.seite), score });
  }
  let index: NasSucheErgebnis["index"] = null;
  if (istObjekt(roh.index)) {
    const dateien = roh.index.dateien;
    const anteil = roh.index.gelesen_anteil;
    index = {
      dateien: typeof dateien === "number" && Number.isInteger(dateien) && dateien >= 0 ? dateien : null,
      gelesen_anteil: typeof anteil === "number" && Number.isFinite(anteil) ? Math.min(1, Math.max(0, anteil)) : null,
    };
  }
  // modus nur mit einem der beiden bekannten Werte, sonst weglassen.
  const modus = roh.modus === "kombiniert" || roh.modus === "volltext" ? roh.modus : null;
  return { treffer, index, dauer_ms: leseDauer(roh.dauer_ms), ...(modus ? { modus } : {}) };
}

/** Ergebnis von `archiv_frage` (POST /api/ki/sync). Ohne Antworttext kein
 *  gueltiges Ergebnis (null). Antwort hoechstens 4000 Zeichen, hoechstens
 *  8 Quellen (pfad/seite), sonst nichts. */
export function bereinigeArchivFrageErgebnis(roh: Record<string, unknown>): ArchivFrageErgebnis | null {
  if (typeof roh.antwort !== "string") return null;
  const antwort = roh.antwort.trim().slice(0, KI_ARCHIV_ANTWORT_MAX);
  if (!antwort) return null;
  const quellen: ArchivQuelle[] = [];
  if (Array.isArray(roh.quellen)) {
    for (const q of roh.quellen as unknown[]) {
      if (quellen.length >= KI_ARCHIV_MAX_QUELLEN) break;
      if (!istObjekt(q)) continue;
      const pfad = leseNasPfad(q.pfad);
      const seite = leseSeite(q.seite);
      if (!pfad || quellen.some((x) => x.pfad === pfad && x.seite === seite)) continue;
      quellen.push({ pfad, seite });
    }
  }
  const modell = typeof roh.modell === "string" ? roh.modell.trim().slice(0, 80) : "";
  return { antwort, quellen, modell, dauer_ms: leseDauer(roh.dauer_ms) };
}

/** Textfeld aus einem Browser-Body (Suchbegriff, Archiv-Frage): getrimmt,
 *  Unicode NFC, Laenge min..max — sonst null (Route antwortet 400). */
export function leseEingabeText(roh: unknown, min: number, max: number): string | null {
  if (typeof roh !== "string") return null;
  const text = roh.normalize("NFC").trim();
  return text.length >= min && text.length <= max ? text : null;
}

/** Zeile aus ablage_datei_index, soweit die Anzeige sie braucht. */
export interface IndexZeile {
  pfad: string;
  name: string;
  ordner_pfad: string;
  geaendert: string | null;
}

/** Treffer fuer den Browser: nur Pfade aus dem Datei-Index (was das NAS
 *  heute zeigt), nie 99_System/, ergaenzt um Name/Ordner/Aenderungsdatum.
 *  Reihenfolge des Rigs bleibt. */
export function trefferFuerAnzeige(treffer: readonly NasSucheTreffer[], index: ReadonlyMap<string, IndexZeile>): NasSucheTrefferAnzeige[] {
  const aus: NasSucheTrefferAnzeige[] = [];
  for (const t of treffer) {
    const z = index.get(t.pfad);
    if (!z || istSystemPfad(t.pfad)) continue;
    aus.push({ pfad: t.pfad, name: z.name, ordner: z.ordner_pfad, seite: t.seite, score: t.score, geaendert: z.geaendert });
  }
  return aus;
}

/** Quellen fuer den Browser — gleiche Regel wie bei den Treffern. */
export function quellenFuerAnzeige(quellen: readonly ArchivQuelle[], index: ReadonlyMap<string, IndexZeile>): ArchivQuelleAnzeige[] {
  const aus: ArchivQuelleAnzeige[] = [];
  for (const q of quellen) {
    const z = index.get(q.pfad);
    if (!z || istSystemPfad(q.pfad)) continue;
    aus.push({ pfad: q.pfad, name: z.name, ordner: z.ordner_pfad, seite: q.seite });
  }
  return aus;
}
