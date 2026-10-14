// Entscheide zu den Fristen der NAS-Ablage (docs/lokale-ki/MASTERPLAN.md
// §3.8 MP-7, Tabelle ablage_fristen, Migration 304):
//   - leseFristEntscheid(): Body von POST /api/ablage/fristen pruefen (rein).
//   - entscheideFrist(): genau ein Entscheid, atomar und idempotent.
//
// Uebergaenge (nur diese, alles andere 409):
//   bestaetigen  vorschlag -> aktiv      (Datum vorher aenderbar)
//   verwerfen    vorschlag -> verworfen  (bleibt fuer immer: die Nachtarbeit
//                                         meldet fuer dieselbe Datei und
//                                         dasselbe Datum nie wieder etwas,
//                                         §3.6 «frist_bekannt»)
//   erledigt     aktiv     -> erledigt
// Jeder Wechsel ist ein bedingtes Update (… where status = <von>): bei einem
// Doppelklick oder zwei Admins gewinnt genau einer; derselbe Entscheid ein
// zweites Mal ist ok (End-Status und Datum stimmen), ein anderer bekommt 409.
//
// Datum geaendert beim Bestaetigen einer KI-Frist: die Zeile wandert auf das
// neue Datum, und fuer das von der KI berechnete Datum bleibt eine
// verworfene Sperr-Zeile stehen (gleiche Datei, Art, Grundlage). Sonst
// schluege die Nachtarbeit dieselbe Frist in der naechsten Nacht wieder vor
// (sie rechnet aus denselben Bedingungen wieder dasselbe Datum).
// Logs nur mit Codes — nie Pfade oder Bezeichnungen.

