// Laedt den Technik-Stand fuer GET /api/technik/stand und den Cron
// technik-alarme (Vertrag §5, §6.2) — eine Ladefunktion fuer beide.
// Nur serverseitig mit dem Admin-Client (service_role); die Aufrufer
// pruefen vorher Admin bzw. CRON_SECRET.
//
// Datenschutz: ki_status.gpu wird nie gelesen (enthaelt den Kartennamen),
// ki_status.letzter_fehler auf 200 Zeichen gekuerzt.

import type { SupabaseClient } from "@supabase/supabase-js";
import { KI_ONLINE_FENSTER_MS } from "@/lib/ki/konstanten";
import { logError } from "@/lib/log";
import { bewerteAmpeln, gesamtAus } from "./ampeln";
import { ladeSteuerung } from "./steuerung";
import {
  BEREICH_DAUER_MS,
  BEREICH_SCHRITT_S,
  DIENST_NAMEN,
  EREIGNISSE_MAX,
  quelleVonSchluessel,
  REIHEN_SCHLUESSEL,
  type TechnikQuelle,
} from "./konstanten";
import type {
  Ampel,
  Bauteil,
  Bereich,
  DienstName,
  Ereignis,
  FsmStand,
  KiPaket,
  NasPaket,
  Reihen,
  RigPaket,
  Stufe,
  TechnikStand,
} from "./typen";

export interface ZustandZeile {
  schluessel: string;
  stufe: Stufe;
  seit: string;
  kritisch_seit: string | null;
  alarm_gesendet_am: string | null;
  alarm_offen: boolean;
}

export interface Grundlagen {
  rig: RigPaket | null;
  ki: KiPaket | null;
  nas: NasPaket | null;
  rig_am: string | null;
  ki_am: string | null;
  nas_am: string | null;
  fsm: FsmStand;
  abstuerze24h: Partial<Record<DienstName, number>>;
  zustaende: ZustandZeile[];
  /** Rohdaten fuer die Ereignisliste (nur Lese-API). */
  backupRuns: Array<{ id: string; status: string; reported_at: string }>;
  backupAlerts: Array<{ id: string; sent_at: string }>;
}

function pruefe<T>(res: { data: T; error: { message: string } | null }, was: string): T {
  if (res.error) throw new Error(`${was}: ${res.error.message}`);
  return res.data;
}

const DIENST_SET: ReadonlySet<string> = new Set(DIENST_NAMEN);

