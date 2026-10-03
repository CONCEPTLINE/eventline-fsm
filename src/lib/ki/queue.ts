// Warteschlange der lokalen KI (SPEC 2.3): Server-Code legt Auftraege an,
// wartet auf das Ergebnis und fragt den Herzschlag ab. Alles ueber die
// Service-Role — die Tabellen haben bewusst keine Schreib-Policies.
//
// Ablauf eines Datei-Auftrags:
//   speichereKiTmp(bytes)  -> ki-tmp/<uuid> im Bucket nas-ablage
//   erstelleKiAuftrag(art, { storage_path, file_name, mime, size })
//   warteAufErgebnis(id, timeoutMs)  -> fertig | fehler | timeout
// Das Rig holt den Auftrag ueber /api/ki/sync ab; Tmp-Objekte von Beleg-,
// Warenkorb- und Diktat-Auftraegen loescht die Abhol-API nach der
// Rueckmeldung, die Ablage-Datei wandert mit /api/ablage/upload (tmp_id)
// nach items/<id>.
//
// Datenschutz: Ergebnisse enthalten Inhalte vertraulicher Dokumente und
// bleiben nicht liegen — wer ein Ergebnis gelesen hat, loescht die Zeile
// (loescheKiAuftrag); was trotzdem liegen bleibt, raeumt raeumeKiAuf weg.

import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import {
  KI_AUFTRAG_MAX_ALTER_MS,
  KI_BUCKET,
  KI_ERGEBNIS_MAX_ALTER_MS,
  KI_ONLINE_FENSTER_MS,
  KI_TMP_MAX_ALTER_MS,
  KI_TMP_PREFIX,
  KI_WARTE_POLL_MS,
} from "./konstanten";
import type { KiArt, KiAuftragRow, KiStatusRow, KiWarteErgebnis } from "./typen";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function kiTmpPfad(tmpId: string): string {
  return `${KI_TMP_PREFIX}${tmpId}`;
}

/** Nur Pfade der Form ki-tmp/<uuid> duerfen in einen Auftrag — alles
 *  andere (z.B. items/<id> fremder Ablagen) wird abgewiesen. */
export function istKiTmpPfad(pfad: unknown): pfad is string {
  return typeof pfad === "string" && pfad.startsWith(KI_TMP_PREFIX) && UUID_RE.test(pfad.slice(KI_TMP_PREFIX.length));
}

/** Legt eine Datei fuer das Rig im Uebergabe-Bucket ab. */
export async function speichereKiTmp(bytes: Uint8Array, contentType: string): Promise<{ tmp_id: string; storage_path: string }> {
  const tmp_id = randomUUID();
  const storage_path = kiTmpPfad(tmp_id);
  const admin = createAdminClient();
  const { error } = await admin.storage.from(KI_BUCKET).upload(storage_path, bytes, {
    contentType: contentType || "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`Übergabe-Datei konnte nicht gespeichert werden: ${error.message}`);
  return { tmp_id, storage_path };
}

/** Raeumt ein Tmp-Objekt weg; Fehler werden nur protokolliert (das
 *  24-h-Housekeeping faengt Reste auf). */
export async function loescheKiTmp(storagePath: string): Promise<void> {
  if (!istKiTmpPfad(storagePath)) return;
  const admin = createAdminClient();
  const { error } = await admin.storage.from(KI_BUCKET).remove([storagePath]);
  if (error) logError("ki.tmp.loeschen", error, { storagePath });
}

export async function erstelleKiAuftrag(art: KiArt, payload: Record<string, unknown>, createdBy: string | null): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ki_auftraege")
    .insert({ art, payload, created_by: createdBy })
    .select("id")
    .single();
  if (error || !data) throw new Error(`KI-Auftrag konnte nicht angelegt werden: ${error?.message ?? "unbekannt"}`);
  return data.id as string;
}

/** Entfernt eine Auftragszeile nach Gebrauch — das Ergebnis ist gelesen
 *  oder wird nicht mehr gebraucht. Ein noch offener Auftrag wird so nie
 *  abgeholt; das spaete Ergebnis eines laufenden ignoriert die Abhol-API.
 *  Fehler nur protokollieren (das Housekeeping faengt Reste auf). */
export async function loescheKiAuftrag(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("ki_auftraege").delete().eq("id", id);
  if (error) logError("ki.auftrag.loeschen", error, { id });
}

export async function holeKiAuftrag(id: string): Promise<KiAuftragRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("ki_auftraege").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as KiAuftragRow | null) ?? null;
}

/** Fragt den Auftrag im Sekundentakt ab, bis er fertig/fehler ist oder
 *  die Wartezeit um ist. Bei `timeout` laeuft der Auftrag weiter — der
 *  Aufrufer faellt auf den bisherigen Weg zurueck (SPEC 1.5). */
export async function warteAufErgebnis<T = unknown>(id: string, timeoutMs: number): Promise<KiWarteErgebnis<T>> {
  const admin = createAdminClient();
  const ende = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await admin.from("ki_auftraege").select("status, ergebnis, fehler").eq("id", id).maybeSingle();
    if (error) return { status: "fehler", fehler: `Auftrag konnte nicht gelesen werden: ${error.message}` };
    if (!data) return { status: "fehler", fehler: "Auftrag nicht gefunden" };
    if (data.status === "fertig") return { status: "fertig", ergebnis: data.ergebnis as T };
    if (data.status === "fehler") return { status: "fehler", fehler: (data.fehler as string | null) || "Lokale KI meldet einen Fehler" };
    const rest = ende - Date.now();
    if (rest <= 0) return { status: "timeout" };
    await new Promise((r) => setTimeout(r, Math.min(KI_WARTE_POLL_MS, rest)));
  }
}

