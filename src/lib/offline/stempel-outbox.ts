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
//   Regeln der Datenbank (Ueberlappung 23P01, Stempel > 16 h ohne
//   Begruendung, Monat abgerechnet «nur per Antrag») → abgelehnt mit
//   Klartext aus src/lib/stempel-meldungen.ts (nochmals senden aendert nichts)
//   clock_out mit payload.clock_out/lang_begruendung (Phase 4): Ausstempeln
//              nach > 16 h mit selbst gewaehlter Endzeit; alte Eintraege ohne
//              diese Felder schliessen wie bisher mit client_ts
//   Alte Eintraege (vor Phase 4 ohne Endzeit eingereiht), die nach Regel 368
//   an «> 16 h ohne Begruendung» scheitern: status abgelehnt mit
//   LANG_ENDZEIT_FEHLT + Event STEMPEL_LANG_EVENT — der Provider fragt Endzeit
//   und Begruendung (Dialog «Ausstempeln nach > 16 h») und ergaenzt die Aktion
//   AN IHREM PLATZ (endzeitNachtragen), damit die Reihenfolge bleibt. Gilt
//   fuer clock_out und den Abschluss des Vorgaengers beim Tarifwechsel.
//   401 / JWT abgelaufen                     → bleibt «wartet», sendet nach Login
//   Sitzung gehoert nicht zum Nutzer der Reihe (Logout, Nutzerwechsel im
//   selben Tab) → sendeAlle sendet nichts, auch kein Backoff-Nachlauf
//   Netzfehler                               → bleibt «wartet», Backoff 2 s → 60 s
//   switch_tier: scheitert der Insert endgueltig (konflikt/abgelehnt/fehler),
//              wird der eigene Abschluss des Vorgaengers zurueckgenommen —
//              niemand steht ohne laufende Uhr da. Bei «wartet» kein Rollback.
//
// Zeitvergleich Server ↔ Client immer ueber gleicheZeit() (Date.parse):
// PostgREST liefert "+00:00" mit teils gekuerzten Nachkommastellen,
// toISOString() liefert "Z" — als Strings sind die nie gleich.
//
// Nicht loesbar ohne Migration (Tombstone): ein clock_in, dessen Antwort
// verloren ging und dessen Eintrag danach am Server geloescht wurde, wuerde
// beim Wiederholen neu angelegt. Wir pruefen vor jedem Wiederholungsversuch,
// ob der Eintrag existiert (dann kein zweiter Insert) — «geloescht» und «nie
// angekommen» sind mit dem heutigen Schema aber nicht unterscheidbar.

import { isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import type { TimeEntry } from "@/types";
import { isTimeEntryLocked, TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";
import { formatTime } from "@/lib/format";
import { endeGesperrtMeldung, stempelFehlerArt, stempelFehlerText, type StempelFehlerArt } from "@/lib/stempel-meldungen";
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

/** last_error einer Aktion (Ausstempeln/Tarifwechsel ohne Endzeit), die an
 *  «Stempel ueber 16 h ohne Begruendung» scheitert — der Provider erkennt
 *  daran «Endzeit nachfragen». Zugleich Klartext im Uebertragungen-Sheet. */
export const LANG_ENDZEIT_FEHLT =
  "Stempel über 16 Stunden — es fehlen Endzeit und Begründung. Tippe «Ausstempeln», um sie anzugeben.";

/** Window-Event: eine Aktion braucht Endzeit + Begruendung. detail: { opId }. */
export const STEMPEL_LANG_EVENT = "stempel:lang-endzeit";

/** last_error einer wartenden Aktion, deren Sitzung abgelaufen ist — der
 *  Offline-Streifen erkennt daran «neu anmelden». */
export const SESSION_ABGELAUFEN = "Sitzung abgelaufen — wird nach dem Anmelden gesendet";
const OHNE_NETZ = "Kein Netz";

function melde(serverNeuLaden: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OUTBOX_EVENT, { detail: { serverNeuLaden } }));
}

/** Zwei Zeitstempel (Server- und Client-Format) als Zeitpunkt vergleichen. */
function gleicheZeit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && x === y;
}

// ---------------------------------------------------------------------------
// Fehler einordnen
// ---------------------------------------------------------------------------

