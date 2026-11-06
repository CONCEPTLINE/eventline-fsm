// Programmheft — liest das oeffentliche Veranstaltungsprogramm einer Location
// (vorerst nur Barakuba: https://www.barakuba.ch/veranstaltungen/) und
// gleicht es mit den Programm-Terminen im Standort-Kalender ab
// (standort_termine.quelle = 'programmheft', quelle_id = «<URL>#<YYYY-MM-DD>»;
// Migration 384, unique location_id+quelle_id).
//
// Mehrtägige Veranstaltungen (z. B. «Bränte» 06.–07.11.) sind je Abend ein
// eigener Programm-Termin mit derselben Zeit — nie ein durchgehender Block.
//
// Nur serverseitig (fetch). Aufbau der Seite (Stand 06.11.2026):
//   Liste: <div class="event__item"> <a href="2026/27/11/famiglia-rossi">
//          <time datetime="2026-11-27 00:00">…</time> [/ <time …> = letzter Tag]
//          <h2 class="event__title">Famiglia Rossi</h2>
//   Detail: erstes <p> nach <h3 class="card__title"> traegt die Zeiten,
//          z. B. «<strong>Bar</strong> ab 19h<br><strong>Konzert</strong> ca. 20h».
// Die Liste hat KEINE Uhrzeit — die kommt (best effort) aus der Detailseite:
// Beginn = letzte Zeit, die nicht zu «Bar / Abendkasse / Tür» gehoert. Fehlt
// sie, wird der Programm-Termin ganztaegig uebernommen. Ein Fehler auf einer
// Detailseite laesst nur deren Zeit weg, nie den Fund.
//
// Zeitlimit: 10 s fuer alles (Liste + Detailseiten zusammen).

import type { SupabaseClient } from "@supabase/supabase-js";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import { zeitenZuIso, type ProgrammFund, type ProgrammheftAntwort, type StandortKalenderInfo } from "@/lib/standort-kalender";

export const PROGRAMMHEFT_ZEITLIMIT_MS = 10_000;
const DETAIL_PARALLEL = 6;
const NOTIZ_MAX = 300;
/** Höchstens so viele Abende je Veranstaltung (lange Ausstellungen o. ä.). */
const TAGE_MAX = 31;
/** quelle_id = URL (≤ 300) + «#YYYY-MM-DD». */
const QUELLE_ID_MAX = 320;

/** Programmheft-Seite einer Location (nach Name); null = keines bekannt. */
export function programmheftQuelle(standortName: string | null | undefined): string | null {
  if (standortName && /^\s*barakuba/i.test(standortName)) return "https://www.barakuba.ch/veranstaltungen/";
  return null;
}

export class ProgrammheftFehler extends Error {}

/** Fund ohne Abgleich-Status — ein Abend einer Veranstaltung. */
export type ProgrammRoh = Omit<ProgrammFund, "status">;

/** Veranstaltung, wie sie in der Liste steht (mehrtägig: datum … bisDatum). */
export type ProgrammVeranstaltung = Omit<ProgrammRoh, "quelleId"> & {
  /** letzter Tag bei mehrtägigen, sonst null */
  bisDatum: string | null;
};

// ─── HTML-Helfer ─────────────────────────────────────────────────────────────

const ENTITAETEN: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…",
};

function entitaetenAufloesen(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITAETEN[e] ?? m;
  });
}

