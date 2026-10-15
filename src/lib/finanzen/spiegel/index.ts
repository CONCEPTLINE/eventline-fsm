// Bexio-Spiegel — Lauf-Verwaltung (Finanzen Welle 1).
//
// Ein Lauf (`finanzen.sync_laeufe`) arbeitet alle Entitäten SEQUENZIELL in
// der Reihenfolge SYNC_ENTITAETEN ab (ein Firmen-Rate-Limit bei Bexio),
// jede in eigenem try/catch: ein 403/404 (Scope/Modul fehlt, z. B. Journal)
// macht nur diese Entität «nicht verfügbar», nie den ganzen Lauf rot.
//
// Zeitbudget: SYNC_ZEITBUDGET_MS (240 s) ab Start — bexioJson(ctx, …) prüft
// vor jedem Bexio-Call die Frist UND reicht sie an bexioFinanzFetch durch
// (kein Call, Token-Refresh oder 429-Warten läuft über die Frist hinaus);
// upsertBloecke prüft sie je Block. Danach endet der Lauf sauber als
// 'teilweise' (Lambda maxDuration 300 s → nie ein Lambda-Kill mit
// hängendem 'laeuft'-Eintrag).
//
// Doppelstart: veraltete 'laeuft'-Zeilen (> SYNC_SPERRE_MS) werden zuerst
// auf 'abgebrochen' gesetzt; danach garantiert der Unique-Index
// sync_laeufe_ein_laufender, dass höchstens ein Lauf 'laeuft' — Insert-
// Fehler 23505 → SyncLaeuftFehler (409).
//
// Alle Schema-Zugriffe der Entitäten laufen über die Helfer in dieser Datei
// (upsertBloecke, loescheNichtGeliefert, loescheIds, …) — Plan-B-Kapselung
// (Spec F): fällt die PostgREST-Exposition weg, ändert sich nur db.ts und
// diese Helfer, nicht die Entitäten.
//
// Keine Beträge, Kundennamen oder Rechnungsnummern in logError-extra oder
// in sync_laeufe.ergebnis/fehler — nur Zählungen und Kurztexte.

import { finanzenDb, type FinanzenClient } from "@/lib/finanzen/db";
import {
  SYNC_ENTITAETEN,
  SYNC_SPERRE_MS,
  SYNC_ZEITBUDGET_MS,
  type SyncArt,
  type SyncEntitaet,
  type SyncEntitaetErgebnis,
  type SyncLaufErgebnis,
  type SyncLaufRow,
  type SyncStandRow,
  type SyncStatus,
} from "@/lib/finanzen/types";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { BexioAntwortFehler, ZeitbudgetFehler, istNichtVerfuegbar, pruefeFrist } from "./bexio-client";
import { syncKontakte } from "./kontakte";
import { syncWaehrungen } from "./waehrungen";
import { syncKonten, syncKontengruppen } from "./konten";
import { syncBankkonten } from "./bankkonten";
import { syncRechnungen } from "./rechnungen";
import { syncOfferten } from "./offerten";
import { syncLieferantenrechnungen } from "./lieferantenrechnungen";
import { syncJournal } from "./journal";

// =====================================================================
// Kontext + Fehler
// =====================================================================

export interface SyncKontext {
  db: FinanzenClient;
  lauf: { id: string; gestartet: string };
  stand: Partial<Record<SyncEntitaet, SyncStandRow>>;
  /** Schreibzeit (synced_at) dieses Laufs — nie vor lauf.gestartet. */
  jetzt: Date;
  /** Heutiges Datum YYYY-MM-DD in Zürich. */
  heute: string;
  /** Unix-ms: Start + SYNC_ZEITBUDGET_MS. Jede Entität ruft vor jedem Bexio-Call pruefeFrist(ctx). */
  frist: number;
  /** true = Wasserzeichen ignorieren (Neuaufbau), Delta-Zweig wird zum Vollabgleich. */
  voll: boolean;
}