/** Alles, was Ampeln und Alarme brauchen — parallel, alle Abfragen klein. */
export async function ladeGrundlagen(admin: SupabaseClient, jetzt: Date): Promise<Grundlagen> {
  const jetztMs = jetzt.getTime();
  const vor = (ms: number) => new Date(jetztMs - ms).toISOString();

  const [
    standRes,
    zustaendeRes,
    abstuerzeRes,
    kiStatusRes,
    offenAnzahlRes,
    aeltesterRes,
    auftraege24Res,
    runsRes,
    alertsRes,
    syncRes,
    indexAnzahlRes,
    indexLetzterRes,
  ] = await Promise.all([
    admin.from("technik_stand").select("quelle, werte, gemessen_am"),
    admin.from("technik_zustaende").select("schluessel, stufe, seit, kritisch_seit, alarm_gesendet_am, alarm_offen"),
    admin
      .from("technik_ereignisse")
      .select("schluessel")
      .eq("art", "absturz")
      .gte("zeitpunkt", vor(24 * 3600_000))
      .limit(1000),
    admin.from("ki_status").select("letzter_poll, online_seit, version, letzter_fehler").eq("id", 1).maybeSingle(),
    admin.from("ki_auftraege").select("id", { count: "exact", head: true }).eq("status", "offen"),
    admin.from("ki_auftraege").select("created_at").eq("status", "offen").order("created_at", { ascending: true }).limit(1),
    admin.from("ki_auftraege").select("id", { count: "exact", head: true }).gte("created_at", vor(24 * 3600_000)),
    admin
      .from("nas_backup_runs")
      .select("id, status, reported_at, total_size, db_size, storage_size")
      .order("reported_at", { ascending: false })
      .limit(10),
    admin
      .from("nas_backup_alerts")
      .select("id, sent_at")
      .gte("sent_at", vor(7 * 24 * 3600_000))
      .order("sent_at", { ascending: false })
      .limit(100),
    admin.from("ablage_sync_status").select("letzter_poll, intervall_s").eq("id", 1).maybeSingle(),
    admin.from("ablage_datei_index").select("id", { count: "exact", head: true }),
    admin.from("ablage_datei_index").select("aktualisiert").order("aktualisiert", { ascending: false }).limit(1),
  ]);

  const stand = (pruefe(standRes, "technik_stand") ?? []) as Array<{ quelle: TechnikQuelle; werte: unknown; gemessen_am: string }>;
  const zeile = (q: TechnikQuelle) => stand.find((s) => s.quelle === q) ?? null;
  const rigZ = zeile("rig");
  const kiZ = zeile("ki");
  const nasZ = zeile("nas");

  const zustaende = (pruefe(zustaendeRes, "technik_zustaende") ?? []) as ZustandZeile[];

  const abstuerze24h: Partial<Record<DienstName, number>> = {};
  for (const r of (pruefe(abstuerzeRes, "technik_ereignisse") ?? []) as Array<{ schluessel: string | null }>) {
    const name = r.schluessel?.startsWith("dienst.") ? r.schluessel.slice(7) : null;
    if (name && DIENST_SET.has(name)) abstuerze24h[name as DienstName] = (abstuerze24h[name as DienstName] ?? 0) + 1;
  }

  const kiStatus = pruefe(kiStatusRes, "ki_status") as {
    letzter_poll: string | null; online_seit: string | null; version: string | null; letzter_fehler: string | null;
  } | null;
  if (offenAnzahlRes.error) throw new Error(`ki_auftraege: ${offenAnzahlRes.error.message}`);
  const aeltester = (pruefe(aeltesterRes, "ki_auftraege") ?? []) as Array<{ created_at: string }>;
  if (auftraege24Res.error) throw new Error(`ki_auftraege: ${auftraege24Res.error.message}`);
  const runs = (pruefe(runsRes, "nas_backup_runs") ?? []) as Array<{
    id: string; status: "ok" | "fehler"; reported_at: string; total_size: string | null; db_size: string | null; storage_size: string | null;
  }>;
  const alerts = (pruefe(alertsRes, "nas_backup_alerts") ?? []) as Array<{ id: string; sent_at: string }>;
  const sync = pruefe(syncRes, "ablage_sync_status") as { letzter_poll: string | null; intervall_s: number | null } | null;
  if (indexAnzahlRes.error) throw new Error(`ablage_datei_index: ${indexAnzahlRes.error.message}`);
  const indexLetzter = (pruefe(indexLetzterRes, "ablage_datei_index") ?? []) as Array<{ aktualisiert: string }>;

  const poll = kiStatus?.letzter_poll ?? null;
  const letzterOk = runs.find((r) => r.status === "ok") ?? null;
  const fsm: FsmStand = {
    ki_online: !!poll && jetztMs - Date.parse(poll) < KI_ONLINE_FENSTER_MS,
    ki_letzter_poll: poll,
    ki_online_seit: kiStatus?.online_seit ?? null,
    ki_version: kiStatus?.version ?? null,
    ki_letzter_fehler: kiStatus?.letzter_fehler ? kiStatus.letzter_fehler.slice(0, 200) : null,
    warteschlange_offen: offenAnzahlRes.count ?? 0,
    aeltester_offen_am: aeltester[0]?.created_at ?? null,
    auftraege_24h: auftraege24Res.count ?? 0,
    backup: {
      letzte_ok_am: letzterOk?.reported_at ?? null,
      letzte_meldung_am: runs[0]?.reported_at ?? null,
      letzte_status: runs[0]?.status ?? null,
      groesse_gesamt: letzterOk?.total_size ?? null,
      groesse_db: letzterOk?.db_size ?? null,
      groesse_dokumente: letzterOk?.storage_size ?? null,
      warnmails_7d: alerts.length,
      letzte_warnmail_am: alerts[0]?.sent_at ?? null,
      nie_gemeldet: runs.length === 0,
    },
    sync: { letzter_poll: sync?.letzter_poll ?? null, intervall_s: sync?.intervall_s ?? null },
    index: { letzter_scan: indexLetzter[0]?.aktualisiert ?? null, dateien: indexAnzahlRes.count ?? 0 },
  };

  return {
    rig: (rigZ?.werte as RigPaket | undefined) ?? null,
    ki: (kiZ?.werte as KiPaket | undefined) ?? null,
    nas: (nasZ?.werte as NasPaket | undefined) ?? null,
    rig_am: rigZ?.gemessen_am ?? null,
    ki_am: kiZ?.gemessen_am ?? null,
    nas_am: nasZ?.gemessen_am ?? null,
    fsm,
    abstuerze24h,
    zustaende,
    backupRuns: runs.map((r) => ({ id: r.id, status: r.status, reported_at: r.reported_at })),
    backupAlerts: alerts,
  };
}

