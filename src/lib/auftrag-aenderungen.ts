// Änderungsverlauf der Auftrags-Stammdaten (Migration 319, Tabelle
// public.job_aenderungen) — reine Anzeige-Helfer: deutsche Feldnamen,
// Werte lesbar machen (Namen statt IDs, Daten in Zürich-Zeit) und die
// Zeilen «Feld: alt → neu». Ohne React/Supabase, damit testbar.

import { formatDateFull, formatDateTimeFull } from "@/lib/format";
import { localTimeHM } from "@/lib/swiss-time";

export type AenderungArt = "aenderung" | "rueckgaengig";

/** {spalte: {alt, neu}} — Werte so, wie Postgres sie als jsonb liefert. */
export type FelderDiff = Record<string, { alt: unknown; neu: unknown }>;

export type AuftragAenderung = {
  id: string;
  zeitpunkt: string;
  person_id: string | null;
  person_name: string | null;
  felder: FelderDiff;
  art: AenderungArt;
  bezug_id: string | null;
  rueckgaengig_at: string | null;
  rueckgaengig_von: string | null;
};

type FeldTyp = "text" | "lang" | "datum" | "kunde" | "location" | "raum" | "person" | "auftragsart" | "prioritaet";

/** Protokollierte Felder in Formular-Reihenfolge (Bearbeiten-Seite). Muss zur
 *  Feldliste des Triggers in Migration 319 passen. */
export const AUFTRAG_FELDER: ReadonlyArray<{ key: string; label: string; typ: FeldTyp }> = [
  { key: "job_type", label: "Auftragsart", typ: "auftragsart" },
  { key: "title", label: "Titel", typ: "text" },
  { key: "description", label: "Beschreibung", typ: "lang" },
  { key: "project_lead_id", label: "Verantwortlich", typ: "person" },
  { key: "priority", label: "Priorität", typ: "prioritaet" },
  { key: "location_id", label: "Location", typ: "location" },
  { key: "customer_id", label: "Kunde", typ: "kunde" },
  { key: "external_address", label: "Ort", typ: "text" },
  { key: "room_id", label: "Raum", typ: "raum" },
  { key: "contact_person", label: "Ansprechperson", typ: "text" },
  { key: "contact_phone", label: "Telefon", typ: "text" },
  { key: "contact_email", label: "E-Mail", typ: "text" },
  { key: "start_date", label: "Start", typ: "datum" },
  { key: "end_date", label: "Ende", typ: "datum" },
];

/** Aufgelöste Namen je Verweis-Art (id → Name). */
export type AenderungNamen = {
  kunde: Record<string, string>;
  location: Record<string, string>;
  raum: Record<string, string>;
  person: Record<string, string>;
};

export const LEERE_NAMEN: AenderungNamen = { kunde: {}, location: {}, raum: {}, person: {} };

const LEER = "—";
// Neutral: der Datensatz konnte nicht geladen werden — gelöscht ODER für
// diese Rolle nicht lesbar (z.B. Kunden ohne kunden:view).
const UNBEKANNT = "(nicht verfügbar)";

/** Welche IDs müssen für die Anzeige aufgelöst werden? (inkl. «zurückgenommen von») */
export function idsZumAufloesen(eintraege: AuftragAenderung[]): {
  kunde: string[];
  location: string[];
  raum: string[];
  person: string[];
} {
  const sets = { kunde: new Set<string>(), location: new Set<string>(), raum: new Set<string>(), person: new Set<string>() };
  const typVon = new Map(AUFTRAG_FELDER.map((f) => [f.key, f.typ]));
  for (const e of eintraege) {
    if (e.rueckgaengig_von) sets.person.add(e.rueckgaengig_von);
    for (const [key, w] of Object.entries(e.felder ?? {})) {
      const typ = typVon.get(key);
      if (typ !== "kunde" && typ !== "location" && typ !== "raum" && typ !== "person") continue;
      for (const v of [w?.alt, w?.neu]) {
        if (typeof v === "string" && v) sets[typ].add(v);
      }
    }
  }
  return {
    kunde: [...sets.kunde],
    location: [...sets.location],
    raum: [...sets.raum],
    person: [...sets.person],
  };
}