/** Ein Lauf ist bereits aktiv (409 sync_laeuft). */
export class SyncLaeuftFehler extends Error {
  constructor() {
    super("Ein Abgleich läuft bereits");
    this.name = "SyncLaeuftFehler";
  }
}

/** Zeile in einer Spiegel-Tabelle, wie sie an PostgREST geht. */
export type SpiegelZeile = Record<string, unknown>;

const BLOCK = 200;

// =====================================================================
// Lesen (auch für die sync-status-Route von B4)
// =====================================================================

/** 'laeuft'-Eintrag jünger als SYNC_SPERRE_MS → der aktive Lauf, sonst null. */
export async function laufendenSyncFinden(db: FinanzenClient): Promise<SyncLaufRow | null> {
  const seit = new Date(Date.now() - SYNC_SPERRE_MS).toISOString();
  const { data, error } = await db
    .from("sync_laeufe")
    .select("*")
    .eq("status", "laeuft")
    .gt("gestartet", seit)
    .order("gestartet", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`sync_laeufe lesen fehlgeschlagen (${error.code ?? "?"})`);
  return (data as SyncLaufRow | null) ?? null;
}

/** Der zuletzt gestartete Lauf (jeder Status). */
export async function letztenSyncLaden(db: FinanzenClient): Promise<SyncLaufRow | null> {
  const { data, error } = await db
    .from("sync_laeufe")
    .select("*")
    .order("gestartet", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`sync_laeufe lesen fehlgeschlagen (${error.code ?? "?"})`);
  return (data as SyncLaufRow | null) ?? null;
}

/** Alle Wasserzeichen (eine Zeile je Entität, Reihenfolge SYNC_ENTITAETEN). */
export async function syncStandLaden(db: FinanzenClient): Promise<SyncStandRow[]> {
  const { data, error } = await db.from("sync_stand").select("*");
  if (error) throw new Error(`sync_stand lesen fehlgeschlagen (${error.code ?? "?"})`);
  const rows = (data ?? []) as SyncStandRow[];
  const reihenfolge = new Map<string, number>(SYNC_ENTITAETEN.map((e, i) => [e, i]));
  return rows.sort((a, b) => (reihenfolge.get(a.entitaet) ?? 99) - (reihenfolge.get(b.entitaet) ?? 99));
}

// =====================================================================
// Schreib-Helfer für die Entitäten (einzige Schema-Zugriffe der Entitäten)
// =====================================================================

/** Upsert in Blöcken à 200 (onConflict id), setzt synced_at = ctx.jetzt.
 *  Doppelte IDs innerhalb eines Laufs (Delta ∪ Offen-Suche) werden vorher
 *  zusammengeführt — Postgres lehnt «ON CONFLICT … cannot affect row a
 *  second time» sonst den ganzen Block ab. Liefert die Anzahl Zeilen.
 *  Vor jedem Block pruefeFrist (grosse Vollabgleiche wie das Journal
 *  schreiben hunderte Blöcke); Upserts sind idempotent, ein Abbruch
 *  hinterlässt nichts Kaputtes. */
export async function upsertBloecke(ctx: SyncKontext, tabelle: string, zeilen: SpiegelZeile[]): Promise<number> {
  const synced_at = ctx.jetzt.toISOString();
  const eindeutig = new Map<string, SpiegelZeile>();
  for (const z of zeilen) eindeutig.set(String(z.id), { ...z, synced_at });
  const liste = [...eindeutig.values()];
  for (let i = 0; i < liste.length; i += BLOCK) {
    pruefeFrist(ctx);
    const block = liste.slice(i, i + BLOCK);
    const { error } = await ctx.db.from(tabelle).upsert(block, { onConflict: "id" });
    if (error) throw dbFehler(`${tabelle} upsert`, error);
  }
  return liste.length;
}