/** Ampeln aus den Grundlagen; Hysterese gegen technik_zustaende, `seit` von dort. */
export function ampelnAus(g: Grundlagen, jetzt: Date): Ampel[] {
  const vorher: Record<string, Stufe> = {};
  const zMap = new Map(g.zustaende.map((z) => [z.schluessel, z]));
  for (const z of g.zustaende) vorher[z.schluessel] = z.stufe;
  const ampeln = bewerteAmpeln({
    jetzt,
    rig: g.rig,
    ki: g.ki,
    nas: g.nas,
    fsm: g.fsm,
    abstuerze24h: g.abstuerze24h,
    vorher,
    ki_gemessen_am: g.ki_am,
  });
  for (const a of ampeln) {
    const z = zMap.get(a.schluessel);
    a.seit = z && z.stufe === a.stufe ? z.seit : null;
  }
  return ampeln;
}

/** Die Seite fragt den Stand alle 15 s ab; die Leistung der KI (§2.6) holt sie getrennt ueber
 *  GET /api/technik/leistung — darum faellt der Block hier weg. */
function ohneLeistung(rig: RigPaket | null): RigPaket | null {
  if (!rig?.leistung) return rig;
  const kopie: RigPaket = { ...rig };
  delete kopie.leistung;
  return kopie;
}

function alterS(iso: string | null, jetztMs: number): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((jetztMs - Date.parse(iso)) / 1000));
}

/** Ereignisse im Zeitraum: eigene, abgeleitete aus der FSM-Sicherung, laufende kritische oben. */
function baueEreignisse(
  eigene: Array<{ id: string; zeitpunkt: string; art: Ereignis["art"]; stufe: Ereignis["stufe"]; bauteil: string | null; text: string }>,
  g: Grundlagen,
  ampeln: Ampel[],
  vonMs: number,
): Ereignis[] {
  const andauernd: Ereignis[] = ampeln
    .filter((a) => a.stufe === "kritisch")
    .map((a) => ({ id: `andauernd:${a.schluessel}`, zeitpunkt: null, stufe: "kritisch", art: "zustand", bauteil: a.bauteil, text: `${a.titel}: ${a.text}` }));

  const liste: Ereignis[] = eigene.map((e) => ({
    id: e.id,
    zeitpunkt: e.zeitpunkt,
    stufe: e.stufe,
    art: e.art,
    bauteil: (e.bauteil as Bauteil | null) ?? null,
    text: e.text,
  }));
  for (const r of g.backupRuns) {
    if (Date.parse(r.reported_at) < vonMs) continue;
    liste.push(r.status === "fehler"
      ? { id: `backup-lauf:${r.id}`, zeitpunkt: r.reported_at, stufe: "kritisch", art: "zustand", bauteil: "backup", text: "FSM-Sicherung aufs NAS fehlgeschlagen" }
      : { id: `backup-lauf:${r.id}`, zeitpunkt: r.reported_at, stufe: "gut", art: "hinweis", bauteil: "backup", text: "FSM-Sicherung aufs NAS erfolgreich gemeldet" });
  }
  for (const a of g.backupAlerts) {
    if (Date.parse(a.sent_at) < vonMs) continue;
    liste.push({ id: `backup-warnmail:${a.id}`, zeitpunkt: a.sent_at, stufe: "warnung", art: "alarm", bauteil: "backup", text: "Warn-Mail zur FSM-Sicherung an die Admins verschickt" });
  }
  liste.sort((a, b) => Date.parse(b.zeitpunkt ?? "") - Date.parse(a.zeitpunkt ?? ""));
  return [...andauernd, ...liste].slice(0, EREIGNISSE_MAX);
}

