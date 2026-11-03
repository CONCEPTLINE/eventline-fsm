// «Fragen an dich» — Katalog der Pflicht-Fragen an Mitarbeitende (rein, ohne Datenbank).
//
// Jede Frage hat einen festen Schlüssel, eine Textfassung (`version`) und feste
// Optionen. Antworten liegen als Verlauf in `mitarbeiter_antworten` (Migration
// 376, nur anhängen); es gilt je Person und Frage der neueste Eintrag.
// Offen ist eine Frage, solange es zur AKTUELLEN Fassung keine gültige Antwort
// gibt — eine neue Fassung (Text inhaltlich geändert) fragt also alle neu.
//
// Neue Frage: hier eintragen (Schlüssel klein, a–z/0–9/_), `version` "1.0".
// Text inhaltlich ändern = `version` hochzählen. Schlüssel und Optionswerte nie
// umbenennen (Trust flow liest sie über POST /api/flow/antworten).
//
// Unit-Tests: katalog.test.ts.

/** Für wen eine Frage gilt (Auflösung serverseitig: src/lib/fragen/server.ts). */
export type FrageGilt =
  /** Aktive interne Mitarbeitende (kein Partner-/Lieferanten-Zugang) mit laufender Lohn-Anstellung. */
  "mitarbeitende_mit_anstellung";

export interface FrageOption {
  /** Gespeicherter Wert (nie umbenennen). */
  wert: string;
  label: string;
}

export interface Frage {
  schluessel: string;
  /** Fassung des Texts — inhaltliche Änderung = neue Fassung = alle neu fragen. */
  version: string;
  titel: string;
  /** Erklärung (je Eintrag ein Absatz). */
  text: string[];
  /** Folgen der Optionen, kurz. */
  punkte: string[];
  /** Hervorgehobener Hinweis (gelb). */
  warnung?: string;
  optionen: FrageOption[];
  /** Kleiner Hinweis unter den Optionen. */
  hinweis: string;
  gilt: FrageGilt;
}

export const FRAGEN: readonly Frage[] = [
  {
    schluessel: "ahv_geringfuegig",
    version: "1.0",
    titel: "AHV-Beiträge bei kleinem Lohn",
    text: [
      "Verdienst du bei EVENTLINE im Jahr höchstens CHF 2'500, musst du keine AHV-Beiträge zahlen. Du kannst sie trotzdem zahlen.",
      "Das gilt nur für deinen Lohn bei EVENTLINE.",
    ],
    punkte: [
      "Ohne Abzug: mehr Lohn auf die Hand.",
      "Mit Abzug: das Jahr zählt für deine AHV-Rente — fehlende Beitragsjahre kürzen sie später.",
    ],
    warnung:
      "Kommst du im Jahr doch über CHF 2'500, sind die Beiträge auf den ganzen Jahreslohn geschuldet und werden mit einem späteren Lohn abgezogen.",
    optionen: [
      { wert: "abziehen", label: "Beiträge abziehen" },
      { wert: "keine", label: "Keine Beiträge" },
    ],
    hinweis: "Jederzeit änderbar unter Mein Konto.",
    gilt: "mitarbeitende_mit_anstellung",
  },
];

/** Gleiches Format wie die Datenbank-Regel (Migration 376). */
const SCHLUESSEL = /^[a-z][a-z0-9_]{0,63}$/;
export const istFrageSchluessel = (x: unknown): x is string => typeof x === "string" && SCHLUESSEL.test(x);

export function frageNach(schluessel: string, katalog: readonly Frage[] = FRAGEN): Frage | null {
  return katalog.find((f) => f.schluessel === schluessel) ?? null;
}

export function istGueltigeAntwort(frage: Frage, wert: unknown): wert is string {
  return typeof wert === "string" && frage.optionen.some((o) => o.wert === wert);
}

/** Eine Zeile aus mitarbeiter_antworten (nur die Felder, die die Logik braucht). */
export interface AntwortZeile {
  profile_id: string;
  frage_schluessel: string;
  antwort: string;
  text_version: string;
  beantwortet_at: string;
}

/**
 * Je Person und Frage die neueste GÜLTIGE Antwort (Wert ist eine Option der
 * Frage im Katalog; unbekannte Fragen fallen weg). Schlüssel `${profil}|${frage}`.
 */
export function neuesteAntworten<T extends AntwortZeile>(zeilen: T[], katalog: readonly Frage[] = FRAGEN): Map<string, T> {
  const out = new Map<string, T>();
  for (const z of zeilen) {
    const f = frageNach(z.frage_schluessel, katalog);
    if (!f || !istGueltigeAntwort(f, z.antwort)) continue;
    const k = `${z.profile_id.toLowerCase()}|${z.frage_schluessel}`;
    const bisher = out.get(k);
    if (!bisher || new Date(z.beantwortet_at).getTime() > new Date(bisher.beantwortet_at).getTime()) out.set(k, z);
  }
  return out;
}

/** Offene Fragen einer Person: keine gültige Antwort zur aktuellen Fassung. Reihenfolge des Katalogs. */
export function offeneFragen(fragen: readonly Frage[], eigene: AntwortZeile[]): Frage[] {
  const neueste = neuesteAntworten(eigene, fragen);
  return fragen.filter((f) => {
    const a = [...neueste.values()].find((z) => z.frage_schluessel === f.schluessel);
    return !a || a.text_version !== f.version;
  });
}