/** Vollabgleich-Löschung: alles, was dieser Lauf NICHT geschrieben hat
 *  (synced_at < lauf.gestartet). Eine Query, keine URL-Grenze. NUR nach
 *  vollständigem Vollabgleich mit ≥ 1 gelieferter Zeile aufrufen. */
export async function loescheNichtGeliefert(ctx: SyncKontext, tabelle: string): Promise<void> {
  const { error } = await ctx.db.from(tabelle).delete().lt("synced_at", ctx.lauf.gestartet);
  if (error) throw dbFehler(`${tabelle} aufräumen`, error);
}

/** Gezielt IDs löschen (Blöcke à 200; Cascade räumt Kind-Tabellen). */
export async function loescheIds(ctx: SyncKontext, tabelle: string, ids: (number | string)[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BLOCK) {
    const { error } = await ctx.db.from(tabelle).delete().in("id", ids.slice(i, i + BLOCK));
    if (error) throw dbFehler(`${tabelle} löschen`, error);
  }
}

/** IDs des Spiegels, deren Spalte einen der Werte hat (negiert: keinen).
 *  Seitenweise à 1000 (PostgREST max_rows) — Verwaisten-Prüfung. */
export async function ladeIdsMitWerten(
  ctx: SyncKontext,
  tabelle: string,
  spalte: string,
  werte: readonly (number | string)[],
  negiert = false,
): Promise<(number | string)[]> {
  const ids: (number | string)[] = [];
  const seite = 1000;
  for (let von = 0; ; von += seite) {
    let q = ctx.db.from(tabelle).select("id").order("id", { ascending: true }).range(von, von + seite - 1);
    q = negiert ? q.not(spalte, "in", `(${werte.join(",")})`) : q.in(spalte, [...werte]);
    const { data, error } = await q;
    if (error) throw dbFehler(`${tabelle} IDs lesen`, error);
    const rows = (data ?? []) as { id: number | string }[];
    ids.push(...rows.map((r) => r.id));
    if (rows.length < seite) break;
  }
  return ids;
}

/** IDs nach Bedürftigkeit ordnen: Zeilen, deren Fortschrittsmarker
 *  (z. B. rechnungen.kinder_synced_at) null ist, zuerst, dann aufsteigend
 *  nach Marker (am längsten nicht geladen zuerst), bei Gleichstand nach id.
 *  Blöcke à 200 (URL-Grenze). IDs ohne Spiegel-Zeile gelten als nie
 *  geladen. Damit füllt sich ein N+1, das am Zeitbudget abbricht, über
 *  mehrere Läufe statt jeden Lauf dieselben ersten K zu bedienen. */
export async function sortiereNachStand<I extends number | string>(
  ctx: SyncKontext,
  tabelle: string,
  markerSpalte: string,
  ids: readonly I[],
): Promise<I[]> {
  const stand = new Map<string, string | null>();
  const spalten: string = `id, ${markerSpalte}`;
  for (let i = 0; i < ids.length; i += BLOCK) {
    const { data, error } = await ctx.db
      .from(tabelle)
      .select(spalten)
      .in("id", ids.slice(i, i + BLOCK));
    if (error) throw dbFehler(`${tabelle} Stand lesen`, error);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const m = r[markerSpalte];
      stand.set(String(r.id), typeof m === "string" ? m : null);
    }
  }
  const schluessel = (id: I) => stand.get(String(id)) ?? null;
  return [...ids].sort((a, b) => {
    const ma = schluessel(a);
    const mb = schluessel(b);
    if (ma === mb) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    if (ma === null) return -1;
    if (mb === null) return 1;
    return ma < mb ? -1 : 1;
  });
}

/** Kind-Zeilen eines Elternobjekts ersetzen (delete + insert) — Zahlungen,
 *  Mahnungen, Lieferanten-Zahlungen. */
