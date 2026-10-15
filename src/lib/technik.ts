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

export const QUELLE_LABEL: Record<TechnikQuelle, string> = {
  kunde: "Kundenwunsch",
  eventfirma: "EVENTLINE",
  lieferant: "Lieferant",
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
