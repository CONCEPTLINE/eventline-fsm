// Technik-Planung: gemeinsame Typen + Status-Logik fuer Firmen-Tab,
// Lieferantenportal und API-Routen. (Migration 263)
//
// Ampel-Prinzip (Spec-Statussystem, uebersetzt):
//   gruen = Position bestaetigt, keine offenen Punkte
//   gelb  = offene Empfehlung
//   rot   = offenes Problem
//   blau  = offene Frage
//   grau  = geplant, noch nichts vom Lieferanten
// Prioritaet bei mehreren offenen Punkten: rot > blau > gelb.

export type TechnikPositionStatus = "geplant" | "bestaetigt";
export type TechnikQuelle = "kunde" | "eventfirma" | "lieferant";
export type ReviewArt = "empfehlung" | "problem" | "frage";
export type ReviewStatus = "offen" | "uebernommen" | "abgelehnt" | "erledigt";

export interface TechnikAnforderung {
  id: string;
  text: string;
  sort: number;
}

export interface TechnikPosition {
  id: string;
  anforderung_id: string | null;
  artikel_id: string | null;
  kategorie: string;
  bezeichnung: string;
  details: string | null;
  menge: number;
  status: TechnikPositionStatus;
  quelle: TechnikQuelle;
  bestaetigt_at: string | null;
  sort: number;
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

export type Ampel = "gruen" | "gelb" | "rot" | "blau" | "grau";

export function positionAmpel(pos: TechnikPosition, reviews: TechnikReview[]): Ampel {
  const offen = reviews.filter((r) => r.position_id === pos.id && r.status === "offen");
  if (offen.some((r) => r.art === "problem")) return "rot";
  if (offen.some((r) => r.art === "frage")) return "blau";
  if (offen.some((r) => r.art === "empfehlung")) return "gelb";
  return pos.status === "bestaetigt" ? "gruen" : "grau";
}

export const AMPEL_DOT: Record<Ampel, string> = {
  gruen: "bg-green-500",
  gelb: "bg-amber-400",
  rot: "bg-red-500",
  blau: "bg-blue-500",
  grau: "bg-gray-300 dark:bg-gray-600",
};

export const REVIEW_ART_LABEL: Record<ReviewArt, string> = {
  empfehlung: "Empfehlung",
  problem: "Problem",
  frage: "Frage",
};

export const QUELLE_LABEL: Record<TechnikQuelle, string> = {
  kunde: "Kundenwunsch",
  eventfirma: "EVENTLINE",
  lieferant: "Lieferant",
};

/** Zusammenfassung fuer Kopfzeilen: "5 von 8 bestätigt · 2 Empfehlungen · 1 Frage". */
export function technikZusammenfassung(positionen: TechnikPosition[], reviews: TechnikReview[]): string {
  const teile: string[] = [];
  if (positionen.length > 0) {
    const best = positionen.filter((p) => p.status === "bestaetigt").length;
    teile.push(`${best} von ${positionen.length} bestätigt`);
  }
  const offen = reviews.filter((r) => r.status === "offen");
  const emp = offen.filter((r) => r.art === "empfehlung").length;
  const prob = offen.filter((r) => r.art === "problem").length;
  const fragen = offen.filter((r) => r.art === "frage").length;
  if (emp) teile.push(`${emp} ${emp === 1 ? "Empfehlung" : "Empfehlungen"}`);
  if (prob) teile.push(`${prob} ${prob === 1 ? "Problem" : "Probleme"}`);
  if (fragen) teile.push(`${fragen} ${fragen === 1 ? "Frage" : "Fragen"}`);
  return teile.join(" · ");
}

/** Regeln gegen eine Bezeichnung/Kategorie matchen (case-insensitiv, contains). */
export function passendeRegeln(regeln: LieferantRegel[], bezeichnung: string, kategorie?: string): LieferantRegel[] {
  const text = `${bezeichnung} ${kategorie ?? ""}`.toLowerCase();
  return regeln.filter((r) => r.is_active && r.trigger_text.trim() && text.includes(r.trigger_text.trim().toLowerCase()));
}