export async function ersetzeKinder(
  ctx: SyncKontext,
  tabelle: string,
  elternSpalte: string,
  elternId: number | string,
  zeilen: SpiegelZeile[],
): Promise<void> {
  const { error: delErr } = await ctx.db.from(tabelle).delete().eq(elternSpalte, elternId);
  if (delErr) throw dbFehler(`${tabelle} leeren`, delErr);
  if (zeilen.length === 0) return;
  await upsertBloecke(ctx, tabelle, zeilen);
}

/** Einzelne Spalten einer Zeile setzen (z. B. rechnungen.mahnstufe). */
export async function setzeSpalten(
  ctx: SyncKontext,
  tabelle: string,
  id: number | string,
  werte: SpiegelZeile,
): Promise<void> {
  const { error } = await ctx.db.from(tabelle).update(werte).eq("id", id);
  if (error) throw dbFehler(`${tabelle} aktualisieren`, error);
}

/** Supabase-Fehler NIE serialisieren (DETAIL enthält bei Constraint-
 *  Verletzungen die ganze Zeile) — nur Code in den Text. */
function dbFehler(was: string, error: { code?: string | null; message?: string | null }): Error {
  return new Error(`${was} fehlgeschlagen (DB ${error.code ?? "?"})`);
}

// =====================================================================
// Lauf
// =====================================================================

const ENTITAET_LABEL: Record<SyncEntitaet, string> = {
  kontakte: "Kontakte",
  waehrungen: "Währungen",
  konten: "Kontenplan",
  kontengruppen: "Kontengruppen",
  bankkonten: "Bankkonten",
  rechnungen: "Rechnungen",
  offerten: "Offerten",
  lieferantenrechnungen: "Lieferantenrechnungen",
  journal: "Journal",
};

const ENTITAET_SYNC: Record<SyncEntitaet, (ctx: SyncKontext) => Promise<SyncEntitaetErgebnis>> = {
  kontakte: syncKontakte,
  waehrungen: syncWaehrungen,
  konten: syncKonten,
  kontengruppen: syncKontengruppen,
  bankkonten: syncBankkonten,
  rechnungen: syncRechnungen,
  offerten: syncOfferten,
  lieferantenrechnungen: syncLieferantenrechnungen,
  journal: syncJournal,
};

/** Fehler aus getValidAccessToken (bexio.ts): Verbindung fehlt / Vault leer /
 *  Refresh abgewiesen → der ganze Lauf ist sinnlos → status 'fehler'.
 *  Ebenso ein Bexio-401 (Token nach «Neu verbinden» auf einem anderen Gerät
 *  ungültig, Scope entzogen): sonst endete jede Entität mit «HTTP 401», der
 *  Lauf als 'teilweise', und der SyncKopf zeigte keinen Neu-verbinden-Link. */
function istVerbindungsFehler(e: unknown): boolean {
  if (e instanceof BexioAntwortFehler) return e.status === 401;
  if (!(e instanceof Error)) return false;
  return /verbunden|neu verbinden|Refresh-Token|Token-Refresh|Vault/i.test(e.message);
}

