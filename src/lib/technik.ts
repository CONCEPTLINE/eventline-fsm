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
/** Obergrenze fuer den Kurztitel einer Positionsgruppe («Rahmen»). */
export const TECHNIK_TITEL_MAX = 80;
/** Sammelgruppe fuer Einzelpositionen ohne eigene Gruppe (z.B. eine vom
 *  Lieferanten empfohlene und uebernommene Position). */
export const WEITERE_POSITIONEN = "Weitere Positionen";

/** Positionsgruppe (Tabelle job_anforderungen, Migration 352): ein Wunsch
 *  des Kunden in Klartext, nummeriert «Pos 01 – Rahmen: 3 m hoch …».
 *  Einzelpositionen (echtes Material) haengen ueber gruppe_id daran —
 *  ohne Einzelpositionen waehlt der Techniklieferant die Loesung. */
export interface TechnikGruppe {
  id: string;
  /** «Pos 01» — je Auftrag fortlaufend (Trigger, Migration 352). */
  nummer: number;
  /** Kurztitel («Rahmen»). */
  titel: string;
  /** Klartext-Beschreibung (darf leer sein). */
  text: string;
  created_at: string;
  inhalt_geaendert_at?: string | null;
}

/** «Pos 01» */
export function gruppeNummer(nummer: number): string {
  return `Pos ${String(nummer).padStart(2, "0")}`;
}

/** «Pos 01 – Rahmen» (Mails, Aktivitaet, Auswahl-Listen). */
export function gruppeLabel(g: Pick<TechnikGruppe, "nummer" | "titel">): string {
  return `${gruppeNummer(g.nummer)} – ${g.titel}`;
}

/** Beschreibung oder null, wenn leer. */
export function gruppeBeschreibung(g: Pick<TechnikGruppe, "text">): string | null {
  return g.text.trim() || null;
}

