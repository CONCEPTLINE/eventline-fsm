// Technik-Planung: gemeinsame Typen + Status-Logik fuer Firmen-Tab,
// Lieferantenportal und API-Routen. (Migration 263)
//
// Ampel-Prinzip (Spec-Statussystem, uebersetzt):
//   gruen = Position bestaetigt, keine offenen Punkte
//   gelb  = offene Empfehlung
//   rot   = offenes Problem
//   grau  = geplant, noch nichts vom Lieferanten
// Prioritaet bei mehreren offenen Punkten: rot > gelb.
// Rueckmeldungen des Lieferanten: Passt (bestaetigen) · Empfehlung · Problem ·
// Kommentar. Eine eigene Art «Frage» gibt es nicht (Leo 2026-10-15) —
// Fragen laufen ueber Kommentare.

export type TechnikPositionStatus = "geplant" | "bestaetigt";
export type TechnikQuelle = "kunde" | "eventfirma" | "lieferant";
export type ReviewArt = "empfehlung" | "problem";
export const REVIEW_ARTEN: readonly ReviewArt[] = ["empfehlung", "problem"];
export type ReviewStatus = "offen" | "uebernommen" | "abgelehnt" | "erledigt";

/** Obergrenze fuer Freitexte (Kommentare, Begruendungen, Wuensche) —
 *  serverseitig in Firmen- und Portal-Routen geprueft. */
export const TECHNIK_TEXT_MAX = 4000;
/** Obergrenze fuer Bezeichnungen/Kategorien von Positionen. */
export const TECHNIK_BEZEICHNUNG_MAX = 200;

export interface TechnikAnforderung {
  id: string;
  text: string;
  sort: number;
}

export interface TechnikPosition {
  id: string;
  artikel_id: string | null;
  kategorie: string;
  bezeichnung: string;
  details: string | null;
  menge: number;
  status: TechnikPositionStatus;
  quelle: TechnikQuelle;
  bestaetigt_at: string | null;
  created_at: string;
}

export type ReviewVorschlag =
  | { typ: "menge"; menge: number }
  | { typ: "neue_position"; bezeichnung: string; menge: number; kategorie?: string; details?: string; artikel_id?: string }
  | { typ: "ersatz"; bezeichnung: string; menge?: number; details?: string; artikel_id?: string };

export interface TechnikReview {
  id: string;
  position_id: string | null;
  art: ReviewArt;
  text: string;
  vorschlag: ReviewVorschlag | null;
  status: ReviewStatus;
  created_at: string;
  entschieden_at: string | null;
}

export interface TechnikKommentar {
  id: string;
  position_id: string | null;
  review_id: string | null;
  author_name: string | null;
  /** true wenn der Kommentar vom Lieferanten stammt (Anzeige-Badge). */
  vom_lieferanten: boolean;
  body: string;
  created_at: string;
}

export interface TechnikAktivitaet {
  id: string;
  actor_name: string | null;
  aktion: string;
  beschreibung: string;
  created_at: string;
}

export interface LieferantRegel {
  id: string;
  art: "paket" | "hinweis";
  trigger_text: string;
  hinweis: string | null;
  paket: { bezeichnung: string; menge: number; kategorie?: string }[] | null;
  is_active: boolean;
}

export type Ampel = "gruen" | "gelb" | "rot" | "grau";

export function positionAmpel(pos: TechnikPosition, reviews: TechnikReview[]): Ampel {
  const offen = reviews.filter((r) => r.position_id === pos.id && r.status === "offen");
  if (offen.some((r) => r.art === "problem")) return "rot";
  if (offen.some((r) => r.art === "empfehlung")) return "gelb";
  return pos.status === "bestaetigt" ? "gruen" : "grau";
}

export const AMPEL_DOT: Record<Ampel, string> = {
  gruen: "bg-green-500",
  gelb: "bg-amber-400",
  rot: "bg-red-500",
  grau: "bg-gray-300 dark:bg-gray-600",
};

export const AMPEL_LABEL: Record<Ampel, string> = {
  gruen: "Bestätigt",
  gelb: "Empfehlung offen",
  rot: "Problem offen",
  grau: "Geplant",
};

export const REVIEW_ART_LABEL: Record<ReviewArt, string> = {
  empfehlung: "Empfehlung",
  problem: "Problem",
};

/** Herkunft einer Position (Etikett). «kunde» = aus dem Eingang erkannt
 *  (Mail, Notiz, Datei) — das Etikett nennt die Herkunft, nicht den Kunden. */
