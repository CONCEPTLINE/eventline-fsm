// Datenformate der lokalen KI — identisch auf Rig und FSM
// (docs/lokale-ki/SPEC.md Abschnitt 3). Die Python-Seite im Dienst
// (rig/eventline-ki/dienst) bildet genau diese Strukturen ab.

import type { KI_ARTEN, KI_DATEI_ARTEN } from "./konstanten";

export type KiArt = (typeof KI_ARTEN)[number];
export type KiDateiArt = (typeof KI_DATEI_ARTEN)[number];
export type KiAuftragStatus = "offen" | "laeuft" | "fertig" | "fehler";

/** Payload aller Datei-Auftraege: das Objekt liegt unter ki-tmp/<uuid> im
 *  Bucket nas-ablage; die Abhol-API haengt eine signierte `url` dazu.
 *  Bewusst `type` statt `interface`, damit der Wert ohne Umweg als
 *  Record<string, unknown> in die jsonb-Spalte darf. */
export type KiDateiPayload = {
  storage_path: string;
  file_name: string;
  mime: string;
  size: number;
};
export type AblageAnalysePayload = KiDateiPayload;
export type BelegAnalysePayload = KiDateiPayload;
export type WarenkorbAnalysePayload = KiDateiPayload;
/** Diktat: die Aufnahme (audio/*, max 10 MB) liegt unter ki-tmp/<uuid>. */
export type DiktatPayload = KiDateiPayload;

/** V8 — woher der Zielordner im Ergebnis stammt: `regel` = verbindliche
 *  Regel des Rigs (INT-Nummer -> Projektordner, Personalakte -> Akte der
 *  Person), `lokal` = Wahl des Rigs (Vorbild/Regel) ohne Claude-Aufruf
 *  (personenbezogen, kein Schluessel, Claude-Fehler/Zeitueberschreitung),
 *  `claude` = Entscheid von Claude anhand der minimierten Einordnung. */
export type OrdnerQuelle = "regel" | "lokal" | "claude";
export type OrdnerSicherheit = "hoch" | "mittel" | "niedrig";

/** V8 — Bezug des Dokuments, wie das Rig ihn erkannt hat. */
export type EinordnungBezugArt = "location" | "projekt" | "kunde" | "partner" | "firma" | "person";

/** V8 — minimierte Einordnung des Dokuments (vom Rig erzeugt, im FSM nochmals
 *  minimiert). Das Einzige, was zu Claude geht — nie der Dokumentinhalt. Wird
 *  NICHT persistiert (weder in ki_auftraege noch in Logs). */
export interface AblageEinordnung {
  /** 1–2 Saetze: was ist das Dokument (ohne Betraege, Nummern, Kontakte). */
  was: string;
  typ: string;
  betreff: string;
  partei: string | null;
  bezug: { art: EinordnungBezugArt | null; name: string | null };
  /** Dokumentjahr YYYY oder null. */
  jahr: string | null;
  /** true = Personalakte/Lohn/Arzt o. ae. -> kein Claude-Aufruf. */
  personenbezogen: boolean;
  sprache: string | null;
  seiten: number | null;
}

/** V8 — Ordner-Kandidat des Rigs: aus aehnlichen Vorbild-Dokumenten oder
 *  einer Regel, mit Gewicht (Staerke des Hinweises). */
export interface AblageKandidat {
  pfad: string;
  quelle: "vorbild" | "regel";
  gewicht: number;
}

/** 3.1 — Ergebnis von `ablage_analyse`. `typ` ist ein DOK_TYPEN-Key,
 *  `ordner` exakt ein aktiver Ordnerpfad oder null, `person` ein voller
 *  Name aus der Mitarbeiterliste oder null, Datumsfelder YYYY-MM-DD. */
export interface AblageAnalyseErgebnis {
  beschrieb: string;
  typ: string;
  betreff: string;
  person: string | null;
  partei: string | null;
  nummer: string | null;
  dok_datum: string | null;
  frist: string | null;
  ordner: string | null;
  /** Bis zu zwei naechstbeste Zielordner (volle aktive Pfade, ohne `ordner`,
   *  ohne Doppel, Reihenfolge des Modells) — auch wenn `ordner` null ist,
   *  dann sind es die Vorschlaege. Optional: aeltere Ergebnisse haben es nicht. */
  ordner_alternativen?: string[];
  /** V8 — Herkunft des Zielordners; fehlt bei Ergebnissen eines Rigs ohne
   *  V8-Felder (einordnung/kandidaten/regel_ordner) — dann kein Chip. */
  ordner_quelle?: OrdnerQuelle;
  /** V8 — nur bei `ordner_quelle = "claude"`; ohne Treffer (ordner null) immer
   *  `niedrig`, die Alternativen beginnen dann mit der Wahl des lokalen Modells. */
  ordner_sicherheit?: OrdnerSicherheit;
  ordner_begruendung?: string;
  neuer_ordner: string | null;
  zusammenfassung: string;
  sha256: string;
  seiten: number | null;
  ocr: boolean;
  modell: string;
  dauer_ms: number;
}