function datumAnzeigen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Reine Tages-Daten liegen auf Mitternacht Zürich (Formular, toDbDate) —
  // dann ohne Uhrzeit. ("24:00": manche ICU-Stände schreiben Mitternacht mit
  // hour12:false so.) Ebenso UTC-Mitternacht: so speichern die Entwurf-
  // Umwandlung (api/entwuerfe/[id]/convert) und die KI-Umdatierung reine
  // Daten; in Zürich wäre das 01:00/02:00 desselben Tages — kein echter
  // Termin, also nur das (Zürcher = gleiche) Datum zeigen.
  const hm = localTimeHM(d);
  const zuerichMitternacht = hm === "00:00" || hm === "24:00";
  const utcMitternacht =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return zuerichMitternacht || utcMitternacht ? formatDateFull(iso) : formatDateTimeFull(iso);
}

/** Einen Feldwert lesbar machen. */
export function wertAnzeigen(key: string, wert: unknown, namen: AenderungNamen = LEERE_NAMEN): string {
  if (wert === null || wert === undefined) return LEER;
  const typ = AUFTRAG_FELDER.find((f) => f.key === key)?.typ ?? "text";
  const s = typeof wert === "string" ? wert : JSON.stringify(wert);
  if (s.trim() === "") return LEER;
  switch (typ) {
    case "datum":
      return datumAnzeigen(s);
    case "kunde":
    case "location":
    case "raum":
    case "person":
      return namen[typ][s] ?? UNBEKANNT;
    case "auftragsart":
      return s === "location" ? "Location" : s === "extern" ? "Firma / Privat" : s;
    case "prioritaet":
      return s === "dringend" ? "Dringend" : s === "normal" ? "Normal" : s;
    default:
      return s;
  }
}

export type AenderungZeile = {
  key: string;
  label: string;
  alt: string;
  neu: string;
  /** Langer Text (Beschreibung o.ä.) — UI kürzt und klappt auf. */
  lang: boolean;
};

const LANG_AB = 120;

/** Alle Feld-Zeilen eines Eintrags in Formular-Reihenfolge; unbekannte Felder
 *  (falls der Trigger später mehr protokolliert) hinten mit Spaltennamen. */
export function aenderungZeilen(felder: FelderDiff, namen: AenderungNamen = LEERE_NAMEN): AenderungZeile[] {
  const keys = Object.keys(felder ?? {});
  const bekannt = AUFTRAG_FELDER.filter((f) => keys.includes(f.key));
  const rest = keys.filter((k) => !AUFTRAG_FELDER.some((f) => f.key === k)).sort();
  return [...bekannt.map((f) => ({ key: f.key, label: f.label })), ...rest.map((k) => ({ key: k, label: k }))].map(
    ({ key, label }) => {
      const alt = wertAnzeigen(key, felder[key]?.alt, namen);
      const neu = wertAnzeigen(key, felder[key]?.neu, namen);
      const typ = AUFTRAG_FELDER.find((f) => f.key === key)?.typ;
      const lang =
        typ === "lang" || alt.length > LANG_AB || neu.length > LANG_AB || alt.includes("\n") || neu.includes("\n");
      return { key, label, alt, neu, lang };
    },
  );
}

/** Text auf `max` Zeichen kürzen (Zeilenumbrüche → Leerzeichen), mit «…». */
export function kuerzen(text: string, max = 80): string {
  const flach = text.replace(/\s+/g, " ").trim();
  return flach.length > max ? `${flach.slice(0, max - 1).trimEnd()}…` : flach;
}

/** «Titel: alt → neu» — eine Zeile, lange Texte gekürzt. */
export function zeileAlsText(z: AenderungZeile, max = 80): string {
  return `${z.label}: ${kuerzen(z.alt, max)} → ${kuerzen(z.neu, max)}`;
}

/** Text für die Rückfrage: was beim Rückgängigmachen wiederhergestellt wird
 *  (jetziger Wert → wiederhergestellter Wert). */
export function wiederherstellenText(zeilen: AenderungZeile[]): string {
  const liste = zeilen.map((z) => `• ${z.label}: ${kuerzen(z.neu)} → ${kuerzen(z.alt)}`).join("\n");
  return `Diese Felder bekommen wieder ihren früheren Wert:\n${liste}`;
}

/** ID des Eintrags, der jetzt rückgängig gemacht werden kann: die neueste noch
 *  nicht zurückgenommene Änderung (Liste neueste zuerst). Rückgängig-Einträge
 *  selbst sind nicht rücknehmbar. */
export function ruecknehmbareId(eintraegeNeuesteZuerst: AuftragAenderung[]): string | null {
  const e = eintraegeNeuesteZuerst.find((x) => x.art === "aenderung" && !x.rueckgaengig_at);
  return e?.id ?? null;
}
