// Datenformate der lokalen KI fuer das ERP (Diktat, Beleg, Warenkorb) — identisch auf Rig und ERP
// (Trust-one-Repo docs/lokale-ki/SPEC.md Abschnitt 3; der Dienst rig/eventline-ki/dienst bildet genau diese
// Strukturen ab).

import type { KI_ARTEN } from "./konstanten";

export type KiArt = (typeof KI_ARTEN)[number];

/** Payload aller Datei-Auftraege: das Objekt liegt unter ki-tmp/<uuid> im
 *  Uebergabe-Bucket; die Abhol-API haengt eine signierte `url` dazu.
 *  Bewusst `type` statt `interface`, damit der Wert ohne Umweg als
 *  Record<string, unknown> in die jsonb-Spalte darf. */
type KiDateiPayload = {
  storage_path: string;
  file_name: string;
  mime: string;
  size: number;
};
export type BelegAnalysePayload = KiDateiPayload;
export type WarenkorbAnalysePayload = KiDateiPayload;
/** Diktat: die Aufnahme (audio/*, max 10 MB) liegt unter ki-tmp/<uuid>. */
export type DiktatPayload = KiDateiPayload;

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

/** Ein Auftrag, wie ihn GET /api/ki/sync dem Rig liefert. */
export interface KiSyncAuftrag {
  id: string;
  art: KiArt;
  versuche: number;
  /** Original-Payload plus `url` (signiert, 3600 s) bei Datei-Auftraegen. */
  payload: Record<string, unknown> & { url?: string };
}

/** Rueckmeldung des Rigs per POST /api/ki/sync. */
export interface KiSyncErgebnis {
  id: string;
  ok: boolean;
  ergebnis?: unknown;
  fehler?: string;
}

/** Ausgang von `warteAufErgebnis` — `timeout` heisst: Auftrag laeuft
 *  weiter, nur die Wartezeit der ERP-Seite ist um. */
export type KiWarteErgebnis<T> =
  | { status: "fertig"; ergebnis: T }
  | { status: "fehler"; fehler: string }
  | { status: "timeout" };