/** 3.2 — Ergebnis von `beleg_analyse` (Form wie bisher im Beleg-Ticket). */
export interface BelegAnalyseErgebnis {
  ok: boolean;
  issues: string[];
  extracted: {
    betrag_chf: number | null;
    kaufdatum: string | null;
    lieferant: string | null;
  };
}

/** 3.3 — Ergebnis von `warenkorb_analyse` (Form wie bisher im Material-Ticket). */
export interface WarenkorbAnalyseErgebnis {
  ok: boolean;
  issues: string[];
  extracted: {
    items: { artikel: string; menge: number | null; betrag_chf: number | null }[];
  };
}

/** Ergebnis von `diktat` (Whisper, Sprache de): erkannter Text, getrimmt,
 *  hoechstens 20 000 Zeichen — leer heisst «nichts erkannt». */
export interface DiktatErgebnis {
  text: string;
  dauer_ms: number;
}

/** MASTERPLAN §3.3 — Auftrag `nas_suche` (ohne Datei). */
export type NasSuchePayload = { q: string; limit: number };

/** Ein Treffer der Inhaltssuche, wie ihn die Abhol-API annimmt: nur Pfad,
 *  Seite und Score — nie ein Textfeld. */
export interface NasSucheTreffer {
  pfad: string;
  seite: number | null;
  /** 0..1 */
  score: number;
}

/** Bereinigtes Ergebnis von `nas_suche`. */
export interface NasSucheErgebnis {
  treffer: NasSucheTreffer[];
  index: { dateien: number | null; gelesen_anteil: number | null } | null;
  dauer_ms: number;
  /** «kombiniert» (Vektor + Volltext) oder «volltext» (Einbettungsmodell
   *  laedt noch). Fehlt bei aelteren Rig-Staenden. */
  modus?: NasSucheModus;
}

export type NasSucheModus = "kombiniert" | "volltext";

/** Treffer, wie ihn der Browser bekommt: nur Pfade, die im Datei-Index
 *  stehen (nie 99_System/), ergaenzt um Name, Ordner und Aenderungsdatum. */
export interface NasSucheTrefferAnzeige {
  pfad: string;
  name: string;
  ordner: string;
  seite: number | null;
  score: number;
  geaendert: string | null;
}

/** MASTERPLAN §3.4 — Auftrag `archiv_frage` (ohne Datei). */
export type ArchivFragePayload = { frage: string };

export interface ArchivQuelle {
  pfad: string;
  seite: number | null;
}

/** Bereinigtes Ergebnis von `archiv_frage`: Antworttext und Quellenpfade. */
export interface ArchivFrageErgebnis {
  antwort: string;
  quellen: ArchivQuelle[];
  modell: string;
  dauer_ms: number;
}

/** Quelle, wie sie der Browser bekommt (gegen den Index gefiltert). */
export interface ArchivQuelleAnzeige {
  pfad: string;
  name: string;
  ordner: string;
  seite: number | null;
}

/** Bereitschaft der lokalen KI fuer eine Art (MASTERPLAN §3.1). */
export type KiBereitschaft = "bereit" | "offline" | "nicht_bereit";

/** MASTERPLAN §3.6 — Vorschlaege der Nachtarbeit. */
export type NasVorschlagArt = "zz" | "nachpruefung";
export type NasVorschlagQuelle = "regel" | "vorbild" | "modell";
export type NasVorschlagStatus = "offen" | "angenommen" | "korrigiert" | "abgelehnt" | "erledigt" | "veraltet";

/** MASTERPLAN §3.6/§3.7 — Fristen: die KI liefert Bedingungen, das FSM
 *  rechnet das Datum. */