import type { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { KI_FRIST_MAX_JAHRE } from "./konstanten";
import { leseDatum, plusMonate } from "./fristen";
import type { FristStatus } from "./typen";

type Admin = ReturnType<typeof createAdminClient>;

export type FristAktion = "bestaetigen" | "verwerfen" | "erledigt";

export interface FristEntscheid {
  id: string;
  aktion: FristAktion;
  /** Nur bei «bestaetigen»: neues Datum (YYYY-MM-DD), sonst null. */
  datum: string | null;
}

/** Antwort der Route (gelesen von src/components/nas/fristen-gruppe.tsx). */
export interface FristErgebnis {
  ok: boolean;
  /** HTTP-Code (200, 404, 409, 500). */
  code: number;
  /** Status der Frist nach dem Aufruf (falls bekannt). */
  status?: FristStatus;
  /** Datum der Frist nach dem Aufruf (falls bekannt). */
  datum?: string;
  fehler?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FRIST_AKTIONEN: readonly FristAktion[] = ["bestaetigen", "verwerfen", "erledigt"];

export const FRIST_UEBERGANG: Readonly<Record<FristAktion, { von: FristStatus; nach: FristStatus }>> = {
  bestaetigen: { von: "vorschlag", nach: "aktiv" },
  verwerfen: { von: "vorschlag", nach: "verworfen" },
  erledigt: { von: "aktiv", nach: "erledigt" },
};

const STATUS_TEXT: Record<FristStatus, string> = {
  vorschlag: "noch nicht bestätigt",
  aktiv: "bestätigt",
  verworfen: "verworfen",
  erledigt: "erledigt",
};

function istObjekt(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Body `{ id, aktion, datum? }`. `datum` nur bei «bestaetigen», als echtes
 *  Kalenderdatum von heute bis heute + 10 Jahre (gleiche Grenze wie die
 *  Frist-Rechnung, §3.7). `heute` = Zurich-Kalendertag (YYYY-MM-DD). */
export function leseFristEntscheid(body: unknown, heute: string): { ok: true; entscheid: FristEntscheid } | { ok: false; fehler: string } {
  if (!istObjekt(body)) return { ok: false, fehler: "Body fehlt" };
  if (typeof body.id !== "string" || !UUID_RE.test(body.id)) return { ok: false, fehler: "Ungültige ID" };
  if (!FRIST_AKTIONEN.includes(body.aktion as FristAktion)) return { ok: false, fehler: "Ungültige Aktion" };
  const aktion = body.aktion as FristAktion;
  const id = body.id.toLowerCase();
  if (body.datum === undefined || body.datum === null || body.datum === "") return { ok: true, entscheid: { id, aktion, datum: null } };
  if (aktion !== "bestaetigen") return { ok: false, fehler: "Datum nur beim Bestätigen" };
  const datum = leseDatum(body.datum);
  if (!datum) return { ok: false, fehler: "Ungültiges Datum" };
  if (datum < heute) return { ok: false, fehler: "Datum liegt in der Vergangenheit" };
  if (datum > plusMonate(heute, KI_FRIST_MAX_JAHRE * 12)) return { ok: false, fehler: `Datum liegt mehr als ${KI_FRIST_MAX_JAHRE} Jahre in der Zukunft` };
  return { ok: true, entscheid: { id, aktion, datum } };
}

interface FristZeile {
  id: string;
  ablage_item_id: string | null;
  pfad: string | null;
  sha256: string | null;
  art: string;
  datum: string;
  bezeichnung: string;
  grundlage: unknown;
  quelle: string;
  status: FristStatus;
  sicherheit: string | null;
  sachverhalt?: string | null;
  weitere_pfade?: string[] | null;
}

const SPALTEN = "id, ablage_item_id, pfad, sha256, art, datum, bezeichnung, grundlage, quelle, status, sicherheit, sachverhalt, weitere_pfade";

/** Stand nach einem verlorenen Rennen (oder bei einem Entscheid auf eine
 *  schon entschiedene Frist): derselbe Entscheid = ok, sonst 409. */
function vergleiche(e: FristEntscheid, z: Pick<FristZeile, "status" | "datum">): FristErgebnis {
  const { nach } = FRIST_UEBERGANG[e.aktion];
  if (z.status === nach && (e.datum === null || z.datum === e.datum)) {
    return { ok: true, code: 200, status: z.status, datum: z.datum };
  }
  if (e.aktion === "erledigt" && z.status === "vorschlag") {
    return { ok: false, code: 409, status: z.status, datum: z.datum, fehler: "Frist ist noch nicht bestätigt" };
  }
  return { ok: false, code: 409, status: z.status, datum: z.datum, fehler: `Schon entschieden (${STATUS_TEXT[z.status] ?? z.status})` };
}

async function lese(admin: Admin, id: string): Promise<FristZeile | null> {
  const { data, error } = await admin.from("ablage_fristen").select(SPALTEN).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FristZeile | null) ?? null;
}

/** Fuehrt genau einen Entscheid aus (Admin-Client; die Route prueft das
 *  Admin-Recht). `jetzt` = ISO-Zeitpunkt fuer entschieden_am/updated_at. */
export async function entscheideFrist(admin: Admin, e: FristEntscheid, userId: string, jetzt: string): Promise<FristErgebnis> {
  const zeile = await lese(admin, e.id);
  if (!zeile) return { ok: false, code: 404, fehler: "Frist nicht gefunden" };
  const { von, nach } = FRIST_UEBERGANG[e.aktion];
  if (zeile.status !== von) return vergleiche(e, zeile);

  const neuesDatum = e.aktion === "bestaetigen" && e.datum !== null && e.datum !== zeile.datum ? e.datum : null;
  const patch: Record<string, unknown> = { status: nach, entschieden_von: userId, entschieden_am: jetzt, updated_at: jetzt };
  // Neues Datum = neue Erinnerungen (30/7/0 Tage vorher).
  if (neuesDatum) Object.assign(patch, { datum: neuesDatum, erinnert: [] });

  const { data, error } = await admin
    .from("ablage_fristen")
    .update(patch)
    .eq("id", e.id)
    .eq("status", von)
    .eq("datum", zeile.datum)
    .select("id, status, datum");
  if (error) {
    if (error.code === "23505") {
      return { ok: false, code: 409, status: zeile.status, datum: zeile.datum, fehler: "Für dieses Dokument gibt es diese Frist mit diesem Datum schon" };
    }
    throw new Error(error.message);
  }
  const neu = (data ?? []) as { id: string; status: FristStatus; datum: string }[];
  if (neu.length === 0) {
    // Jemand war schneller — Stand nachlesen.
    const jetztZeile = await lese(admin, e.id);
    if (!jetztZeile) return { ok: false, code: 404, fehler: "Frist nicht gefunden" };
    return vergleiche(e, jetztZeile);
  }

  if (neuesDatum && zeile.quelle === "ki") {
    // Sperr-Zeile fuer das KI-Datum (siehe Kopf). Scheitert sie, ist nichts
    // verloren — die KI schlaegt die Frist hoechstens nochmals vor.
    const { error: sperrErr } = await admin.from("ablage_fristen").insert({
      ablage_item_id: zeile.ablage_item_id,
      pfad: zeile.pfad,
      sha256: zeile.sha256,
      art: zeile.art,
      datum: zeile.datum,
      bezeichnung: zeile.bezeichnung,
      grundlage: zeile.grundlage,
      quelle: "ki",
      status: "verworfen",
      sicherheit: zeile.sicherheit,
      // Sachverhalt + alle Quell-Dokumente (Migration 321): auch die anderen
      // Dateien derselben Frist schlagen das KI-Datum nicht wieder vor.
      sachverhalt: zeile.sachverhalt ?? null,
      weitere_pfade: zeile.weitere_pfade ?? [],
      entschieden_von: userId,
      entschieden_am: jetzt,
    });
    if (sperrErr && sperrErr.code !== "23505") logError("ablage.fristen.sperrzeile", sperrErr.code ?? "unbekannt");
  }
  return { ok: true, code: 200, status: neu[0].status, datum: neu[0].datum };
}
