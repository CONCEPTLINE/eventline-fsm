// KI-Vorschlag einer Ablage-Karte (Upload und Mail-Eingang) neben dem final gewaehlten Ziel festhalten
// (Migration 339, ablage_items.ki_*) — fuer die Trefferquote der KI im Technik-Dashboard (VERTRAG §6.5).
// Rein (kein I/O), geteilt von der NAS-Seite (Momentaufnahme beim Eintreffen des Vorschlags) und
// /api/ablage/upload (Pruefung, Name nach demselben Schema wie der finale).
//
// Quelle: 'regel' / 'lokal' / 'claude' = die lokale KI hat das Dokument gelesen, den Ordner bestimmte eine Regel,
// die lokale KI oder Claude (ordner_quelle, V8); 'beschrieb' = lokale KI offline, Claude hat nur den getippten
// Beschrieb strukturiert (/api/ablage/name-vorschlag). Nur Ordnerpfad und Namens-Bausteine — nie Dokumentinhalt.

import { baueAblageName, dokTyp } from "@/lib/ablage-doktypen";
import { leseNasPfad } from "./bereinigen";

export const KI_VORSCHLAG_QUELLEN = ["regel", "lokal", "claude", "beschrieb"] as const;
export type KiVorschlagQuelle = (typeof KI_VORSCHLAG_QUELLEN)[number];

/** Momentaufnahme des Vorschlags, wie die KI ihn auf die Karte gelegt hat (vor jeder Aenderung durch den Menschen). */
export interface KiVorschlagKarte {
  quelle: KiVorschlagQuelle;
  /** Vorgeschlagener Ordner — auch ein vorgeschlagener NEUER; null = keiner vorgeschlagen. */
  ordner: string | null;
  typ: string;
  betreff: string;
  person: string;
  partei: string;
  nummer: string;
  dok_datum: string;
}

/** Spalten in ablage_items (Migration 339). */
export interface KiVorschlagSpalten {
  ki_quelle: KiVorschlagQuelle;
  ki_ordner: string | null;
  ki_name: string | null;
}

const ORDNER_MAX = 300; // = check in 339
const FELD_MAX = 120; // = Kuerzung der Felder im Upload
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

const text = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, FELD_MAX) : "");

/** Momentaufnahme fuer eine Karte bauen (Browser): leere/ungueltige Werte werden leer, der Typ faellt auf
 *  «sonstiges» zurueck, eine Person zaehlt nur, wenn der Typ sie kennt — wie beim Ablegen. */
export function kiVorschlagKarte(quelle: KiVorschlagQuelle, f: {
  ordner?: string | null; neuer_ordner?: string | null; typ?: string | null; betreff?: string | null;
  person?: string | null; partei?: string | null; nummer?: string | null; dok_datum?: string | null;
}): KiVorschlagKarte {
  const typ = dokTyp(text(f.typ)) ? text(f.typ) : "sonstiges";
  const roh = (typeof f.ordner === "string" ? f.ordner.trim() : "") || (typeof f.neuer_ordner === "string" ? f.neuer_ordner.trim() : "");
  const ordner = leseNasPfad(roh);
  return {
    quelle,
    ordner: ordner && ordner.length <= ORDNER_MAX ? ordner : null,
    typ,
    betreff: text(f.betreff),
    person: dokTyp(typ)?.person ? text(f.person) : "",
    partei: text(f.partei),
    nummer: text(f.nummer),
    dok_datum: DATUM_RE.test(text(f.dok_datum)) ? text(f.dok_datum) : "",
  };
}

/** Momentaufnahme aus dem Upload-Formular lesen (Server). Ungueltig -> null (dann ohne KI-Vorschlag ablegen). */
export function leseKiVorschlag(roh: unknown): KiVorschlagKarte | null {
  if (typeof roh !== "string" || !roh || roh.length > 4000) return null;
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  const quelle = (KI_VORSCHLAG_QUELLEN as readonly unknown[]).includes(o.quelle) ? (o.quelle as KiVorschlagQuelle) : null;
  if (!quelle) return null;
  return kiVorschlagKarte(quelle, {
    ordner: typeof o.ordner === "string" ? o.ordner : null,
    typ: o.typ as string, betreff: o.betreff as string, person: o.person as string, partei: o.partei as string,
    nummer: o.nummer as string, dok_datum: o.dok_datum as string,
  });
}

/** Spalten fuer ablage_items: der vorgeschlagene Name entsteht nach demselben Schema und mit demselben Tag wie der
 *  finale (baueAblageName) — so ist «Name unveraendert» ein ehrlicher Vergleich. Ohne Betreff kein Namensvorschlag. */
export function kiVorschlagSpalten(v: KiVorschlagKarte, originalName: string, heuteIso: string): KiVorschlagSpalten {
  const name = v.betreff
    ? baueAblageName({ typKey: v.typ, betreff: v.betreff, person: v.person, partei: v.partei, nummer: v.nummer, dokDatum: v.dok_datum }, originalName, heuteIso)
    : null;
  return { ki_quelle: v.quelle, ki_ordner: v.ordner, ki_name: name };
}

/** Seitenzahl aus dem gespeicherten Ergebnis der lokalen KI (ki_auftraege.ergebnis.seiten), sonst null. */
export function leseSeiten(ergebnis: unknown): number | null {
  const s = ergebnis && typeof ergebnis === "object" ? (ergebnis as Record<string, unknown>).seiten : null;
  return typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= 100_000 ? s : null;
}