interface DbFehler {
  code?: string | null;
  message?: string | null;
  details?: string | null;
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

/** Nicht-Erfolgsfall einer Server-Antwort auf ein Ergebnis abbilden.
 *  `zeitpunkt` = Zeit des betroffenen Eintrags: ein RLS-Nein (42501) heisst
 *  nur dann «abgerechnet», wenn dieser Zeitpunkt wirklich gesperrt ist —
 *  sonst fehlt schlicht die Berechtigung (z. B. Konto deaktiviert). */
function einordnen(error: DbFehler, status: number | undefined, zeitpunkt?: string | null): Exclude<OpErgebnis, { art: "ok" }> {
  if (istNetzfehler(error, status)) return { art: "wartet", fehler: OHNE_NETZ };
  if (istAuthFehler(error, status)) return { art: "wartet", fehler: SESSION_ABGELAUFEN };
  if (error.code === "42501") {
    const gesperrt = zeitpunkt === undefined || isTimeEntryLocked(zeitpunkt);
    return { art: "abgelehnt", fehler: gesperrt ? TIME_ENTRY_LOCK_MESSAGE : "Keine Berechtigung — vom Server abgelehnt" };
  }
  if (error.code === "developer_mode_read_only") return { art: "abgelehnt", fehler: error.message ?? "Nur-Lesen-Modus" };
  return { art: "fehler", fehler: error.message || "Unbekannter Fehler" };
}

/** Regeln der Datenbank: endgueltig — nochmals senden aendert nichts. */
const ENDGUELTIG: StempelFehlerArt[] = ["ueberlappung", "lang", "antrag", "nicht_loeschbar", "lohnfelder", "kontext_fehlt", "ende_vor_beginn"];

/** Wozu gehoert der Fehler? Fuer den Klartext (Ueberschneidung nachladen)
 *  und die Sperr-Meldung beim Ausstempeln. */
interface FehlerBezug {
  /** Beginn des betroffenen Eintrags (Sperr-Pruefung, Ueberschneidung). */
  von: string;
  /** Ende (null = offen). */
  bis: string | null;
  entryId: string;
  /** Ausstempeln: Sperre heisst «das Ende setzt die Lohnverwaltung per Antrag». */
  ausstempeln?: boolean;
}

/** Wie einordnen, aber mit Klartext fuer die Regeln der Datenbank
 *  (Ueberschneidung samt betroffenem Stempel, > 16 h, Monat abgerechnet). */
async function einordnenKlartext(
  sb: Sb,
  op: StempelOp,
  error: DbFehler,
  status: number | undefined,
  b: FehlerBezug,
): Promise<Exclude<OpErgebnis, { art: "ok" }>> {
  const r = einordnen(error, status, b.von);
  if (r.art === "wartet") return r;
  const art = stempelFehlerArt(error);
  if (b.ausstempeln && (art === "antrag" || (art === "gesperrt" && isTimeEntryLocked(b.von)))) {
    return { art: "abgelehnt", fehler: endeGesperrtMeldung(b.von) };
  }
  if (r.art === "abgelehnt" || !ENDGUELTIG.includes(art)) return r;
  const text = await stempelFehlerText(sb, error, { userId: op.user_id, von: b.von, bis: b.bis, ohneId: b.entryId });
  return { art: "abgelehnt", fehler: text };
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

/**
 * Legt den Eintrag der Aktion idempotent an (clock_in und switch_tier).
 * `konfliktText` = Meldung, wenn one_active_per_user greift.
 */
async function eintragAnlegen(sb: Sb, op: StempelOp, konfliktText: string): Promise<OpErgebnis> {
  // Wiederholung: Antwort koennte verloren gegangen sein → erst nachsehen,
  // ob der Eintrag schon da ist (kein zweiter Insert).
  if (op.attempts > 1) {
    const { row, error, status } = await eintragLaden(sb, op.entry_id);
    if (error) return einordnen(error, status, op.client_ts);
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
      return { art: "konflikt", fehler: konfliktText };
    }
  }
  return einordnenKlartext(sb, op, error, status, { von: op.client_ts, bis: null, entryId: op.entry_id });
}

async function sendeClockIn(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  if (isTimeEntryLocked(op.client_ts)) return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };
  return eintragAnlegen(sb, op, "Du bist auf einem anderen Gerät oder am Computer bereits eingestempelt");
}

/**
 * Schliesst einen Eintrag idempotent. Liefert «erledigt» (true) oder ein
 * Ergebnis, das den Lauf stoppt. `eigeneZeit` = Endzeit des Schliessens
 * (client_ts bzw. beim Ausstempeln nach > 16 h die gewaehlte Endzeit).
 */