export interface TechnikPosition {
  id: string;
  /** Positionsgruppe (job_anforderungen). */
  gruppe_id: string;
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
  | { typ: "neue_position"; bezeichnung: string; menge: number; kategorie?: string; details?: string; artikel_id?: string; gruppe_id?: string }
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
  // position_angelegt_at (Einzelposition) bzw. angelegt_at (Positionsgruppe).
  const meta = eintrag.meta && typeof eintrag.meta === "object"
    ? (eintrag.meta as { position_angelegt_at?: unknown; angelegt_at?: unknown })
    : undefined;
  const roh = meta?.position_angelegt_at ?? meta?.angelegt_at;
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

/** Markierung einer Positionsgruppe gegenueber dem Bezug: neu angelegt oder
 *  Titel/Beschreibung geaendert. */
export function gruppeMarker(
  g: { created_at: string; inhalt_geaendert_at?: string | null },
  basis: string | null,
): PositionMarker | null {
  if (!basis) return null;
  const b = Date.parse(basis);
  if (Date.parse(g.created_at) > b) return "neu";
  if (g.inhalt_geaendert_at && Date.parse(g.inhalt_geaendert_at) > b) return "geaendert";
  return null;
}

/** Aktivitaets-Arten «etwas wurde entfernt» (Grundlage fuer «seit der
 *  letzten Anfrage entfernt» in Mail, Portal-Liste und Portal-Detail). */
export const ENTFERNT_AKTIONEN = ["position_geloescht", "ki_entfernt", "gruppe_geloescht", "ki_gruppe_entfernt"];

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

/** Je Einzelposition: stammt der juengste Beitrag ihres Kommentar-Fadens
 *  (ohne Faeden an Rueckmeldungen) vom Lieferanten? Fehlt der Faden, kein Eintrag. */
function letzterPositionsBeitrag(
  kommentare: Pick<TechnikKommentar, "position_id" | "review_id" | "vom_lieferanten" | "created_at">[],
): Map<string, boolean> {
  const letzte = new Map<string, { at: number; vomLieferanten: boolean }>();
  for (const k of kommentare) {
    if (!k.position_id || k.review_id) continue;
    const at = Date.parse(k.created_at);
    const bisher = letzte.get(k.position_id);
    if (!bisher || at >= bisher.at) letzte.set(k.position_id, { at, vomLieferanten: k.vom_lieferanten });
  }
  return new Map([...letzte].map(([id, v]) => [id, v.vomLieferanten]));
}

/** Offene Punkte einer Positionsgruppe aus Sicht von EVENTLINE — dieselbe
 *  Definition wie die Zahl am Tab «Technik» (technik_offene_punkte,
 *  Migration 336), nur auf die Einzelpositionen der Gruppe beschraenkt:
 *  offene Empfehlungen + offene Probleme je 1 (inkl. ihrer Faeden) und
 *  Kommentar-Faeden an Einzelpositionen, deren letzter Beitrag vom
 *  Lieferanten stammt. Allgemeine Punkte (ohne Einzelposition) gehoeren zu
 *  keiner Gruppe — Summe aller Gruppen + allgemeine = Zahl am Tab. */
export interface GruppeOffen {
  empfehlungen: number;
  probleme: number;
  unbeantwortet: number;
  total: number;
}

export function gruppeOffenePunkte(
  positionIds: string[],
  reviews: Pick<TechnikReview, "position_id" | "art" | "status">[],
  kommentare: Pick<TechnikKommentar, "position_id" | "review_id" | "vom_lieferanten" | "created_at">[],
): GruppeOffen {
  const ids = new Set(positionIds);
  const offen = reviews.filter((r) => r.status === "offen" && r.position_id && ids.has(r.position_id));
  const empfehlungen = offen.filter((r) => r.art === "empfehlung").length;
  const probleme = offen.filter((r) => r.art === "problem").length;
  let unbeantwortet = 0;
  for (const [id, vomLieferanten] of letzterPositionsBeitrag(kommentare)) {
    if (vomLieferanten && ids.has(id)) unbeantwortet++;
  }
  return { empfehlungen, probleme, unbeantwortet, total: empfehlungen + probleme + unbeantwortet };
}

/** Was in einer Positionsgruppe auf den LIEFERANTEN wartet (Portal): je
 *  Einzelposition einmal gezaehlt, wenn sie noch nicht geprueft ist (nicht
 *  bestaetigt und keine offene Rueckmeldung von ihm — Ampel grau) oder wenn
 *  der letzte Beitrag ihres Kommentar-Fadens von EVENTLINE stammt. */
export interface GruppeWartet {
  ungeprueft: number;
  unbeantwortet: number;
  total: number;
}

export function gruppeWartetAufLieferant(
  positionen: Pick<TechnikPosition, "id" | "status">[],
  reviews: Pick<TechnikReview, "position_id" | "status">[],
  kommentare: Pick<TechnikKommentar, "position_id" | "review_id" | "vom_lieferanten" | "created_at">[],
): GruppeWartet {
  const mitOffenerRueckmeldung = new Set(reviews.filter((r) => r.status === "offen" && r.position_id).map((r) => r.position_id));
  const letzter = letzterPositionsBeitrag(kommentare);
  let ungeprueft = 0;
  let unbeantwortet = 0;
  let total = 0;
  for (const p of positionen) {
    const offen = p.status !== "bestaetigt" && !mitOffenerRueckmeldung.has(p.id);
    const antwortFehlt = letzter.get(p.id) === false;
    if (offen) ungeprueft++;
    if (antwortFehlt) unbeantwortet++;
    if (offen || antwortFehlt) total++;
  }
  return { ungeprueft, unbeantwortet, total };
}

/** Regeln gegen eine Bezeichnung/Kategorie matchen (case-insensitiv, contains). */
export function passendeRegeln(regeln: LieferantRegel[], bezeichnung: string, kategorie?: string): LieferantRegel[] {
  const text = `${bezeichnung} ${kategorie ?? ""}`.toLowerCase();
  return regeln.filter((r) => r.is_active && r.trigger_text.trim() && text.includes(r.trigger_text.trim().toLowerCase()));
}
