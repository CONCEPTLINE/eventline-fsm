// Klartext statt Datenbankfehler beim Schreiben von Stempeln (time_entries) —
// Lohn-Umbau Phase 4.
//
// EINE Stelle für alle Wege, die Stempel schreiben: Offline-Warteschlange
// (Handy und Desktop), Stempelzeiten (Desktop/Handy), Projekt-Zeit-Tabs,
// Rapport-Autostempel (Server), Ticket «Stempel-Änderung» (Anlegen und
// Genehmigen), Stempel-Antrag. Läuft auf Client und Server.
//
// Erkannt werden (Code + Meldung der Datenbank):
//   23P01  time_entries_keine_ueberlappung (Migration 368) → «überschneidet sich mit …»
//   P0001  «Stempel über 16 Stunden brauchen eine Begründung» (368)
//   P0001  «… betrifft abgerechnete Monate (ab TT.MM.JJJJ) — nur per Antrag …» (364/367)
//   P0001  «Stempel in abgerechneten Monaten sind nicht löschbar» (367)
//   P0001  apply_ticket «Zeitraum bereits abgerechnet» (215)
//   42501  RLS: Abrechnungssperre (214) oder fehlendes Recht
//   23505  time_entries_one_active_per_user (055)
//   23514  Kontext fehlt / Ende vor Beginn
// Muss schon VOR Migration 368 laufen: ohne die Regel kommt schlicht kein
// 23P01 — alle übrigen Meldungen gibt es heute schon.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isTimeEntryLocked, TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";

/** Grenze «sehr langer Stempel» für Client-Code. Gleiche Zahl wie
 *  STEMPEL_LANG_STUNDEN in src/lib/lohn/stempel-pruefung.ts und
 *  public.stempel_lang_grenze() (Migration 368). Hier nochmals, weil
 *  stempel-pruefung.ts den Lohn-Rechenkern nachzieht (gehört nicht ins
 *  Handy-Bundle); der Unit-Test hält beide gleich. */
export const LANG_STUNDEN = 16;
export const LANG_MS = LANG_STUNDEN * 60 * 60 * 1000;

/** Läuft/dauert ein Stempel über der Grenze? Offen = bis `jetzt`. */
export function istLang(clockIn: string, clockOut: string | null, jetzt: number = Date.now()): boolean {
  const von = Date.parse(clockIn);
  const bis = clockOut ? Date.parse(clockOut) : jetzt;
  return Number.isFinite(von) && Number.isFinite(bis) && bis - von > LANG_MS;
}

export interface DbFehlerLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export type StempelFehlerArt =
  | "ueberlappung"
  | "lang"
  | "antrag"
  | "nicht_loeschbar"
  | "ticket_gesperrt"
  | "gesperrt"
  | "berechtigung"
  | "doppelt_offen"
  | "lohnfelder"
  | "kontext_fehlt"
  | "ende_vor_beginn"
  | "nicht_gefunden"
  | "unbekannt";

/** Welcher Fall ist das? Reihenfolge: Code vor Text (Texte können sich ändern). */
export function stempelFehlerArt(e: DbFehlerLike | null | undefined): StempelFehlerArt {
  if (!e) return "unbekannt";
  const code = e.code ?? "";
  const m = `${e.message ?? ""} ${e.details ?? ""}`;
  if (code === "23P01" || /keine_ueberlappung/.test(m)) return "ueberlappung";
  if (/über 16 Stunden|ueber 16 Stunden|brauchen eine Begründung/i.test(m)) return "lang";
  if (/nur per Antrag/.test(m)) return "antrag";
  if (/nicht löschbar/.test(m)) return "nicht_loeschbar";
  if (/Zeitraum bereits abgerechnet/.test(m)) return "ticket_gesperrt";
  if (/«geprüft» und «Altfall»/.test(m)) return "lohnfelder";
  if (code === "23505" && /one_active/.test(m)) return "doppelt_offen";
  if (code === "23514" && /job_or_project_or_description/.test(m)) return "kontext_fehlt";
  if (code === "23514" && /clock_out_after_in/.test(m)) return "ende_vor_beginn";
  if (/time_entry not found/i.test(m)) return "nicht_gefunden";
  if (code === "42501" || /row-level security/i.test(m)) return "gesperrt";
  if (/forbidden/i.test(m)) return "berechtigung";
  return "unbekannt";
}

