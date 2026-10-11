"use client";

// Warteschlange der Stempel-Aktionen (hinter dem StempelProvider).
//
// Jede Aktion wird ZUERST in IndexedDB geschrieben (write-ahead) und erst
// danach dem Nutzer bestaetigt. Gesendet wird strikt nach seq je Nutzer;
// beim ersten Nicht-Erfolg stoppt der Lauf (die naechste Aktion haengt von
// der vorherigen ab — ein clock_out zeigt auf die entry_id seines clock_in).
//
// Idempotenz: time_entries.id wird vom Client vergeben (crypto.randomUUID).
//   23505 auf time_entries_pkey              → Eintrag ist schon angekommen → Erfolg
//   23505 auf time_entries_one_active_per_user → anderes Geraet ist offen   → Konflikt
//   clock_out: update … eq(id).is(clock_out,null) mit count exact; 0 Zeilen
//              → Server-Stand pruefen (anderswo beendet / geloescht → erledigt
//              mit Hinweis; noch offen aber gefiltert → RLS/Sperre → abgelehnt)
//   42501 (RLS, Abrechnungssperre)           → abgelehnt (endgueltig)
//   401 / JWT abgelaufen                     → bleibt «wartet», sendet nach Login
//   Netzfehler                               → bleibt «wartet», Backoff 2 s → 60 s
//
// Nicht loesbar ohne Migration (Tombstone): ein clock_in, dessen Antwort
// verloren ging und dessen Eintrag danach am Server geloescht wurde, wuerde
// beim Wiederholen neu angelegt. Wir pruefen vor jedem Wiederholungsversuch,
// ob der Eintrag existiert (dann kein zweiter Insert) — «geloescht» und «nie
// angekommen» sind mit dem heutigen Schema aber nicht unterscheidbar.

import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import type { TimeEntry } from "@/types";
import { isTimeEntryLocked, TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";
import { formatTime } from "@/lib/format";
import {
  aktualisiereOp,
  fuegeOpEin,
  ladeOps,
  loescheOps,
  type StempelOp,
  type StempelOpKind,
  type StempelOpPayload,
} from "./db";

/** Window-Event nach jeder Aenderung der Warteschlange.
 *  detail: { serverNeuLaden: boolean } — true, wenn der Server-Stand sich
 *  durch einen Erfolg geaendert hat. */
export const OUTBOX_EVENT = "stempel:outbox";

export type OpErgebnis =
  | { art: "ok"; entry?: TimeEntry | null }
  | { art: "wartet"; fehler: string }
  | { art: "fehler"; fehler: string }
  | { art: "konflikt"; fehler: string }
  | { art: "abgelehnt"; fehler: string };

const SESSION_ABGELAUFEN = "Sitzung abgelaufen — wird nach dem Anmelden gesendet";
const OHNE_NETZ = "Kein Netz";

function melde(serverNeuLaden: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OUTBOX_EVENT, { detail: { serverNeuLaden } }));
}

// ---------------------------------------------------------------------------
// Fehler einordnen
// ---------------------------------------------------------------------------

interface DbFehler {
  code?: string | null;
  message?: string | null;
}

export function istNetzfehler(error: DbFehler | null, status: number | undefined): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (status === 0) return true;
  const m = error?.message ?? "";
  return /failed to fetch|networkerror|load failed|network request failed|fetcherror/i.test(m);
}

function istAuthFehler(error: DbFehler | null, status: number | undefined): boolean {
  if (status === 401) return true;
  if (error?.code === "PGRST301") return true;
  return /jwt/i.test(error?.message ?? "");
}

/** Nicht-Erfolgsfall einer Server-Antwort auf ein Ergebnis abbilden. */
function einordnen(error: DbFehler, status: number | undefined): Exclude<OpErgebnis, { art: "ok" }> {
  if (istNetzfehler(error, status)) return { art: "wartet", fehler: OHNE_NETZ };
  if (istAuthFehler(error, status)) return { art: "wartet", fehler: SESSION_ABGELAUFEN };
  if (error.code === "42501") return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };
  if (error.code === "developer_mode_read_only") return { art: "abgelehnt", fehler: error.message ?? "Nur-Lesen-Modus" };
  return { art: "fehler", fehler: error.message || "Unbekannter Fehler" };
}