/** HTML-Ausschnitt → Klartext (br → «·»). */
function klartext(html: string): string {
  return entitaetenAufloesen(
    html
      .replace(/<br\s*\/?>/gi, " · ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .replace(/(\s*·\s*)+/g, " · ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .trim();
}

async function holen(url: string, signal: AbortSignal, redirect: RequestRedirect = "follow"): Promise<string> {
  const res = await fetch(url, {
    signal,
    cache: "no-store",
    redirect,
    headers: { "User-Agent": "EVENTLINE-Kalender/1.0 (+https://www.eventline-basel.com)", Accept: "text/html" },
  });
  if (!res.ok) throw new ProgrammheftFehler(`Die Seite antwortet mit HTTP ${res.status}`);
  return res.text();
}

// ─── Parser (rein, testbar) ──────────────────────────────────────────────────

/** Liste der Veranstaltungen aus dem HTML der Programm-Seite. */
export function programmListeParsen(html: string, seitenUrl: string): ProgrammVeranstaltung[] {
  const basisRoh = /<base\s+href="([^"]+)"/i.exec(html)?.[1];
  let basis = seitenUrl;
  try {
    if (basisRoh) basis = new URL(basisRoh, seitenUrl).toString();
  } catch {
    /* Seiten-URL bleibt Basis */
  }
  const out: ProgrammVeranstaltung[] = [];
  const gesehen = new Set<string>();
  const bloecke = html.split(/<div\s+class="event__item\b/i).slice(1);
  for (const block of bloecke) {
    const href = /<a\s[^>]*href="([^"]+)"/i.exec(block)?.[1];
    const titelHtml = /<h[1-3][^>]*class="[^"]*event__title[^"]*"[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(block)?.[1];
    const daten = [...block.matchAll(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/gi)].map((m) => m[1]);
    if (!href || !titelHtml || daten.length === 0) continue;
    let url: string;
    try {
      const u = new URL(entitaetenAufloesen(href), basis);
      u.hash = "";
      url = u.toString();
    } catch {
      continue;
    }
    if (url.length > 300 || gesehen.has(url)) continue;
    const titel = klartext(titelHtml).slice(0, 200);
    if (!titel) continue;
    gesehen.add(url);
    const datum = daten[0];
    const letzter = daten[daten.length - 1];
    out.push({ url, titel, datum, bisDatum: letzter > datum ? letzter : null, von: null, bis: null, notiz: null });
  }
  return out;
}

/** Je Abend ein Fund (gleiche Zeit/Notiz), quelleId «<url>#<YYYY-MM-DD>»; nur Tage ab `heute`. */
export function programmTage(veranstaltungen: readonly ProgrammVeranstaltung[], heute: string): ProgrammRoh[] {
  const out: ProgrammRoh[] = [];
  for (const v of veranstaltungen) {
    const letzter = v.bisDatum && v.bisDatum > v.datum ? v.bisDatum : v.datum;
    for (let i = 0, tag = v.datum; i < TAGE_MAX && tag <= letzter; i++, tag = plusTage(v.datum, i)) {
      if (tag < heute) continue;
      out.push({ quelleId: `${v.url}#${tag}`, url: v.url, titel: v.titel, datum: tag, von: v.von, bis: v.bis, notiz: v.notiz });
    }
  }
  return out;
}

