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

/** Kontext, den GET /api/ki/sync jedem `ablage_analyse`-Auftrag mitgibt,
 *  damit das Modell nur aus bekannten Werten waehlt (nichts erfinden). */
export interface AblageAnalyseKontext {
  /** Aktive Zielordner, exakte Schreibweise. */
  ordner: string[];
  /** DOK_TYPEN — `person` = der Typ kennt eine betroffene Person. */
  dok_typen: { key: string; label: string; person: boolean }[];
  /** Volle Namen der aktiven internen Mitarbeiter. */
  mitarbeiter: string[];
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
