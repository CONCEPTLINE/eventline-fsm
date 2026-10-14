import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { KI_VORSCHLAG_SPERRE_TAGE } from "@/lib/ki/konstanten";
import { ladeAblageKontext, ladeAktiveOrdner, ladeIndexZeilenNfc, stuecke } from "@/lib/ki/kontext";
import { nfcZuRoh } from "@/lib/ki/pfade";
import {
  bezuegeDerEingabe,
  fristSchluesselItem,
  fristSchluesselPfad,
  fristSchluesselSha,
  leseNachtarbeitBody,
  pruefeNachtarbeit,
  sachverhalteDerEingabe,
  sperrSchluessel,
  vorschlagSchluessel,
  type FristSachverhaltBekannt,
  type NachtarbeitDaten,
  type NachtarbeitEingabe,
} from "@/lib/ki/nachtarbeit";
import { quellPfade, sachSchluessel } from "@/lib/ki/fristen-sachverhalt";
import { rigAuthFehler } from "@/lib/ki/rig-auth";
import type { FristStatus } from "@/lib/ki/typen";

// POST /api/ki/nachtarbeit — Ergebnisse der Nachtarbeit vom Rig
// (docs/lokale-ki/MASTERPLAN.md §3.6). Body { lauf_id, modell, vorschlaege[],
// fristen[] }, zusammen hoechstens 200 Eintraege, idempotent.
//   200 { success, angenommen, zusammengefuehrt, doppelt, abgewiesen: [{ liste, index, grund }] }
//   (zusammengefuehrt: Fristen, die als weiteres Dokument an eine gleiche
//   Frist — gleicher Sachverhalt + Datum, Migration 321 — gehaengt wurden)
//   400 Form/zu viele · 401/503 Auth · 500 → das Rig wiederholt (Backoff)
// Geprueft wird in lib/ki/nachtarbeit (rein): Pfad im Datei-Index, Ziel nur
// aus der AKTIVEN Ordnerliste und nie ZZ_*, Fristen-Datum rechnet das FSM
// (lib/ki/fristen). Geschrieben wird nur, was die Pruefung annimmt:
// nas_vorschlaege (status offen) und ablage_fristen (quelle ki, status
// vorschlag). Ein gleichzeitiger Doppel-Eintrag (Unique-Index) zaehlt als
// doppelt. Fehler-Logs nur mit Anzahlen — nie Pfade, Ordner oder
// Begruendungen.
// Auth: Bearer KI_SYNC_TOKEN.

export const maxDuration = 60;

type Admin = ReturnType<typeof createAdminClient>;

/** Stueckgroesse der In-Abfragen (lange Pfade, URL-Laenge). */
const STUECK = 20;

/** Postgres-Array-Literal fuer PostgREST `ov.` — jedes Element gequotet
 *  (Pfade koennen Kommas, Klammern und Anfuehrungszeichen enthalten;
 *  supabase-js quotet bei overlaps() nicht selbst). */