type ReiheZeile = { t: string; schluessel: string; mittel: number | null; spitze: number | null };

/**
 * Zeilengrenze der Supabase-API (PostgREST «max rows») je Antwort. Was darueber liegt, schneidet die API
 * STILL ab — technik_reihe() sortiert nach Zeit, also fehlten frueher alle spaeteren Stunden (Vorfall
 * 2026-10-14: Rig 6 h = 19 Schluessel x 356 Zeitpunkte = 6764 Zeilen, angekommen 1000 = die ersten ~53 min).
 */
export const API_ZEILEN_MAX = 1000;

/** Hoechstens so viele Zeitpunkte liefert technik_reihe() je Schluessel (+2: angeschnittene Rand-Buckets). */
export const zeitpunkteJeSchluessel = (bereich: Bereich) => Math.ceil(BEREICH_DAUER_MS[bereich] / 1000 / BEREICH_SCHRITT_S[bereich]) + 2;

/** Schluessel einer Quelle so auf Aufrufe verteilen, dass keine Antwort die API-Zeilengrenze erreicht. */
export function reihenBloecke(bereich: Bereich, schluessel: readonly string[]): string[][] {
  const jeAufruf = Math.max(1, Math.floor((API_ZEILEN_MAX - 1) / zeitpunkteJeSchluessel(bereich)));
  const bloecke: string[][] = [];
  for (let i = 0; i < schluessel.length; i += jeAufruf) bloecke.push(schluessel.slice(i, i + jeAufruf));
  return bloecke;
}

