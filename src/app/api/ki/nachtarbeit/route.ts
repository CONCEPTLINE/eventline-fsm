import { after, NextRequest, NextResponse } from "next/server";
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
  type NasVorschlagNeu,
  type NasVorschlagOffen,
  type NachtarbeitDaten,
  type NachtarbeitEingabe,
  type ZzBeschriebBasis,
  type ZzNachlesen,
} from "@/lib/ki/nachtarbeit";
import { quellPfade, sachSchluessel } from "@/lib/ki/fristen-sachverhalt";
import { rigAuthFehler } from "@/lib/ki/rig-auth";
import { istZweiterBlick } from "@/lib/ki/zweiter-blick";
import { verarbeiteZzWarteschlange } from "@/lib/ki/zz-warteschlange";
import type { FristStatus } from "@/lib/ki/typen";

// POST /api/ki/nachtarbeit — Ergebnisse der Nachtarbeit vom Rig
// (docs/lokale-ki/MASTERPLAN.md §3.6). Body { lauf_id, modell, vorschlaege[],
// fristen[] }, zusammen hoechstens 200 Eintraege, idempotent.
//   200 { success, angenommen, ersetzt, nachgelesen, zusammengefuehrt, doppelt, abgewiesen: [{ liste, index, grund }] }
//   (ersetzt: zz-Eintraege mit `rezept`, die einen offenen Vorschlag mit
//   anderem/keinem Rezept abgeloest haben — der alte wurde geloescht,
//   Migration 329; zaehlt zusaetzlich in angenommen)
//   (nachgelesen, 16.10.2026: zweiter Blick desselben Rezepts und Inhalts von
//   einem anderen lokalen Modell — die Zeile in nas_zz_beschriebe hinter dem
//   offenen Vorschlag bekommt den neuen Beschrieb und wartet wieder, die
//   Warteschlange ersetzt den Vorschlag nur, solange er offen und nie
//   entschieden ist; zaehlt zusaetzlich in angenommen. Dasselbe Modell
//   nochmals = doppelt, so bleibt die Route idempotent)
// zz-Eintraege MIT `beschrieb` und ohne ziel_ordner (Rig zz/v3) landen in
// der Warteschlange nas_zz_beschriebe (zaehlen in angenommen); nach der
// Antwort arbeitet after() die Warteschlange an (Claude, ~45 s Budget,
// lib/ki/zz-warteschlange) — der Rest kommt per Cron /api/cron/zz-entscheide.
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

// 60 s fuer die Antwort + ~45 s Warteschlange danach (after()).
export const maxDuration = 120;

/** Budget der Warteschlange nach der Antwort (after()). */
const ZZ_BUDGET_MS = 45_000;

type Admin = ReturnType<typeof createAdminClient>;

/** Stueckgroesse der In-Abfragen (lange Pfade, URL-Laenge). */
const STUECK = 20;

/** Zeilen in nas_zz_beschriebe, die nachgelesen werden duerfen: verarbeitet,
 *  wartend (z. B. Neuberechnung nach einer Rueckfrage) oder gescheitert —
 *  nie eine, die die Warteschlange gerade in Arbeit hat. */