// ---------------------------------------------------------------------------
// Einreihen
// ---------------------------------------------------------------------------

export interface NeueOp {
  user_id: string;
  kind: StempelOpKind;
  entry_id: string;
  payload: StempelOpPayload;
  client_ts: string;
}

/** Schreibt die Aktion in IndexedDB. Wirft bei Quota-/IDB-Fehlern. */
export async function reiheEin(neu: NeueOp): Promise<StempelOp> {
  const op = await fuegeOpEin({ op_id: crypto.randomUUID(), ...neu });
  melde(false);
  return op;
}

// ---------------------------------------------------------------------------
// Eine Aktion senden
// ---------------------------------------------------------------------------

type Sb = SupabaseClient;

async function eintragLaden(sb: Sb, id: string) {
  const { data, error, status } = await sb
    .from("time_entries")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return { row: (data as TimeEntry | null) ?? null, error: error as DbFehler | null, status };
}

async function sendeClockIn(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  if (isTimeEntryLocked(op.client_ts)) return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };

  // Wiederholung: Antwort koennte verloren gegangen sein → erst nachsehen,
  // ob der Eintrag schon da ist (kein zweiter Insert).
  if (op.attempts > 1) {
    const { row, error, status } = await eintragLaden(sb, op.entry_id);
    if (error) return einordnen(error, status);
    if (row) return { art: "ok", entry: row };
  }

  const { data, error, status } = await sb
    .from("time_entries")
    .insert({
      id: op.entry_id,
      user_id: op.user_id,
      job_id: op.payload.job_id,
      project_id: op.payload.project_id,
      description: op.payload.description,
      rate_tier_id: op.payload.rate_tier_id,
      clock_in: op.client_ts,
    })
    .select("*")
    .single();
  if (!error) return { art: "ok", entry: data as TimeEntry };
  if (error.code === "23505") {
    if (/time_entries_pkey/.test(error.message)) {
      const nach = await eintragLaden(sb, op.entry_id);
      return { art: "ok", entry: nach.row };
    }
    if (/one_active_per_user/.test(error.message)) {
      return { art: "konflikt", fehler: "Du bist auf einem anderen Gerät oder am Computer bereits eingestempelt" };
    }
  }
  return einordnen(error, status);
}

/**
 * Schliesst einen Eintrag idempotent. Liefert «erledigt» (true) oder ein
 * Ergebnis, das den Lauf stoppt. `eigeneZeit` = client_ts des Schliessens.
 */
async function schliesseEintrag(
  sb: Sb,
  entryId: string,
  eigeneZeit: string,
  beiFremdemAbschluss: "hinweis" | "konflikt",
): Promise<OpErgebnis> {
  const { error, count, status } = await sb
    .from("time_entries")
    .update({ clock_out: eigeneZeit }, { count: "exact" })
    .eq("id", entryId)
    .is("clock_out", null);
  if (error) return einordnen(error, status);
  if ((count ?? 0) > 0) return { art: "ok" };

  // 0 Zeilen: anderswo beendet, geloescht, eigener frueherer Versuch — oder
  // RLS hat die Zeile gefiltert (Abrechnungssperre).
  const { row, error: e2, status: s2 } = await eintragLaden(sb, entryId);
  if (e2) return einordnen(e2, s2);
  if (!row) {
    if (beiFremdemAbschluss === "konflikt") {
      return { art: "konflikt", fehler: "Der laufende Eintrag wurde inzwischen gelöscht" };
    }
    toast.warning(
      `Der Eintrag wurde inzwischen gelöscht — deine Ausstempelzeit ${formatTime(eigeneZeit)} wurde nicht übernommen.`,
      { duration: 8000 },
    );
    return { art: "ok" };
  }
  if (row.clock_out === eigeneZeit) return { art: "ok" };
  if (row.clock_out) {
    if (beiFremdemAbschluss === "konflikt") {
      return { art: "konflikt", fehler: `Der laufende Eintrag wurde um ${formatTime(row.clock_out)} anderswo beendet` };
    }
    toast.warning(
      `Bereits um ${formatTime(row.clock_out)} anderswo ausgestempelt — deine Zeit ${formatTime(eigeneZeit)} wurde nicht übernommen. Korrektur per Ticket «Stempel-Änderung».`,
      { duration: 10000 },
    );
    return { art: "ok" };
  }
  // Noch offen, aber Update hat nichts getroffen → RLS (Sperre).
  return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };
}