function pgTextArray(werte: readonly string[]): string {
  return `{${werte.map((w) => `"${w.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

async function ladeDaten(admin: Admin, eingabe: NachtarbeitEingabe, pfade: string[], shas: string[]): Promise<NachtarbeitDaten> {
  const kontext = await ladeAblageKontext(admin, { streng: true });
  // Ziele gegen ALLE aktiven Ordner pruefen (wie MP-7) — die 500er-Kappung
  // im Kontext gilt nur fuer die Liste, die das Modell sieht.
  const ordnerAktiv = nfcZuRoh(await ladeAktiveOrdner(admin));
  // `pfade` sind NFC (Rig); der Index speichert die Schreibweise der Platte.
  const indexVoll = await ladeIndexZeilenNfc(admin, pfade);
  const index = new Map([...indexVoll].map(([p, z]) => [p, { pfad: z.pfad, ordner_pfad: z.ordner_pfad, name: z.name }]));
  // Fuer Abfragen nach gespeicherten Pfaden: beide Schreibweisen.
  const pfadeAbfrage = [...new Set([...pfade, ...[...index.values()].map((z) => z.pfad)])];

  // Vorschlaege: offene, angenommene/korrigierte (die Verschiebung steht
  // noch aus — sonst kaeme dieselbe Datei jede Nacht neu, solange sie
  // haengt) und in den letzten 180 Tagen abgelehnte. Schluessel in NFC.
  const sperreSeit = new Date(Date.now() - KI_VORSCHLAG_SPERRE_TAGE * 86_400_000).toISOString();
  const offen = new Set<string>();
  const abgelehnt = new Set<string>();
  for (const teil of stuecke(pfadeAbfrage, STUECK)) {
    const { data, error } = await admin
      .from("nas_vorschlaege")
      .select("art, pfad, ziel_ordner, status")
      .in("pfad", teil)
      .or(`status.in.(offen,angenommen,korrigiert),and(status.eq.abgelehnt,entschieden_am.gte.${sperreSeit})`);
    if (error) throw new Error(`nas_vorschlaege: ${error.message}`);
    for (const v of data ?? []) {
      if (v.status === "abgelehnt") abgelehnt.add(sperrSchluessel(v.pfad as string, v.ziel_ordner as string));
      else offen.add(vorschlagSchluessel(v.art as string, v.pfad as string));
    }
  }

  // Ablage-Eintraege: per Inhalts-Hash (sha256 der Datei, upload-Route) und
  // per Pfad (ordner_pfad/abgelegt_name).
  const itemJePfad = new Map<string, string>();
  const itemsJeSha = new Map<string, string[]>();
  for (const teil of stuecke(shas, STUECK)) {
    const { data, error } = await admin.from("ablage_items").select("id, inhalt_hash").in("inhalt_hash", teil);
    if (error) throw new Error(`ablage_items (Hash): ${error.message}`);
    for (const it of data ?? []) {
      const sha = String(it.inhalt_hash).toLowerCase();
      itemsJeSha.set(sha, [...(itemsJeSha.get(sha) ?? []), it.id as string]);
    }
  }
  const namen = new Set(pfadeAbfrage.map((p) => p.slice(p.lastIndexOf("/") + 1)));
  const gesuchtePfade = new Set(pfade);
  for (const teil of stuecke([...namen], STUECK)) {
    const { data, error } = await admin.from("ablage_items").select("id, ordner_pfad, abgelegt_name").in("abgelegt_name", teil);
    if (error) throw new Error(`ablage_items (Pfad): ${error.message}`);
    for (const it of data ?? []) {
      const pfad = `${it.ordner_pfad}/${it.abgelegt_name}`.normalize("NFC");
      if (gesuchtePfade.has(pfad) && !itemJePfad.has(pfad)) itemJePfad.set(pfad, it.id as string);
    }
  }

  // Bekannte Fristen derselben Dateien (jede Art, jeder Status, jede Quelle).
  const fristen = new Set<string>();
  for (const teil of stuecke(pfadeAbfrage, STUECK)) {
    const { data, error } = await admin.from("ablage_fristen").select("pfad, datum").in("pfad", teil);
    if (error) throw new Error(`ablage_fristen (Pfad): ${error.message}`);
    for (const f of data ?? []) fristen.add(fristSchluesselPfad(f.pfad as string, f.datum as string));
    // Weitere Quell-Dokumente einer Frist (Migration 321) zaehlen genauso.
    const { data: weitere, error: wErr } = await admin
      .from("ablage_fristen")
      .select("weitere_pfade, datum")
      .overlaps("weitere_pfade", pgTextArray(teil));
    if (wErr) throw new Error(`ablage_fristen (weitere): ${wErr.message}`);
    for (const f of weitere ?? []) {
      for (const p of (f.weitere_pfade as string[] | null) ?? []) fristen.add(fristSchluesselPfad(p, f.datum as string));
    }
  }
  // Gleicher Sachverhalt (Art + Partei) aus anderen Dateien — jeder Status;
  // ein offener Vorschlag geht vor (dort kommen weitere Dokumente dazu).
  const sachverhalte = new Map<string, FristSachverhaltBekannt>();
  for (const teil of stuecke(sachverhalteDerEingabe(eingabe, kontext.namen_alle), STUECK)) {
    const { data, error } = await admin.from("ablage_fristen").select("id, sachverhalt, datum, status").in("sachverhalt", teil);
    if (error) throw new Error(`ablage_fristen (Sachverhalt): ${error.message}`);
    for (const f of data ?? []) {
      const k = sachSchluessel(f.sachverhalt as string, f.datum as string);
      if (!sachverhalte.has(k) || f.status === "vorschlag") sachverhalte.set(k, { id: f.id as string, status: f.status as FristStatus });
    }
  }
  // Per Inhalt (sha256): eine verschobene Datei hat einen neuen Pfad, aber
  // denselben Hash — eine dort verworfene Frist bleibt verworfen.
  for (const teil of stuecke(shas, STUECK)) {
    const { data, error } = await admin.from("ablage_fristen").select("sha256, datum").in("sha256", teil);
    if (error) throw new Error(`ablage_fristen (Hash): ${error.message}`);
    for (const f of data ?? []) fristen.add(fristSchluesselSha(f.sha256 as string, f.datum as string));
  }
  const itemIds = [...new Set([...itemJePfad.values(), ...[...itemsJeSha.values()].flat()])];
  for (const teil of stuecke(itemIds, 50)) {
    const { data, error } = await admin.from("ablage_fristen").select("ablage_item_id, datum").in("ablage_item_id", teil);
    if (error) throw new Error(`ablage_fristen (Ablage): ${error.message}`);
    for (const f of data ?? []) fristen.add(fristSchluesselItem(f.ablage_item_id as string, f.datum as string));
  }

  return {
    heute: kontext.heute,
    ordnerAktiv,
    namen: kontext.namen_alle,
    index,
    offen,
    abgelehnt,
    fristen,
    sachverhalte,
    itemJePfad,
    itemsJeSha,
  };
}

/** Weitere Quell-Dokumente an offene Vorschlaege haengen (gleicher
 *  Sachverhalt + Datum). Nur solange die Frist noch Vorschlag ist; ist sie
 *  inzwischen entschieden, bleibt sie, wie sie ist. */
async function ergaenzeQuellen(admin: Admin, ergaenzt: { id: string; pfad: string }[]): Promise<number> {
  const jeId = new Map<string, string[]>();
  for (const x of ergaenzt) jeId.set(x.id, [...(jeId.get(x.id) ?? []), x.pfad]);
  let n = 0;
  for (const [id, neu] of jeId) {
    const { data, error } = await admin.from("ablage_fristen").select("pfad, weitere_pfade").eq("id", id).eq("status", "vorschlag").maybeSingle();
    if (error) throw new Error(`ablage_fristen (Quellen): ${error.message}`);
    if (!data) continue;
    const vorher = (data.weitere_pfade as string[] | null) ?? [];
    const alle = quellPfade({ pfad: data.pfad as string | null, weitere_pfade: [...vorher, ...neu] });
    const weitere = data.pfad ? alle.slice(1) : alle;
    if (weitere.length === vorher.length) continue;
    const { error: uErr } = await admin.from("ablage_fristen").update({ weitere_pfade: weitere }).eq("id", id).eq("status", "vorschlag");
    if (uErr) throw new Error(`ablage_fristen (Quellen): ${uErr.message}`);
    n++;
  }
  return n;
}

/** Fuegt Zeilen ein. Verletzt ein Eintrag einen Unique-Index (gleichzeitig
 *  angelegt), wird einzeln nachgefahren: Konflikte zaehlen als doppelt,
 *  jeder andere Fehler wirft (500 -> das Rig wiederholt, idempotent). */
async function fuegeEin(admin: Admin, tabelle: "nas_vorschlaege" | "ablage_fristen", zeilen: object[]): Promise<{ neu: number; doppelt: number }> {
  if (zeilen.length === 0) return { neu: 0, doppelt: 0 };
  const { error } = await admin.from(tabelle).insert(zeilen);
  if (!error) return { neu: zeilen.length, doppelt: 0 };
  if (error.code !== "23505") throw new Error(`${tabelle}: ${error.message}`);
  let neu = 0;
  let doppelt = 0;
  for (const z of zeilen) {
    const { error: e } = await admin.from(tabelle).insert(z);
    if (!e) neu++;
    else if (e.code === "23505") doppelt++;
    else throw new Error(`${tabelle}: ${e.message}`);
  }
  return { neu, doppelt };
}

export async function POST(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;

  const body = await request.json().catch(() => null);
  const gelesen = leseNachtarbeitBody(body);
  if (!gelesen.ok) return NextResponse.json({ success: false, error: gelesen.fehler }, { status: 400 });
  const eingabe = gelesen.eingabe;

  try {
    const admin = createAdminClient();
    const { pfade, shas } = bezuegeDerEingabe(eingabe);
    const daten = await ladeDaten(admin, eingabe, pfade, shas);
    const pruefung = pruefeNachtarbeit(eingabe, daten);

    const v = await fuegeEin(admin, "nas_vorschlaege", pruefung.vorschlaege);
    const f = await fuegeEin(admin, "ablage_fristen", pruefung.fristen);
    await ergaenzeQuellen(admin, pruefung.fristErgaenzt);
    const antwort = {
      success: true,
      angenommen: v.neu + f.neu,
      zusammengefuehrt: pruefung.zusammengefuehrt,
      doppelt: pruefung.doppelt + v.doppelt + f.doppelt,
      abgewiesen: pruefung.abgewiesen,
    };
    return NextResponse.json(antwort);
  } catch (e) {
    logError("ki.nachtarbeit", e, { vorschlaege: eingabe.vorschlaege.length, fristen: eingabe.fristen.length });
    return NextResponse.json({ success: false, error: "Nachtarbeit konnte nicht übernommen werden" }, { status: 500 });
  }
}