export interface UeberlappenderStempel {
  clock_in: string;
  clock_out: string | null;
}

/** Postgres-Zeitpunkt aus einer Fehlermeldung («2026-10-01 08:00:00+00») → ISO. */
function pgZeit(s: string): string | null {
  const t = s.trim().replace(/^"|"$/g, "");
  if (!t || /infinity/i.test(t)) return null;
  const iso = t.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Bestehender Stempel aus dem DETAIL der Ausschluss-Bedingung («conflicts with
 *  existing key (…)=(<user>, ["<von>","<bis>"))»). Fallback, wenn die Abfrage
 *  stempel_ueberlappung nicht geht. */
export function ueberlappungAusDetails(details: string | null | undefined): UeberlappenderStempel | null {
  if (!details) return null;
  const teil = details.split(/conflicts with existing key/i)[1];
  if (!teil) return null;
  const r = /\[\s*("?[^",\]]+"?)\s*,\s*("?[^",)\]]+"?)\s*[)\]]/.exec(teil);
  if (!r) return null;
  const von = pgZeit(r[1]);
  if (!von) return null;
  return { clock_in: von, clock_out: pgZeit(r[2]) };
}

const TAG = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit" });
const TAG_JAHR = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
const JAHR = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", year: "numeric" });
const ZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const TAG_ISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });

/** «20.10.» (mit Jahr, wenn nicht das laufende Jahr). */
export function stempelTag(iso: string, jetzt: Date = new Date()): string {
  const d = new Date(iso);
  return JAHR.format(d) === JAHR.format(jetzt) ? `${TAG.format(d)}` : TAG_JAHR.format(d);
}

export function stempelZeit(iso: string): string {
  return ZEIT.format(new Date(iso));
}

/** «vom 20.10. 07:00–10:00», «vom 20.10. 22:00 bis 21.10. 04:00», «seit 20.10. 07:00 (noch offen)». */
export function stempelSpanne(s: UeberlappenderStempel, jetzt: Date = new Date()): string {
  const von = `${stempelTag(s.clock_in, jetzt)} ${stempelZeit(s.clock_in)}`;
  if (!s.clock_out) return `seit ${von} (noch offen)`;
  const gleicherTag = TAG_ISO.format(new Date(s.clock_in)) === TAG_ISO.format(new Date(s.clock_out));
  return gleicherTag
    ? `vom ${von}–${stempelZeit(s.clock_out)}`
    : `vom ${von} bis ${stempelTag(s.clock_out, jetzt)} ${stempelZeit(s.clock_out)}`;
}

export interface MeldungOptionen {
  /** Wessen Stempel: leer = der eigene («deinem Stempel»), sonst Name der Person. */
  person?: string | null;
  /** Der überschneidende Stempel (aus stempel_ueberlappung bzw. den Details). */
  ueberlappung?: UeberlappenderStempel | null;
  /** Beginn des betroffenen Stempels — 42501 heisst nur dann «abgerechnet»,
   *  wenn dieser Zeitpunkt wirklich gesperrt ist. undefined = unbekannt (gesperrt). */
  zeitpunkt?: string | null;
  /** Hinweis auf Ticket «Stempel-Änderung» anhängen (Mitarbeitende).
   *  Standard: ja beim eigenen Stempel, nein bei fremden. */
  ticketHinweis?: boolean;
  /** Fallback-Text für Unbekanntes (Standard: Datenbankmeldung). */
  sonst?: string;
  jetzt?: Date;
}

const TICKET = "Ticket «Stempel-Änderung»";

function datumAusSperre(m: string): string | null {
  const t = /\(ab (\d{2}\.\d{2}\.\d{4})\)/.exec(m);
  return t ? t[1] : null;
}