/** Kurven aus technik_reihe(); Luecken als [t, null, null] markiert. Exportiert fuer Tests. */
export async function ladeReihen(admin: SupabaseClient, bereich: Bereich, jetzt: Date): Promise<Reihen> {
  const schritt = BEREICH_SCHRITT_S[bereich];
  const bis = jetzt.toISOString();
  const von = new Date(jetzt.getTime() - BEREICH_DAUER_MS[bereich]).toISOString();
  const jeQuelle: Record<TechnikQuelle, string[]> = { rig: [], ki: [], nas: [] };
  for (const s of REIHEN_SCHLUESSEL) jeQuelle[quelleVonSchluessel(s)].push(s);

  // Je Quelle mehrere kleine Aufrufe (parallel) statt einem grossen, der an der Zeilengrenze abreisst.
  const aufrufe = (["rig", "ki", "nas"] as const).flatMap((q) =>
    reihenBloecke(bereich, jeQuelle[q]).map((block) =>
      admin.rpc("technik_reihe", { p_quelle: q, p_von: von, p_bis: bis, p_schritt_s: schritt, p_schluessel: block }),
    ),
  );
  const [neustartRes, ...reiheRes] = await Promise.all([
    admin
      .from("technik_ereignisse")
      .select("zeitpunkt")
      .eq("schluessel", "rig.neustart")
      .gte("zeitpunkt", von)
      .lte("zeitpunkt", bis)
      .order("zeitpunkt", { ascending: true })
      .limit(100),
    ...aufrufe,
  ]);

  const werte: Reihen["werte"] = {};
  for (const s of REIHEN_SCHLUESSEL) werte[s] = [];
  for (const res of reiheRes) {
    const zeilen = (pruefe(res as { data: unknown; error: { message: string } | null }, "technik_reihe") ?? []) as ReiheZeile[];
    // Nie still kappen: erreicht eine Antwort die Grenze, fehlt womoeglich etwas -> laut scheitern (Route: 500 + Log).
    if (zeilen.length >= API_ZEILEN_MAX) throw new Error(`technik_reihe: ${zeilen.length} Zeilen erreichen die API-Grenze, Kurven waeren abgeschnitten`);
    for (const z of zeilen) {
      if (!werte[z.schluessel]) continue;
      werte[z.schluessel].push([Date.parse(z.t), z.mittel === null ? null : Number(z.mittel), z.spitze === null ? null : Number(z.spitze)]);
    }
  }
  const schrittMs = schritt * 1000;
  for (const s of Object.keys(werte)) {
    const punkte = werte[s].sort((a, b) => a[0] - b[0]);
    const mitLuecken: Array<[number, number | null, number | null]> = [];
    for (let i = 0; i < punkte.length; i++) {
      if (i > 0 && punkte[i][0] - punkte[i - 1][0] > 2 * schrittMs) mitLuecken.push([punkte[i - 1][0] + schrittMs, null, null]);
      mitLuecken.push(punkte[i]);
    }
    werte[s] = mitLuecken;
  }
  const neustarts = ((pruefe(neustartRes as { data: unknown; error: { message: string } | null }, "technik_ereignisse") ?? []) as Array<{ zeitpunkt: string }>)
    .map((r) => new Date(r.zeitpunkt).toISOString());
  return { bereich, schritt_s: schritt, von, bis, werte, neustarts };
}

/** Antwort von GET /api/technik/stand. Wirft bei Datenbankfehlern (Route: 500). */
export async function ladeTechnikStand(
  admin: SupabaseClient,
  opts: { bereich: Bereich; reihen: boolean; jetzt?: Date },
): Promise<TechnikStand> {
  const jetzt = opts.jetzt ?? new Date();
  const jetztMs = jetzt.getTime();
  const vonMs = jetztMs - BEREICH_DAUER_MS[opts.bereich];

  const [g, eigeneRes, reihen, steuerung] = await Promise.all([
    ladeGrundlagen(admin, jetzt),
    admin
      .from("technik_ereignisse")
      .select("id, zeitpunkt, art, stufe, bauteil, text")
      .gte("zeitpunkt", new Date(vonMs).toISOString())
      .order("zeitpunkt", { ascending: false })
      .limit(EREIGNISSE_MAX),
    opts.reihen ? ladeReihen(admin, opts.bereich, jetzt) : Promise.resolve(null),
    // Nicht lesbar: die Seite zeigt den Umschalter gesperrt, der Rest des Stands bleibt nutzbar.
    ladeSteuerung(admin).catch((e: unknown) => {
      logError("technik.stand.steuerung", e);
      return null;
    }),
  ]);
  const eigene = (pruefe(eigeneRes, "technik_ereignisse") ?? []) as Parameters<typeof baueEreignisse>[0];

  const ampeln = ampelnAus(g, jetzt);
  return {
    success: true,
    jetzt: jetzt.toISOString(),
    hat_daten: !!(g.rig || g.ki || g.nas),
    gesamt: gesamtAus(ampeln),
    ampeln,
    rig: ohneLeistung(g.rig),
    rig_alter_s: alterS(g.rig?.gemessen_am ?? null, jetztMs),
    ki: g.ki,
    ki_alter_s: alterS(g.ki_am, jetztMs),
    nas: g.nas,
    nas_alter_s: alterS(g.nas?.gemessen_am ?? null, jetztMs),
    fsm: g.fsm,
    steuerung,
    ereignisse: baueEreignisse(eigene, g, ampeln, vonMs),
    reihen,
  };
}