async function sendeClockOut(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  if (op.payload.clock_in && isTimeEntryLocked(op.payload.clock_in)) {
    return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };
  }
  return schliesseEintrag(sb, op.entry_id, op.client_ts, "hinweis");
}

async function sendeSwitchTier(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  const prev = op.payload.prev_entry_id;
  if (!prev) return { art: "fehler", fehler: "Tarifwechsel ohne laufenden Eintrag" };
  if (isTimeEntryLocked(op.client_ts) || (op.payload.clock_in && isTimeEntryLocked(op.payload.clock_in))) {
    return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };
  }

  // 1. Vorgaenger schliessen (ein frueherer eigener Versuch zaehlt als erledigt).
  const zu = await schliesseEintrag(sb, prev, op.client_ts, "konflikt");
  if (zu.art !== "ok") return zu;

  // 2. Neuen Eintrag mit neuem Tarif anlegen.
  if (op.attempts > 1) {
    const { row, error, status } = await eintragLaden(sb, op.entry_id);
    if (error) return einordnen(error, status);
    if (row) return { art: "ok", entry: row };
  }
  const { data, error, status } = await sb
    .from("time_entries")
    .insert({
      id: op.entry_id,
      user_id: op.user_id,
      job_id: op.payload.job_id,
      project_id: op.payload.project_id,
      description: op.payload.description,
      rate_tier_id: op.payload.rate_tier_id,
      clock_in: op.client_ts,
    })
    .select("*")
    .single();
  if (!error) return { art: "ok", entry: data as TimeEntry };
  if (error.code === "23505") {
    if (/time_entries_pkey/.test(error.message)) {
      const nach = await eintragLaden(sb, op.entry_id);
      return { art: "ok", entry: nach.row };
    }
    if (/one_active_per_user/.test(error.message)) {
      // Rollback wie bisher: Vorgaenger wieder oeffnen, damit niemand ohne
      // laufende Uhr dasteht. Nur den eigenen Abschluss zuruecknehmen.
      await sb.from("time_entries").update({ clock_out: null }).eq("id", prev).eq("clock_out", op.client_ts);
      return { art: "konflikt", fehler: "Auf einem anderen Gerät ist bereits ein Eintrag offen" };
    }
  }
  return einordnen(error, status);
}

function sendeNachArt(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  switch (op.kind) {
    case "clock_in":
      return sendeClockIn(sb, op);
    case "clock_out":
      return sendeClockOut(sb, op);
    case "switch_tier":
      return sendeSwitchTier(sb, op);
  }
}

// ---------------------------------------------------------------------------
// Sperre: nie zwei Laeufe gleichzeitig (Trigger + direkter Versand).
// ---------------------------------------------------------------------------

let kette: Promise<unknown> = Promise.resolve();
function mitSperre<T>(fn: () => Promise<T>): Promise<T> {
  const p = kette.then(fn, fn);
  kette = p.catch(() => {});
  return p;
}

/** Status «sendet» + attempts+1 persistieren, dann senden. */
async function versuche(sb: Sb, op: StempelOp): Promise<{ op: StempelOp; r: OpErgebnis }> {
  const aktuell = (await aktualisiereOp(op.op_id, { status: "sendet", attempts: op.attempts + 1 })) ?? op;
  melde(false);
  let r: OpErgebnis;
  try {
    r = await sendeNachArt(sb, aktuell);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    r = istNetzfehler({ message: msg }, 0) ? { art: "wartet", fehler: OHNE_NETZ } : { art: "fehler", fehler: msg };
  }
  return { op: aktuell, r };
}

// ---------------------------------------------------------------------------
// Backoff 2 s → 60 s (nur fuer Netz-/Auth-Wartefaelle)
// ---------------------------------------------------------------------------

let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let fehlschlaegeInFolge = 0;

function planeBackoff(sb: Sb, userId: string) {
  if (backoffTimer) return;
  const delay = Math.min(60_000, 2_000 * 2 ** fehlschlaegeInFolge);
  fehlschlaegeInFolge += 1;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    void sendeAlle(sb, userId);
  }, delay);
}