/** Klartext zu einem Datenbankfehler beim Schreiben eines Stempels. */
export function stempelMeldung(e: DbFehlerLike | null | undefined, o: MeldungOptionen = {}): string {
  const eigen = !o.person;
  const ticket = o.ticketHinweis ?? eigen;
  const art = stempelFehlerArt(e);
  const msg = e?.message ?? "";
  switch (art) {
    case "ueberlappung": {
      const wem = eigen ? "deinem" : "dem";
      const von = eigen ? "" : ` von ${o.person}`;
      const mit = o.ueberlappung
        ? o.ueberlappung.clock_out
          ? `${wem} Stempel${von} ${stempelSpanne(o.ueberlappung, o.jetzt)}`
          : `${wem} offenen Stempel${von} ${stempelSpanne(o.ueberlappung, o.jetzt).replace(/ \(noch offen\)$/, "")}`
        : eigen ? "einem anderen Stempel von dir" : `einem anderen Stempel${von}`;
      return `Diese Zeit überschneidet sich mit ${mit}. Zwei Stempel gleichzeitig gehen nicht — bitte Zeiten prüfen${ticket ? ` oder ${TICKET}` : ""}.`;
    }
    case "lang":
      return `Dieser Stempel dauert über ${LANG_STUNDEN} Stunden — bitte die Endzeit prüfen. Stimmt sie, braucht es eine Begründung.`;
    case "antrag": {
      const ab = datumAusSperre(msg);
      return `Der Monat ist schon abgerechnet${ab ? ` (ab ${ab})` : ""} — Stempel ändern geht nur noch per Antrag über die Lohnverwaltung.${ticket ? ` Bitte ${TICKET} erfassen.` : ""}`;
    }
    case "nicht_loeschbar":
      return "Stempel in abgerechneten Monaten lassen sich nicht löschen — nur die Lohnverwaltung per Antrag.";
    case "ticket_gesperrt":
      return "Monat abgerechnet — nur die Lohnverwaltung per Antrag.";
    case "gesperrt": {
      const gesperrt = o.zeitpunkt === undefined || isTimeEntryLocked(o.zeitpunkt);
      if (!gesperrt) return "Keine Berechtigung — vom Server abgelehnt.";
      return `${TIME_ENTRY_LOCK_MESSAGE} — Änderungen nur noch per Antrag über die Lohnverwaltung.${ticket ? ` Bitte ${TICKET} erfassen.` : ""}`;
    }
    case "berechtigung":
      return "Keine Berechtigung — vom Server abgelehnt.";
    case "doppelt_offen":
      return eigen
        ? "Du bist schon eingestempelt (auf einem anderen Gerät oder am Computer). Zwei offene Stempel gehen nicht — zuerst dort ausstempeln."
        : `${o.person} hat schon einen offenen Stempel — zwei offene Stempel gehen nicht.`;
    case "lohnfelder":
      return "«Geprüft» setzt nur die Lohnverwaltung.";
    case "kontext_fehlt":
      return "Auftrag, Projekt oder Beschreibung fehlt.";
    case "ende_vor_beginn":
      return "Das Ende liegt vor dem Beginn.";
    case "nicht_gefunden":
      return "Der Stempel existiert nicht mehr (inzwischen gelöscht?).";
    default:
      return o.sonst ?? (msg || "Unbekannter Fehler");
  }
}

export interface FehlerKontext extends Omit<MeldungOptionen, "ueberlappung"> {
  /** Person des Stempels (für die Überschneidungs-Abfrage). */
  userId?: string | null;
  /** Zeitraum, der geschrieben werden sollte (offen = null). */
  von?: string | null;
  bis?: string | null;
  /** Bei Änderungen: der Stempel selbst (zählt nicht als Überschneidung). */
  ohneId?: string | null;
}

/**
 * Wie stempelMeldung, lädt bei einer Überschneidung aber den betroffenen
 * Stempel nach (RPC stempel_ueberlappung, Migration 367 — RLS gilt; sonst aus
 * den Fehler-Details). Wirft nie.
 */
export async function stempelFehlerText(sb: SupabaseClient, e: DbFehlerLike | null | undefined, k: FehlerKontext = {}): Promise<string> {
  let ueberlappung: UeberlappenderStempel | null = null;
  if (stempelFehlerArt(e) === "ueberlappung") {
    if (k.userId && k.von) {
      try {
        const { data } = await sb.rpc("stempel_ueberlappung", {
          p_user: k.userId,
          p_von: k.von,
          p_bis: k.bis ?? null,
          p_ohne: k.ohneId ?? null,
        });
        const z = (Array.isArray(data) ? data[0] : data) as UeberlappenderStempel | null | undefined;
        if (z?.clock_in) ueberlappung = { clock_in: z.clock_in, clock_out: z.clock_out ?? null };
      } catch {
        // Netz/alte Datenbank: Details reichen
      }
    }
    ueberlappung ??= ueberlappungAusDetails(e?.details);
  }
  return stempelMeldung(e, { ...k, ueberlappung });
}