export type FristArt = "kuendigung" | "ablauf" | "vertragsende" | "verlaengerung" | "zahlung" | "sonstige";
export type FristStatus = "vorschlag" | "aktiv" | "verworfen" | "erledigt";
export type FristQuelle = "ablage" | "ki" | "manuell";
export interface FristBedingungen {
  beginn: string | null;
  ende: string | null;
  faellig: string | null;
  laufzeit_monate: number | null;
  verlaengerung_monate: number | null;
  kuendigungsfrist: { anzahl: number; einheit: "tage" | "wochen" | "monate" } | null;
}

/** MASTERPLAN §3.5 — Antwort von GET /api/ki/kontext (Nachtarbeit). */
export interface NachtKontext {
  erzeugt_am: string;
  heute: string;
  ordner: string[];
  dok_typen: { key: string; label: string; person: boolean }[];
  mitarbeiter: string[];
  namen_alle: string[];
  vorschlaege_bekannt: { art: NasVorschlagArt; pfad: string; status: NasVorschlagStatus }[];
  fristen_bekannt: { pfad: string; art: FristArt; datum: string; status: FristStatus }[];
}

/** Kontext, den GET /api/ki/sync jedem `ablage_analyse`-Auftrag mitgibt,
 *  damit das Modell nur aus bekannten Werten waehlt (nichts erfinden). */
export interface AblageAnalyseKontext {
  /** Aktive Zielordner, exakte Schreibweise. */
  ordner: string[];
  /** DOK_TYPEN — `person` = der Typ kennt eine betroffene Person. */
  dok_typen: { key: string; label: string; person: boolean }[];
  /** Volle Namen der aktiven internen Mitarbeiter — die Auswahl fuer `person`. */
  mitarbeiter: string[];
  /** V8 — volle Namen ALLER Profile (auch inaktive, auch Portal-Rollen), nur
   *  fuer die Namens-Minimierung Richtung Claude und das Erkennen von
   *  Personalakten im Ordnerbaum; nie fuer die Personen-Auswahl. */
  namen_alle: string[];
  /** Heutiges Datum YYYY-MM-DD (Europe/Zurich). */
  heute: string;
}

/** Zeile in `ki_auftraege` (Migration 288). */
export interface KiAuftragRow {
  id: string;
  art: KiArt;
  status: KiAuftragStatus;
  payload: Record<string, unknown>;
  ergebnis: unknown;
  fehler: string | null;
  versuche: number;
  /** Migration 302: Abhol-Reihenfolge (KI_PRIORITAET). */
  prioritaet: number;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** Ein Auftrag, wie ihn GET /api/ki/sync dem Rig liefert. */
export interface KiSyncAuftrag {
  id: string;
  art: KiArt;
  versuche: number;
  /** Original-Payload plus `url` (signiert, 3600 s) bei Datei-Auftraegen. */
  payload: Record<string, unknown> & { url?: string };
  kontext?: AblageAnalyseKontext;
}

/** Rueckmeldung des Rigs per POST /api/ki/sync. */
export interface KiSyncErgebnis {
  id: string;
  ok: boolean;
  ergebnis?: unknown;
  fehler?: string;
}

/** Zeile in `ki_status` (Herzschlag, Migration 288). */
export interface KiStatusRow {
  id: number;
  online_seit: string | null;
  letzter_poll: string | null;
  version: string | null;
  modell: string | null;
  gpu: { name: string; frei_mb: number | null } | null;
  warteschlange: number;
  letzter_fehler: string | null;
  /** Migration 302: bis wann das Rig schneller pollen soll (POST /api/ki/wach). */
  eilig_bis: string | null;
  /** Migration 302: vom Rig gemeldete Arten; null = altes Rig (nur Basis-Arten). */
  arten: string[] | null;
}

/** Die Direkt-API (Browser -> Rig) gibt es nur noch fuer Archiv-Fragen
 *  (Phase 3) — Diktate laufen ueber die Warteschlange (/api/ki/diktat). */
export type KiTicketScope = "archiv";

/** Inhalt eines Tickets fuer die Direkt-API (SPEC 2.2). */
export interface KiTicketClaims {
  sub: string;
  scope: KiTicketScope;
  /** Ablauf als Unix-Sekunden. */
  exp: number;
}

/** Ausgang von `warteAufErgebnis` — `timeout` heisst: Auftrag laeuft
 *  weiter, nur die Wartezeit der FSM-Seite ist um. */
export type KiWarteErgebnis<T> =
  | { status: "fertig"; ergebnis: T }
  | { status: "fehler"; fehler: string }
  | { status: "timeout" };