function backoffZuruecksetzen() {
  fehlschlaegeInFolge = 0;
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Oeffentliche Laeufe
// ---------------------------------------------------------------------------

/**
 * Sendet alle wartenden Aktionen des Nutzers strikt nach seq. Stoppt beim
 * ersten Nicht-Erfolg. Konflikt/abgelehnt blockieren die Reihe, bis der
 * Nutzer entscheidet. Ohne Netz passiert nichts (kein attempts-Zaehler).
 */
export function sendeAlle(sb: Sb, userId: string): Promise<void> {
  return mitSperre(async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let ops: StempelOp[];
    try {
      ops = await ladeOps(userId);
    } catch {
      return;
    }
    for (const op of ops) {
      if (op.status === "konflikt" || op.status === "abgelehnt") return;
      const { op: aktuell, r } = await versuche(sb, op);
      if (r.art === "ok") {
        await loescheOps([aktuell.op_id]);
        backoffZuruecksetzen();
        melde(true);
        continue;
      }
      await aktualisiereOp(aktuell.op_id, { status: r.art, last_error: r.fehler });
      melde(false);
      if (r.art === "wartet") planeBackoff(sb, userId);
      return;
    }
  });
}

/**
 * Direkter Versand einer frisch eingereihten Aktion (online, leere Reihe):
 * gleiches Verhalten wie frueher — der Aufrufer bekommt das Server-Ergebnis.
 * Erfolg und endgueltige Fehler entfernen die Aktion aus der Reihe; nur
 * Netz-/Auth-Wartefaelle bleiben stehen und werden spaeter gesendet.
 */
export function sendeDirekt(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  return mitSperre(async () => {
    const { op: aktuell, r } = await versuche(sb, op);
    if (r.art === "wartet") {
      await aktualisiereOp(aktuell.op_id, { status: "wartet", last_error: r.fehler });
      melde(false);
      planeBackoff(sb, aktuell.user_id);
      return r;
    }
    await loescheOps([aktuell.op_id]);
    if (r.art === "ok") backoffZuruecksetzen();
    melde(r.art === "ok");
    return r;
  });
}

/**
 * Notpfad ohne IndexedDB (privater Modus / Speicher gesperrt): Aktion wird
 * nirgends persistiert, nur gesendet — Verhalten wie vor der Warteschlange.
 */
export function sendeOhneReihe(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  return mitSperre(async () => {
    try {
      return await sendeNachArt(sb, { ...op, attempts: 1 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return istNetzfehler({ message: msg }, 0) ? { art: "wartet", fehler: OHNE_NETZ } : { art: "fehler", fehler: msg };
    }
  });
}

/**
 * Aktion verwerfen — samt allen Folgeaktionen, die von ihr abhaengen
 * (clock_out/switch_tier auf dieselbe entry_id, transitiv ueber Tarifwechsel).
 * «Server-Eintrag behalten» im Konfliktfall ruft genau das.
 */
export async function verwerfeOp(userId: string, opId: string): Promise<void> {
  const ops = await ladeOps(userId);
  const start = ops.find((o) => o.op_id === opId);
  if (!start) return;
  const betroffen = new Set<string>([start.entry_id]);
  const zuLoeschen: string[] = [];
  for (const o of ops) {
    if (o.seq < start.seq) continue;
    const haengt =
      o.op_id === start.op_id ||
      betroffen.has(o.entry_id) ||
      (o.payload.prev_entry_id ? betroffen.has(o.payload.prev_entry_id) : false);
    if (!haengt) continue;
    betroffen.add(o.entry_id);
    zuLoeschen.push(o.op_id);
  }
  await loescheOps(zuLoeschen);
  melde(true);
}

/** Konflikt/Fehler zuruecksetzen und sofort wieder versuchen. */
export async function erneutVersuchen(sb: Sb, userId: string, opId: string): Promise<void> {
  await aktualisiereOp(opId, { status: "wartet", last_error: null });
  melde(false);
  backoffZuruecksetzen();
  await sendeAlle(sb, userId);
}

/** Manuell «Jetzt senden» — Backoff ueberspringen. */
export async function jetztSenden(sb: Sb, userId: string): Promise<void> {
  backoffZuruecksetzen();
  await sendeAlle(sb, userId);
}