/** Beginn + Kurztext aus einer Detailseite (erstes <p> nach card__title). */
export function programmDetailParsen(html: string): { von: string | null; notiz: string | null } {
  const nachTitel = /class="card__title"[^>]*>[\s\S]*?<\/h\d>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  if (!nachTitel) return { von: null, notiz: null };
  const text = klartext(nachTitel);
  if (!text) return { von: null, notiz: null };
  let von: string | null = null;
  let tuer: string | null = null;
  for (const teil of text.split(" · ")) {
    const m = /(?:^|[^\d])([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\s*(?:h\b|uhr\b)/i.exec(teil);
    if (!m) continue;
    const zeit = `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
    if (/^\s*(bar|abendkasse|tür|tuer|einlass|kasse)/i.test(teil)) tuer = zeit;
    else von = zeit;
  }
  return { von: von ?? tuer, notiz: text.slice(0, NOTIZ_MAX) };
}

/** Liegt `url` auf derselben Herkunft (Schema + Host + Port) wie `herkunft`? */
export function gleicheHerkunft(url: string, herkunft: string): boolean {
  try {
    return new URL(url).origin === herkunft;
  } catch {
    return false;
  }
}

/**
 * Programm einer Seite lesen: Liste + Detailseiten (Zeiten), nur kommende
 * Abende (>= heute, Zuerich), je Abend ein Fund. Wirft ProgrammheftFehler
 * mit Klartext (Zeitlimit, HTTP-Fehler, nichts gefunden).
 */
export async function programmheftLesen(quelle: string): Promise<ProgrammRoh[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROGRAMMHEFT_ZEITLIMIT_MS);
  try {
    let html: string;
    try {
      html = await holen(quelle, ctrl.signal);
    } catch (e) {
      if (e instanceof ProgrammheftFehler) throw e;
      if (ctrl.signal.aborted) throw new ProgrammheftFehler("Die Programm-Seite antwortet nicht (Zeitlimit 10 s)");
      throw new ProgrammheftFehler("Die Programm-Seite ist nicht erreichbar");
    }
    const heute = todayLocalIso();
    const liste = programmListeParsen(html, quelle).filter((f) => (f.bisDatum ?? f.datum) >= heute);
    if (liste.length === 0 && !/event__item/i.test(html)) {
      throw new ProgrammheftFehler("Auf der Programm-Seite wurden keine Veranstaltungen erkannt (Aufbau geändert?)");
    }
    // Detailseiten parallel (begrenzt); Fehler/Zeitlimit = Fund ohne Zeit.
    // Detailseiten nur auf derselben Website wie die Programm-Seite abrufen
    // (keine fremden Ziele aus dem HTML); Weiterleitung = Fund ohne Details.
    const herkunft = new URL(quelle).origin;
    const detail = liste.filter((f) => gleicheHerkunft(f.url, herkunft));
    let naechster = 0;
    const arbeiter = async () => {
      while (naechster < detail.length && !ctrl.signal.aborted) {
        const f = detail[naechster++];
        try {
          const d = programmDetailParsen(await holen(f.url, ctrl.signal, "manual"));
          f.von = d.von;
          f.notiz = d.notiz;
        } catch {
          /* ohne Zeit weiter */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_PARALLEL, detail.length) }, arbeiter));
    return programmTage(liste, heute);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Abgleich mit dem Kalender ───────────────────────────────────────────────

/** Werte eines Programm-Termins (standort_termine) aus einem Fund. */
export function fundZuTermin(f: ProgrammRoh): { titel: string; start_at: string; end_at: string | null; ganztaegig: boolean; notiz: string | null } | null {
  const z = zeitenZuIso(f.datum, !f.von, f.von, f.bis);
  if (!z) return null;
  return { titel: f.titel, start_at: z.start, end_at: z.ende, ganztaegig: !f.von, notiz: f.notiz };
}

interface ProgrammZeile {
  id: string;
  quelle_id: string;
  titel: string;
  start_at: string;
  end_at: string | null;
  ganztaegig: boolean;
  programm_manuell: boolean;
  ausgeblendet: boolean;
}

const gleicheZeit = (a: string | null, b: string | null) => (a == null || b == null ? a === b : Date.parse(a) === Date.parse(b));

function zustand(f: ProgrammRoh, da: ProgrammZeile | undefined): ProgrammFund["status"] {
  if (!da) return "neu";
  // Im Kalender geloescht bzw. von Hand geaendert: Abgleich fasst sie nicht an.
  if (da.ausgeblendet) return "ausgeblendet";
  if (da.programm_manuell) return "manuell";
  const w = fundZuTermin(f);
  if (!w) return "vorhanden";
  const gleich = da.titel === w.titel && gleicheZeit(da.start_at, w.start_at) && gleicheZeit(da.end_at, w.end_at) && da.ganztaegig === w.ganztaegig;
  return gleich ? "vorhanden" : "geaendert";
}

async function programmZeilenLaden(db: SupabaseClient, standortId: string, quelleIds: readonly string[]): Promise<Map<string, ProgrammZeile>> {
  const m = new Map<string, ProgrammZeile>();
  if (quelleIds.length === 0) return m;
  const { data, error } = await db
    .from("standort_termine")
    .select("id, quelle_id, titel, start_at, end_at, ganztaegig, programm_manuell, ausgeblendet")
    .eq("location_id", standortId)
    .eq("quelle", "programmheft")
    .in("quelle_id", [...quelleIds]);
  if (error) throw error;
  for (const z of (data ?? []) as ProgrammZeile[]) m.set(z.quelle_id, z);
  return m;
}

/** Funde mit Status neu / vorhanden / geaendert / manuell / ausgeblendet. Wirft bei DB-Fehler. */
export async function fundeAbgleichen(db: SupabaseClient, standortId: string, roh: readonly ProgrammRoh[]): Promise<ProgrammFund[]> {
  const da = await programmZeilenLaden(db, standortId, roh.map((f) => f.quelleId));
  return roh.map((f) => ({ ...f, status: zustand(f, da.get(f.quelleId)) }));
}

/**
 * Funde als Programm-Termine uebernehmen: neue anlegen, geaenderte
 * aktualisieren (nur Zeilen mit quelle = 'programmheft'), vorhandene sowie
 * von Hand geaenderte (programm_manuell) und ausgeblendete (im Kalender
 * geloeschte, Migration 386) unveraendert lassen; nichts loeschen. Setzt programmheft_abgeglichen_am.
 * Wirft bei DB-Fehler.
 */
export async function fundeUebernehmen(
  db: SupabaseClient,
  standortId: string,
  userId: string | null,
  funde: readonly ProgrammRoh[],
): Promise<{ neu: number; aktualisiert: number }> {
  const da = await programmZeilenLaden(db, standortId, funde.map((f) => f.quelleId));
  let neu = 0;
  let aktualisiert = 0;
  for (const f of funde) {
    const w = fundZuTermin(f);
    if (!w) continue;
    const z = da.get(f.quelleId);
    const st = zustand(f, z);
    if (st !== "neu" && st !== "geaendert") continue;
    if (z) {
      const { error } = await db
        .from("standort_termine")
        .update(w)
        .eq("id", z.id)
        .eq("location_id", standortId)
        .eq("quelle", "programmheft")
        // Gleichzeitig von Hand geaendert/geloescht? Dann nicht ueberschreiben.
        .eq("programm_manuell", false)
        .eq("ausgeblendet", false);
      if (error) throw error;
      aktualisiert += 1;
    } else {
      const { error } = await db
        .from("standort_termine")
        .insert({ ...w, location_id: standortId, quelle: "programmheft", quelle_id: f.quelleId, erstellt_von: userId });
      // 23505 = gleichzeitig schon angelegt (unique location_id+quelle_id) → zaehlt als vorhanden
      if (error && error.code !== "23505") throw error;
      if (!error) neu += 1;
    }
  }
  const { error } = await db
    .from("locations")
    .update({ programmheft_abgeglichen_am: new Date().toISOString() })
    .eq("id", standortId);
  if (error) throw error;
  return { neu, aktualisiert };
}

/** body { quelleIds: string[] } pruefen («<URL>#<Tag>», hoechstens 200, je ≤ 320 Zeichen). */
export function quelleIdsPruefen(roh: unknown): { ok: true; ids: string[] } | { ok: false; fehler: string } {
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;
  if (!Array.isArray(b.quelleIds) || b.quelleIds.length === 0) return { ok: false, fehler: "Keine Veranstaltung gewählt" };
  if (b.quelleIds.length > 200) return { ok: false, fehler: "Zu viele Veranstaltungen auf einmal" };
  if (!b.quelleIds.every((q) => typeof q === "string" && q.length > 0 && q.length <= QUELLE_ID_MAX)) {
    return { ok: false, fehler: "Ungültige Auswahl" };
  }
  return { ok: true, ids: [...new Set(b.quelleIds as string[])] };
}

// ─── Fuer die Routen (Partner + intern) ──────────────────────────────────────

/** GET …/programmheft: Website lesen + abgleichen. Wirft ProgrammheftFehler
 *  (kein Programmheft / Website-Problem) oder DB-Fehler. */
export async function programmheftStand(
  db: SupabaseClient,
  standort: Pick<StandortKalenderInfo, "id" | "name" | "programmheft_auto" | "programmheft_abgeglichen_am">,
): Promise<ProgrammheftAntwort> {
  const quelle = programmheftQuelle(standort.name);
  if (!quelle) throw new ProgrammheftFehler("Für diesen Standort ist kein Programmheft hinterlegt");
  const roh = await programmheftLesen(quelle);
  return {
    funde: await fundeAbgleichen(db, standort.id, roh),
    quelle,
    auto: standort.programmheft_auto,
    abgeglichenAm: standort.programmheft_abgeglichen_am,
  };
}

/** POST …/programmheft { quelleIds }: Website erneut lesen (nie den Daten des
 *  Clients trauen) und nur die gewaehlten Funde uebernehmen. */
export async function programmheftImport(
  db: SupabaseClient,
  standort: Pick<StandortKalenderInfo, "id" | "name">,
  userId: string | null,
  quelleIds: readonly string[],
): Promise<{ neu: number; aktualisiert: number; gefunden: number }> {
  const quelle = programmheftQuelle(standort.name);
  if (!quelle) throw new ProgrammheftFehler("Für diesen Standort ist kein Programmheft hinterlegt");
  const gewaehlt = new Set(quelleIds);
  const funde = (await programmheftLesen(quelle)).filter((f) => gewaehlt.has(f.quelleId));
  if (funde.length === 0) throw new ProgrammheftFehler("Die gewählten Veranstaltungen stehen nicht mehr im Programmheft");
  const r = await fundeUebernehmen(db, standort.id, userId, funde);
  return { ...r, gefunden: funde.length };
}

/** PATCH …/programmheft { auto } pruefen. */
export function autoPruefen(roh: unknown): boolean | null {
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;
  return typeof b.auto === "boolean" ? b.auto : null;
}