/** Herzschlag-Regel (SPEC 2.3): letzter_poll juenger als 90 s = online. */
export function istKiOnline(letzterPoll: string | null | undefined, jetztMs = Date.now()): boolean {
  if (!letzterPoll) return false;
  const t = Date.parse(letzterPoll);
  return Number.isFinite(t) && jetztMs - t < KI_ONLINE_FENSTER_MS;
}

export async function ladeKiStatus(): Promise<KiStatusRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("ki_status").select("*").eq("id", 1).maybeSingle();
  if (error) {
    logError("ki.status.lesen", error);
    return null;
  }
  return (data as KiStatusRow | null) ?? null;
}

export async function kiOnline(): Promise<boolean> {
  const status = await ladeKiStatus();
  return istKiOnline(status?.letzter_poll);
}

/** Was ein Housekeeping-Lauf weggeraeumt hat (fuer Cron-Antwort/Logs). */
export interface KiAufraeumBericht {
  auftraege_geloescht: number;
  offen_abgelaufen: number;
  ergebnisse_geleert: number;
  tmp_geloescht: number;
}

/** Housekeeping der Warteschlange (Datenschutz). Laeuft gedrosselt im
 *  Abhol-Pfad (/api/ki/sync) und taeglich aus /api/cron/db-retention —
 *  der Cron greift auch, wenn das Rig laenger nicht pollt.
 *   1. Zeilen aelter als 30 Tage -> loeschen (jeder Zustand).
 *   2. Offen und seit 24 h nicht abgeholt -> fehler (KI war zu lange
 *      offline; der Nutzer ist laengst den bisherigen Weg gegangen).
 *   3. Fertig/fehler seit mehr als 1 h -> ergebnis = null.
 *   4. Tmp-Objekte aelter als 24 h -> loeschen (abgebrochene Ablagen, Reste).
 *  Wirft nie: jeder Schritt protokolliert seinen Fehler und der naechste
 *  Lauf holt den Rest nach. */
export async function raeumeKiAuf(jetztMs = Date.now()): Promise<KiAufraeumBericht> {
  const admin = createAdminClient();
  const vor = (ms: number) => new Date(jetztMs - ms).toISOString();
  const bericht: KiAufraeumBericht = { auftraege_geloescht: 0, offen_abgelaufen: 0, ergebnisse_geleert: 0, tmp_geloescht: 0 };

  const alt = await admin
    .from("ki_auftraege")
    .delete({ count: "exact" })
    .lt("created_at", vor(KI_AUFTRAG_MAX_ALTER_MS));
  if (alt.error) logError("ki.aufraeumen.zeilen", alt.error);
  else bericht.auftraege_geloescht = alt.count ?? 0;

  const offen = await admin
    .from("ki_auftraege")
    .update(
      { status: "fehler", fehler: "Nicht verarbeitet — die lokale KI war zu lange offline", finished_at: new Date(jetztMs).toISOString() },
      { count: "exact" },
    )
    .eq("status", "offen")
    .lt("created_at", vor(KI_TMP_MAX_ALTER_MS));
  if (offen.error) logError("ki.aufraeumen.offen", offen.error);
  else bericht.offen_abgelaufen = offen.count ?? 0;

  const geleert = await admin
    .from("ki_auftraege")
    .update({ ergebnis: null }, { count: "exact" })
    .in("status", ["fertig", "fehler"])
    .lt("finished_at", vor(KI_ERGEBNIS_MAX_ALTER_MS))
    .not("ergebnis", "is", null);
  if (geleert.error) logError("ki.aufraeumen.ergebnisse", geleert.error);
  else bericht.ergebnisse_geleert = geleert.count ?? 0;

  // Aelteste zuerst; nach jedem Loeschen wieder ab Anfang lesen (die
  // Liste rueckt nach). Hoechstens 5 Runden a 1000 pro Lauf.
  const tmpGrenze = jetztMs - KI_TMP_MAX_ALTER_MS;
  for (let runde = 0; runde < 5; runde++) {
    const { data: objekte, error: listErr } = await admin.storage
      .from(KI_BUCKET)
      .list(KI_TMP_PREFIX.replace(/\/$/, ""), { limit: 1000, sortBy: { column: "created_at", order: "asc" } });
    if (listErr) {
      logError("ki.aufraeumen.tmp.liste", listErr);
      break;
    }
    const liste = objekte ?? [];
    const weg = liste
      .filter((o) => o.id && o.created_at && Date.parse(o.created_at) < tmpGrenze)
      .map((o) => `${KI_TMP_PREFIX}${o.name}`);
    if (weg.length === 0) break;
    const { error: remErr } = await admin.storage.from(KI_BUCKET).remove(weg);
    if (remErr) {
      logError("ki.aufraeumen.tmp.loeschen", remErr, { anzahl: weg.length });
      break;
    }
    bericht.tmp_geloescht += weg.length;
    if (weg.length < liste.length || liste.length < 1000) break;
  }

  return bericht;
}