async function schliesseEintrag(
  sb: Sb,
  op: StempelOp,
  entryId: string,
  eigeneZeit: string,
  beiFremdemAbschluss: "hinweis" | "konflikt",
  zusatz: { clockIn?: string | null; langBegruendung?: string | null } = {},
): Promise<OpErgebnis> {
  const ausstempeln = beiFremdemAbschluss === "hinweis";
  const werte: { clock_out: string; lang_begruendung?: string } = { clock_out: eigeneZeit };
  if (zusatz.langBegruendung) werte.lang_begruendung = zusatz.langBegruendung;
  const { error, count, status } = await sb
    .from("time_entries")
    .update(werte, { count: "exact" })
    .eq("id", entryId)
    .is("clock_out", null);
  if (error) {
    // Ohne gewaehlte Endzeit (alte Aktion bzw. Uhr knapp ueber 16 h): nicht
    // haengen lassen — der Provider fragt Endzeit + Begruendung nach.
    if (stempelFehlerArt(error) === "lang" && !zusatz.langBegruendung) return { art: "abgelehnt", fehler: LANG_ENDZEIT_FEHLT };
    return einordnenKlartext(sb, op, error, status, { von: zusatz.clockIn ?? eigeneZeit, bis: eigeneZeit, entryId, ausstempeln });
  }
  if ((count ?? 0) > 0) return { art: "ok" };

  // 0 Zeilen: anderswo beendet, geloescht, eigener frueherer Versuch — oder
  // RLS hat die Zeile gefiltert (Abrechnungssperre).
  const { row, error: e2, status: s2 } = await eintragLaden(sb, entryId);
  if (e2) return einordnen(e2, s2, eigeneZeit);
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
  if (gleicheZeit(row.clock_out, eigeneZeit)) return { art: "ok" };
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
  return { art: "abgelehnt", fehler: ausstempeln ? endeGesperrtMeldung(row.clock_in) : TIME_ENTRY_LOCK_MESSAGE };
}

async function sendeClockOut(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  if (op.payload.clock_in && isTimeEntryLocked(op.payload.clock_in)) {
    return { art: "abgelehnt", fehler: endeGesperrtMeldung(op.payload.clock_in) };
  }
  // Phase 4: selbst gewaehlte Endzeit (Ausstempeln nach > 16 h); aeltere
  // Eintraege in IndexedDB haben sie nicht → Zeit der Aktion.
  return schliesseEintrag(sb, op, op.entry_id, op.payload.clock_out ?? op.client_ts, "hinweis", {
    clockIn: op.payload.clock_in,
    langBegruendung: op.payload.lang_begruendung,
  });
}