const NACHLESBAR = ["fertig", "wartet", "fehler"] as const;

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
  const offen = new Map<string, NasVorschlagOffen>();
  const ausstehend = new Set<string>();
  const abgelehnt = new Set<string>();
  for (const teil of stuecke(pfadeAbfrage, STUECK)) {
    const { data, error } = await admin
      .from("nas_vorschlaege")
      .select("id, art, pfad, ziel_ordner, status, rezept")
      .in("pfad", teil)
      .or(`status.in.(offen,angenommen,korrigiert),and(status.eq.abgelehnt,entschieden_am.gte.${sperreSeit})`);
    if (error) throw new Error(`nas_vorschlaege: ${error.message}`);
    for (const v of data ?? []) {
      if (v.status === "abgelehnt") abgelehnt.add(sperrSchluessel(v.pfad as string, v.ziel_ordner as string));
      else if (v.status === "offen") offen.set(vorschlagSchluessel(v.art as string, v.pfad as string), { id: v.id as string, rezept: (v.rezept as string | null) ?? null });
      else ausstehend.add(vorschlagSchluessel(v.art as string, v.pfad as string));
    }
  }

  // Zweiter Blick (16.10.2026): von welchem lokalen Modell stammt der
  // Beschrieb hinter einem offenen «…+zb»-Vorschlag? (nachlesen; nie eine
  // Zeile, die gerade in Arbeit ist)
  const zbBasis = new Map<string, ZzBeschriebBasis>();
  const zbIds = [...offen.values()].filter((v) => istZweiterBlick(v.rezept)).map((v) => v.id);
  for (const teil of stuecke(zbIds, 50)) {
    const { data, error } = await admin
      .from("nas_zz_beschriebe")
      .select("id, vorschlag_id, sha256, modell")
      .in("vorschlag_id", teil)
      .in("status", [...NACHLESBAR]);
    if (error) throw new Error(`nas_zz_beschriebe (zweiter Blick): ${error.message}`);
    for (const b of (data ?? []) as { id: string; vorschlag_id: string; sha256: string | null; modell: string | null }[]) {
      if (!zbBasis.has(b.vorschlag_id)) zbBasis.set(b.vorschlag_id, { id: b.id, sha256: b.sha256, modell: b.modell });
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
    zbBasis,
    ausstehend,
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
async function fuegeEin(admin: Admin, tabelle: "nas_vorschlaege" | "ablage_fristen" | "nas_zz_beschriebe", zeilen: object[]): Promise<{ neu: number; doppelt: number }> {
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

/** Ersetzt offene Vorschlaege mit aelterem Rezept: der alte wird GELOESCHT
 *  (Mischa 2026-10-15), nur solange er offen und nie entschieden ist
 *  (bedingt, nur diese id). 0 Zeilen -> inzwischen entschieden: nichts
 *  einfuegen, zaehlt als doppelt. Danach die neue Zeile (der Unique-Index
 *  «offen je art+pfad» ist frei; ein gleichzeitiger Eintrag -> doppelt;
 *  ein anderer Fehler -> 500, das Rig liefert erneut). */
async function ersetzeVorschlaege(admin: Admin, ersetzen: { altId: string; zeile: NasVorschlagNeu }[]): Promise<{ ersetzt: number; doppelt: number }> {
  let ersetzt = 0;
  let doppelt = 0;
  for (const { altId, zeile } of ersetzen) {
    const { data, error } = await admin
      .from("nas_vorschlaege")
      .delete()
      .eq("id", altId)
      .eq("status", "offen")
      .is("entschieden_von", null)
      .select("id");
    if (error) throw new Error(`nas_vorschlaege (ersetzen): ${error.message}`);
    if (!data || data.length === 0) {
      doppelt++;
      continue;
    }
    const { error: iErr } = await admin.from("nas_vorschlaege").insert(zeile);
    if (!iErr) ersetzt++;
    else if (iErr.code === "23505") doppelt++;
    else throw new Error(`nas_vorschlaege: ${iErr.message}`);
  }
  return { ersetzt, doppelt };
}

/** Nachlesen (16.10.2026): die Zeile hinter dem offenen Vorschlag des zweiten
 *  Blicks bekommt den Beschrieb des anderen Modells und wartet wieder — nur,
 *  solange sie nicht in Arbeit ist und noch zu diesem Vorschlag gehoert
 *  (bedingt). Die Warteschlange ersetzt dann ihren eigenen offenen Vorschlag
 *  (Neuberechnung, bedingt: offen, nie entschieden). 0 Zeilen (gerade in
 *  Arbeit oder schon anders) -> doppelt. */
async function liesNach(admin: Admin, liste: ZzNachlesen[]): Promise<{ nachgelesen: number; doppelt: number }> {
  let nachgelesen = 0;
  let doppelt = 0;
  for (const n of liste) {
    const { data, error } = await admin
      .from("nas_zz_beschriebe")
      .update({
        beschrieb: n.beschrieb,
        fakten: n.fakten,
        kandidaten: n.kandidaten,
        ordner_ist: n.ordner_ist,
        lauf_id: n.lauf_id,
        modell: n.modell,
        status: "wartet",
        versuche: 0,
        fehler: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", n.id)
      .eq("vorschlag_id", n.vorschlag_id)
      .in("status", [...NACHLESBAR])
      .select("id");
    if (error) throw new Error(`nas_zz_beschriebe (nachlesen): ${error.message}`);
    if (data && data.length > 0) nachgelesen++;
    else doppelt++;
  }
  return { nachgelesen, doppelt };
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
    const r = await ersetzeVorschlaege(admin, pruefung.ersetzen);
    const b = await fuegeEin(admin, "nas_zz_beschriebe", pruefung.beschriebe);
    const n = await liesNach(admin, pruefung.nachlesen);
    const f = await fuegeEin(admin, "ablage_fristen", pruefung.fristen);
    await ergaenzeQuellen(admin, pruefung.fristErgaenzt);
    const antwort = {
      success: true,
      angenommen: v.neu + r.ersetzt + b.neu + n.nachgelesen + f.neu,
      ersetzt: r.ersetzt,
      nachgelesen: n.nachgelesen,
      zusammengefuehrt: pruefung.zusammengefuehrt,
      doppelt: pruefung.doppelt + v.doppelt + r.doppelt + b.doppelt + n.doppelt + f.doppelt,
      abgewiesen: pruefung.abgewiesen,
    };
    if (b.neu > 0 || n.nachgelesen > 0) {
      // Nach der Antwort: Warteschlange anarbeiten. Fehler nur loggen — der
      // Cron holt nach; zwei Laeufe gleichzeitig claimen je Zeile.
      after(async () => {
        try {
          await verarbeiteZzWarteschlange(createAdminClient(), { budgetMs: ZZ_BUDGET_MS, max: 20 });
        } catch (e) {
          logError("ki.nachtarbeit.zz", e);
        }
      });
    }
    return NextResponse.json(antwort);
  } catch (e) {
    logError("ki.nachtarbeit", e, { vorschlaege: eingabe.vorschlaege.length, fristen: eingabe.fristen.length });
    return NextResponse.json({ success: false, error: "Nachtarbeit konnte nicht übernommen werden" }, { status: 500 });
  }
}