export const QUELLE_LABEL: Record<TechnikQuelle, string> = {
  kunde: "Eingang",
  eventfirma: "EVENTLINE",
  lieferant: "Lieferant",
};

/** Bezug fuer «seit letzter Anfrage geaendert»: der Stand, den der Lieferant
 *  zuletzt gesehen hat — ab Runde 2 die vorherige Anfrage, sonst die erste. */
export function aenderungsBasis(z: { angefragtAt: string | null; vorigeAngefragtAt: string | null; runden: number }): string | null {
  return z.runden >= 2 && z.vorigeAngefragtAt ? z.vorigeAngefragtAt : z.angefragtAt;
}

/** «Nie gesehen = nie entfernt»: Eine geloeschte Position gilt fuer den
 *  Lieferanten nur als «entfernt», wenn er sie gesehen hat — sie bestand
 *  beim Bezug (`basis`) oder bei der aktuellen Anfrage (`aktuelleAnfrage`,
 *  danach geloescht). Zwischen zwei Runden angelegt UND wieder geloescht =
 *  nie gesehen. Grundlage ist meta.position_angelegt_at des Aktivitaets-
 *  Eintrags (position_geloescht / ki_entfernt); fehlt der Wert, zaehlt die
 *  Entfernung wie bisher. */
export function entfernungGesehen(
  eintrag: { created_at: string; meta?: unknown },
  basis: string,
  aktuelleAnfrage?: string | null,
): boolean {
  const roh = eintrag.meta && typeof eintrag.meta === "object"
    ? (eintrag.meta as { position_angelegt_at?: unknown }).position_angelegt_at
    : undefined;
  const angelegt = typeof roh === "string" ? Date.parse(roh) : NaN;
  if (Number.isNaN(angelegt)) return true;
  if (angelegt <= Date.parse(basis)) return true;
  if (aktuelleAnfrage) {
    const anfrage = Date.parse(aktuelleAnfrage);
    if (angelegt <= anfrage && Date.parse(eintrag.created_at) > anfrage) return true;
  }
  return false;
}

export type PositionMarker = "neu" | "geaendert";

/** Markierung einer Position gegenueber dem Bezug: neu angelegt oder
 *  inhaltlich geaendert (Menge/Bezeichnung/Details) — nur solange der
 *  Lieferant sie seither nicht bestaetigt hat. */
export function positionMarker(
  p: { created_at: string; inhalt_geaendert_at?: string | null; status: TechnikPositionStatus },
  basis: string | null,
): PositionMarker | null {
  if (!basis || p.status === "bestaetigt") return null;
  const b = Date.parse(basis);
  if (Date.parse(p.created_at) > b) return "neu";
  if (p.inhalt_geaendert_at && Date.parse(p.inhalt_geaendert_at) > b) return "geaendert";
  return null;
}

/** Stand einer Anfrage aus Sicht des Lieferanten (Portal-Liste). */
export type AnfrageStatus = "neu" | "beantwortet" | "geaendert" | "storniert" | "abgeschlossen";

export const ANFRAGE_STATUS_LABEL: Record<AnfrageStatus, string> = {
  neu: "Neu",
  beantwortet: "Beantwortet",
  geaendert: "Geändert",
  storniert: "Storniert",
  abgeschlossen: "Abgeschlossen",
};

/** Ganzzahlige Stueckzahl >= 1 (Spalte menge ist integer) — null wenn ungueltig. */
export function ganzeMenge(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : null;
}

/** Stand fuer die Kopf-Chips (Firmen-Tab UND Portal — EINE Berechnung). */
export interface TechnikStand {
  positionen: number;
  bestaetigt: number;
  offeneEmpfehlungen: number;
  offeneProbleme: number;
}

export function technikStand(positionen: Pick<TechnikPosition, "status">[], reviews: Pick<TechnikReview, "art" | "status">[]): TechnikStand {
  const offen = reviews.filter((r) => r.status === "offen");
  return {
    positionen: positionen.length,
    bestaetigt: positionen.filter((p) => p.status === "bestaetigt").length,
    offeneEmpfehlungen: offen.filter((r) => r.art === "empfehlung").length,
    offeneProbleme: offen.filter((r) => r.art === "problem").length,
  };
}

/** Regeln gegen eine Bezeichnung/Kategorie matchen (case-insensitiv, contains). */
export function passendeRegeln(regeln: LieferantRegel[], bezeichnung: string, kategorie?: string): LieferantRegel[] {
  const text = `${bezeichnung} ${kategorie ?? ""}`.toLowerCase();
  return regeln.filter((r) => r.is_active && r.trigger_text.trim() && text.includes(r.trigger_text.trim().toLowerCase()));
}