/**
 * Vorab-Prüfung: überschneidet der Zeitraum einen anderen Stempel der Person?
 * null = frei (oder Prüfung nicht möglich — dann entscheidet die Datenbank).
 */
export async function findeUeberlappung(
  sb: SupabaseClient,
  k: { userId: string; von: string; bis: string | null; ohneId?: string | null },
): Promise<UeberlappenderStempel | null> {
  try {
    const { data, error } = await sb.rpc("stempel_ueberlappung", {
      p_user: k.userId,
      p_von: k.von,
      p_bis: k.bis,
      p_ohne: k.ohneId ?? null,
    });
    if (error) return null;
    const z = (Array.isArray(data) ? data[0] : data) as UeberlappenderStempel | null | undefined;
    return z?.clock_in ? { clock_in: z.clock_in, clock_out: z.clock_out ?? null } : null;
  } catch {
    return null;
  }
}

/** Meldung für eine vorab gefundene Überschneidung (gleicher Wortlaut wie 23P01). */
export function ueberlappungsMeldung(s: UeberlappenderStempel, o: Omit<MeldungOptionen, "ueberlappung"> = {}): string {
  return stempelMeldung({ code: "23P01" }, { ...o, ueberlappung: s });
}

/** «YYYY-MM-DD» + «HH:MM» als Zürcher Wandzeit → UTC-ISO (DST-sicher,
 *  unabhängig von der Zeitzone des Geräts). null bei ungültiger Eingabe. */
export function zuerichZuIso(datum: string, zeit: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datum);
  const z = /^(\d{2}):(\d{2})$/.exec(zeit);
  if (!d || !z || Number(z[1]) > 23 || Number(z[2]) > 59) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(z[1]), Number(z[2]));
  const teile = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const t = (n: string) => Number(teile.find((p) => p.type === n)?.value);
  const gesehen = Date.UTC(t("year"), t("month") - 1, t("day"), t("hour"), t("minute"));
  const ms = guess - (gesehen - guess);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** UTC-ISO → { datum: «YYYY-MM-DD», zeit: «HH:MM» } in Zürich. */
export function isoZuZuerich(iso: string): { datum: string; zeit: string } {
  const d = new Date(iso);
  return { datum: TAG_ISO.format(d), zeit: ZEIT.format(d) };
}

/**
 * Server (service_role): liegt einer der Zeitpunkte in einem gesperrten
 * Lohnmonat? lohn_tag_gesperrt (Migration 364: 5. des Folgemonats ODER
 * Lohnabrechnung schon erstellt), Rückfall is_time_entry_locked (214).
 * Wirft, wenn beides nicht geht — eine Sperr-Prüfung sagt nie still «frei».
 */
export async function istStempelGesperrt(admin: SupabaseClient, zeitpunkte: (string | null | undefined)[]): Promise<boolean> {
  for (const z of zeitpunkte) {
    if (!z) continue;
    const tag = TAG_ISO.format(new Date(z));
    const { data, error } = await admin.rpc("lohn_tag_gesperrt", { p_tabelle: "time_entries", p_tag: tag });
    if (!error) {
      if (data === true) return true;
      continue;
    }
    const r = await admin.rpc("is_time_entry_locked", { p_clock_in: z });
    if (r.error) throw new Error(`Sperr-Prüfung fehlgeschlagen: ${r.error.message}`);
    if (r.data === true) return true;
  }
  return false;
}

/** Ausstempeln eines offenen Stempels aus einem abgerechneten Monat. */
export function endeGesperrtMeldung(clockIn: string, jetzt: Date = new Date()): string {
  return `Monat abgerechnet — dein Stempel seit ${stempelTag(clockIn, jetzt)} ${stempelZeit(clockIn)} lässt sich nicht mehr ausstempeln. Das Ende setzt die Lohnverwaltung per Antrag: bitte ${TICKET} mit der Endzeit erfassen.`;
}