function kurz(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Führt einen kompletten Spiegel-Lauf aus. Wirft SyncLaeuftFehler, wenn
 *  bereits ein Lauf aktiv ist (auch beim Insert-Race 23505). */
export async function finanzenSyncAusfuehren(opts: {
  art: SyncArt;
  ausgeloestVon: string | null;
  voll?: boolean;
}): Promise<SyncLaufErgebnis> {
  const db = finanzenDb();
  const voll = opts.voll === true;

  // 1. Veraltete 'laeuft'-Zeilen (Lambda-Kill o. ä.) abräumen, dann Sperre.
  const veraltetVor = new Date(Date.now() - SYNC_SPERRE_MS).toISOString();
  const { error: abbrErr } = await db
    .from("sync_laeufe")
    .update({ status: "abgebrochen", beendet: new Date().toISOString(), fehler: "Lauf nicht beendet (Zeitüberschreitung)" })
    .eq("status", "laeuft")
    .lt("gestartet", veraltetVor);
  if (abbrErr) throw dbFehler("sync_laeufe abräumen", abbrErr);
  if (await laufendenSyncFinden(db)) throw new SyncLaeuftFehler();

  // 2. Lauf anlegen — Unique-Index sync_laeufe_ein_laufender fängt das Race.
  const startMs = Date.now();
  const { data: laufRow, error: insErr } = await db
    .from("sync_laeufe")
    .insert({ art: opts.art, ausgeloest_von: opts.ausgeloestVon, status: "laeuft" })
    .select("*")
    .single();
  if (insErr) {
    if (insErr.code === "23505") throw new SyncLaeuftFehler();
    throw dbFehler("sync_laeufe anlegen", insErr);
  }
  const lauf = laufRow as SyncLaufRow;

  // 3. Kontext.
  const stand: Partial<Record<SyncEntitaet, SyncStandRow>> = {};
  for (const s of await syncStandLaden(db)) stand[s.entitaet] = s;
  const gestartetMs = Date.parse(lauf.gestartet);
  const ctx: SyncKontext = {
    db,
    lauf: { id: lauf.id, gestartet: lauf.gestartet },
    stand,
    // synced_at nie vor lauf.gestartet (DB-Uhr, Mikrosekunden) — sonst
    // würde loescheNichtGeliefert die eigenen Zeilen treffen (Uhren-
    // Versatz). 1 s Marge deckt die Mikrosekunden-Rundung von Date.parse.
    jetzt: new Date(Math.max(Date.now(), Number.isFinite(gestartetMs) ? gestartetMs + 1000 : 0)),
    heute: todayLocalIso(),
    // Budget ab der lokal gemessenen Startzeit (Lambda-Uhr = die, gegen die
    // pruefeFrist vergleicht).
    frist: startMs + SYNC_ZEITBUDGET_MS,
    voll,
  };

  const ergebnisse: SyncEntitaetErgebnis[] = [];
  let laufStatus: SyncStatus = "ok";
  let laufFehler: string | null = null;

  try {
    // 4. Entitäten sequenziell.
    let budgetWeg = false;
    let verbindungWeg = false;
    for (const entitaet of SYNC_ENTITAETEN) {
      let ergebnis: SyncEntitaetErgebnis;
      if (verbindungWeg) {
        ergebnis = { entitaet, anzahl: 0, fehler: "übersprungen (Verbindung ungültig)", verfuegbar: true, wasserzeichen: null };
        ergebnisse.push(ergebnis);
        continue; // sync_stand unverändert lassen
      }
      if (budgetWeg) {
        ergebnis = { entitaet, anzahl: 0, fehler: "Zeitbudget erschöpft (übersprungen)", verfuegbar: true, wasserzeichen: null };
        ergebnisse.push(ergebnis);
        // sync_stand sonst unverändert lassen (verfuegbar eines früheren
        // 403/404 nicht überschreiben) — nur beim Journal den Hinweis
        // setzen, damit die Bankkonten-Seite die Salden als vorläufig zeigt.
        if (entitaet === "journal" && stand.journal?.verfuegbar !== false) {
          await journalHinweisSchreiben(db, "Journal unvollständig — Salden vorläufig");
        }
        continue;
      }
      try {
        ergebnis = await ENTITAET_SYNC[entitaet](ctx);
      } catch (e) {
        if (istNichtVerfuegbar(e)) {
          const status = (e as BexioAntwortFehler).status;
          ergebnis = { entitaet, anzahl: 0, fehler: `HTTP ${status}`, verfuegbar: false, wasserzeichen: null };
        } else if (e instanceof ZeitbudgetFehler) {
          budgetWeg = true;
          ergebnis = { entitaet, anzahl: 0, fehler: "Zeitbudget erschöpft", verfuegbar: true, wasserzeichen: null };
        } else if (istVerbindungsFehler(e)) {
          verbindungWeg = true;
          ergebnis = { entitaet, anzahl: 0, fehler: "Bexio-Verbindung ungültig", verfuegbar: true, wasserzeichen: null };
          logError("finanzen.sync.verbindung", e, { entitaet });
        } else {
          const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
          ergebnis = { entitaet, anzahl: 0, fehler: kurz(msg), verfuegbar: true, wasserzeichen: null };
          logError(`finanzen.sync.${entitaet}`, e, { entitaet });
        }
      }
      ergebnisse.push(ergebnis);
      if (verbindungWeg) continue;

      // 5. sync_stand je Entität.
      await standSchreiben(db, ergebnis, entitaet);
    }

    if (verbindungWeg) {
      laufStatus = "fehler";
      laufFehler = "Bexio-Verbindung ungültig — neu verbinden";
    } else {
      laufStatus = ergebnisse.every((r) => r.fehler === null) ? "ok" : "teilweise";
    }
  } catch (e) {
    laufStatus = "fehler";
    laufFehler = kurz(e instanceof Error ? e.message : "Unbekannter Fehler");
    await laufAbschliessen(db, lauf.id, laufStatus, laufFehler, ergebnisse);
    throw e;
  }

  // 6. Lauf abschliessen.
  const fertig = await laufAbschliessen(db, lauf.id, laufStatus, laufFehler, ergebnisse);
  return { lauf: fertig, entitaeten: ergebnisse };
}

async function standSchreiben(db: FinanzenClient, r: SyncEntitaetErgebnis, entitaet: SyncEntitaet): Promise<void> {
  const jetzt = new Date().toISOString();
  let hinweis: string | null = null;
  if (!r.verfuegbar) {
    const status = /HTTP (\d{3})/.exec(r.fehler ?? "")?.[1] ?? "?";
    hinweis = `Bexio antwortet ${status} — ${ENTITAET_LABEL[entitaet]} nicht verfügbar`;
  } else if (entitaet === "journal" && r.fehler && r.fehler.startsWith("Zeitbudget")) {
    hinweis = "Journal unvollständig — Salden vorläufig";
  }
  const zeile: SpiegelZeile = { entitaet, verfuegbar: r.verfuegbar, hinweis, updated_at: jetzt };
  if (r.wasserzeichen) zeile.wasserzeichen = r.wasserzeichen;
  if (r.fehler === null) zeile.letzter_erfolg = jetzt;
  const { error } = await db.from("sync_stand").upsert(zeile, { onConflict: "entitaet" });
  if (error) throw dbFehler("sync_stand schreiben", error);
}

/** Nur den Hinweis der Journal-Zeile setzen (verfuegbar/wasserzeichen/
 *  letzter_erfolg bleiben) — für den Zeitbudget-Übersprung. */
async function journalHinweisSchreiben(db: FinanzenClient, hinweis: string): Promise<void> {
  const { error } = await db
    .from("sync_stand")
    .update({ hinweis, updated_at: new Date().toISOString() })
    .eq("entitaet", "journal");
  if (error) throw dbFehler("sync_stand Hinweis schreiben", error);
}

async function laufAbschliessen(
  db: FinanzenClient,
  id: string,
  status: SyncStatus,
  fehler: string | null,
  ergebnisse: SyncEntitaetErgebnis[],
): Promise<SyncLaufRow> {
  const ergebnis: Partial<Record<SyncEntitaet, SyncEntitaetErgebnis>> = {};
  for (const r of ergebnisse) ergebnis[r.entitaet] = r;
  const { data, error } = await db
    .from("sync_laeufe")
    .update({ status, beendet: new Date().toISOString(), ergebnis, fehler })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw dbFehler("sync_laeufe abschliessen", error);
  return data as SyncLaufRow;
}