async function sendeSwitchTier(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  const prev = op.payload.prev_entry_id;
  if (!prev) return { art: "fehler", fehler: "Tarifwechsel ohne laufenden Eintrag" };
  if (isTimeEntryLocked(op.client_ts) || (op.payload.clock_in && isTimeEntryLocked(op.payload.clock_in))) {
    return { art: "abgelehnt", fehler: TIME_ENTRY_LOCK_MESSAGE };
  }

  // 1. Vorgaenger schliessen (ein frueherer eigener Versuch zaehlt als erledigt).
  // Endzeit des Vorgaengers: nachgetragen (> 16 h) oder Zeit der Aktion.
  const ende = op.payload.clock_out ?? op.client_ts;
  const zu = await schliesseEintrag(sb, op, prev, ende, "konflikt", { clockIn: op.payload.clock_in, langBegruendung: op.payload.lang_begruendung });
  if (zu.art !== "ok") return zu;

  // 2. Neuen Eintrag mit neuem Tarif anlegen.
  const neu = await eintragAnlegen(sb, op, "Auf einem anderen Gerät ist bereits ein Eintrag offen");
  if (neu.art === "ok" || neu.art === "wartet") return neu;

  // 3. Insert endgueltig gescheitert (Konflikt, Sperre, Fehler): eigenen
  // Abschluss zuruecknehmen, damit niemand ohne laufende Uhr dasteht. Nur die
  // eigene Zeit (fremde Aenderungen bleiben). Bei «wartet» kein Rollback — der
  // Wiederholungsversuch erkennt den Abschluss ueber gleicheZeit() als erledigt.
  const rb = await sb
    .from("time_entries")
    .update({ clock_out: null }, { count: "exact" })
    .eq("id", prev)
    .eq("clock_out", ende);
  if (rb.error || (rb.count ?? 0) === 0) {
    return {
      ...neu,
      fehler: `${neu.fehler} — der vorherige Eintrag (um ${formatTime(ende)} beendet) konnte nicht wieder geöffnet werden; bitte neu einstempeln oder Ticket «Stempel-Änderung»`,
    };
  }
  return neu;
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

/** Zaehler zuruecksetzen und einen geplanten Lauf abbrechen. Der Provider
 *  ruft das beim Unmount/uid-Wechsel (Logout, Nutzerwechsel im selben Tab) —
 *  der modul-globale Timer wuerde sonst die alte Sitzung ueberleben. */
export function backoffZuruecksetzen() {
  fehlschlaegeInFolge = 0;
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

/**
 * Gehoert die lokale Sitzung zum Nutzer der Reihe? getSession braucht kein
 * Netz, ausser das Token muss erneuert werden: scheitert das am Netz, bleibt
 * die Sitzung lokal erhalten → «unklar» (spaeter nochmals). «anderer» (ein
 * anderer Nutzer ist angemeldet) und «keine» (abgemeldet) → nicht senden:
 * mit fremdem oder anonymem JWT lehnt der Server ab, die Aktion waere mit
 * irrefuehrender Begruendung verloren.
 */
async function sitzungPruefen(sb: Sb, userId: string): Promise<"passt" | "anderer" | "keine" | "unklar"> {
  const { data, error } = await sb.auth.getSession();
  if (data.session) return data.session.user.id === userId ? "passt" : "anderer";
  return error && isAuthRetryableFetchError(error) ? "unklar" : "keine";
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
    if (ops.length === 0) return;
    // Ein Backoff-Lauf, der Logout/Nutzerwechsel ueberlebt hat, endet hier
    // (kein neuer Backoff) — die Reihe sendet nach dem naechsten Login.
    const sitzung = await sitzungPruefen(sb, userId);
    if (sitzung === "unklar") {
      planeBackoff(sb, userId);
      return;
    }
    if (sitzung === "anderer") return;
    for (const op of ops) {
      if (op.status === "konflikt" || op.status === "abgelehnt") return;
      if (sitzung === "keine") {
        // Abgemeldet: nicht anonym senden; der Offline-Streifen zeigt
        // «neu anmelden» (wie frueher beim 401 des anonymen Versuchs).
        await aktualisiereOp(op.op_id, { status: "wartet", last_error: SESSION_ABGELAUFEN });
        melde(false);
        return;
      }
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
      if (r.art === "abgelehnt" && r.fehler === LANG_ENDZEIT_FEHLT && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(STEMPEL_LANG_EVENT, { detail: { opId: aktuell.op_id } }));
      }
      return;
    }
  });
}

/**
 * Direkter Versand einer frisch eingereihten Aktion (online, leere Reihe):
 * gleiches Verhalten wie frueher — der Aufrufer bekommt das Server-Ergebnis.
 * Erfolg und endgueltige Fehler entfernen die Aktion aus der Reihe; nur
 * Netz-/Auth-Wartefaelle bleiben stehen und werden spaeter gesendet.
 * Gesendet wird nur, wenn die Aktion an der Spitze der Reihe steht (der
 * Aufrufer hat vielleicht einen veralteten Stand, oder ein zweiter Tab hat
 * inzwischen eingereiht) — sonst bleibt sie «wartet» und der normale Lauf
 * nimmt sie in Reihenfolge mit.
 */
export function sendeDirekt(sb: Sb, op: StempelOp): Promise<OpErgebnis> {
  return mitSperre(async () => {
    let spitze: StempelOp | undefined;
    try {
      spitze = (await ladeOps(op.user_id))[0];
    } catch {
      spitze = undefined;
    }
    if (spitze && spitze.op_id !== op.op_id) {
      void sendeAlle(sb, op.user_id);
      return { art: "wartet", fehler: "Wartet auf frühere Aktionen" };
    }

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

/**
 * Aktion ohne Endzeit (LANG_ENDZEIT_FEHLT) an ihrem Platz ergaenzen und die
 * Reihe weiter senden. `endzeit` = gewaehlte Endzeit (UTC-ISO), beim
 * Tarifwechsel das Ende des Vorgaengers.
 */
export async function endzeitNachtragen(sb: Sb, userId: string, opId: string, endzeit: string, begruendung: string): Promise<void> {
  const op = (await ladeOps(userId)).find((o) => o.op_id === opId);
  if (!op) return;
  await aktualisiereOp(opId, {
    payload: { ...op.payload, clock_out: endzeit, lang_begruendung: begruendung },
    status: "wartet",
    last_error: null,
  });
  melde(false);
  backoffZuruecksetzen();
  await sendeAlle(sb, userId);
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
