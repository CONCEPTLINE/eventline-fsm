import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ladeAlleSeiten, utcNach, utcVor } from "@/lib/lohn/daten";
import { istMonatGesperrtDb } from "@/lib/lohn/abrechnung";
import { ladeStempelProbleme } from "@/lib/lohn/stempel-pruefung";
import { ladeLohnEinstellungen, nachLaufBis } from "@/lib/lohn/zugriff";
import { speichereBexioFassung } from "@/lib/lohn/fassung";
import { ladeAktuelleWahl, meldeNeueAbrechnung } from "@/lib/lohn/zustellung";
import { ARZTZEUGNIS_BUCKET } from "@/lib/krank-server";
import { arztzeugnisDateiname } from "@/lib/krank";
import { logError } from "@/lib/log";
import type { Ausgefuehrt } from "./aufruf";
import type { FlowAusweis } from "./ausweis";
import {
  abwesenheitFuerFlow,
  ARZTZEUGNIS_LINK_S,
  ARZTZEUGNIS_MAX_BYTES,
  arztzeugnisPfadPasst,
  interneProfile,
  mimeAusEndung,
  monatText,
  nachtraeglichGeaendert,
  vergleichAusMomentaufnahme,
  sha256Hex,
  zaehleUeberlappungen,
  type AbwesenheitenAnfrage,
  type AbwesenheitZeile,
  type ArztzeugnisDaten,
  type AblageAnfrage,
  type MomentaufnahmeRoh,
  type MonatsAnfrage,
  type Satz,
  type StempelAenderung,
} from "./regeln";

// Daten der Trust-flow-Schnittstelle (nur Server, Admin-Client). Antworten ohne
// Namen und ohne Stempel-IDs; Personen-ID ist die ERP-Profil-ID, die Trust flow
// in «Personal bearbeiten» zuordnet.

const STUECK = 150;
function inStuecken<T>(liste: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += STUECK) out.push(liste.slice(i, i + STUECK));
  return out;
}

interface AnstellungZeile {
  profile_id: string;
  eintritt: string;
  austritt: string | null;
}

/** Interne ERP-Profile unter den signierten IDs (unabhängig von Anstellung und «aktiv») — in Anfrage-Reihenfolge. */
export async function nurInterne(admin: SupabaseClient, ids: string[]): Promise<string[]> {
  const profile: { id: string; role: string | null }[] = [];
  for (const teil of inStuecken(ids)) {
    profile.push(...(await ladeAlleSeiten<{ id: string; role: string | null }>(
      (a, b) => admin.from("profiles").select("id, role").in("id", teil).order("id").range(a, b),
      "Profile",
    )));
  }
  return interneProfile(ids, profile);
}

/** ERP-Profile mit Lohn-Anstellung (lohn_anstellungen), die [von, bis] (lokale Tage) berührt — in Anfrage-Reihenfolge.
 *  Nur noch für /vergleich (Lohnmonate ≤ 2026-11, ERP-Momentaufnahmen). */
export async function mitAnstellung(admin: SupabaseClient, ids: string[], von: string, bis: string): Promise<string[]> {
  const zeilen: AnstellungZeile[] = [];
  for (const teil of inStuecken(ids)) {
    zeilen.push(...(await ladeAlleSeiten<AnstellungZeile>(
      (a, b) => admin.from("lohn_anstellungen").select("profile_id, eintritt, austritt").in("profile_id", teil).order("id").range(a, b),
      "Anstellungen",
    )));
  }
  const treffer = new Set(zeilen.filter((z) => z.eintritt <= bis && (z.austritt == null || z.austritt >= von)).map((z) => z.profile_id));
  return ids.filter((id) => treffer.has(id));
}

// ---------------------------------------------------------------------------
// POST /api/flow/stempel
// ---------------------------------------------------------------------------
export async function stempelAntwort(admin: SupabaseClient, a: MonatsAnfrage): Promise<Ausgefuehrt> {
  const monat = monatText(a.jahr, a.monat);
  // Personen: Trust flow bestimmt sie (eigene Anstellungen) und signiert sie in `profile`;
  // das ERP liefert jedes interne Profil davon — auch Ausgetretene (Entscheid Backoffice 30.10.).
  const [gesperrt, personen] = await Promise.all([istMonatGesperrtDb(admin, a.jahr, a.monat), nurInterne(admin, a.profile)]);

  type StempelZeile = { user_id: string; clock_in: string; clock_out: string | null; ueberlappung_altfall: boolean | null };
  type AenderungZeile = { profile_id: string; occurred_at: string; alt_in: string | null; alt_out: string | null; neu_in: string | null; neu_out: string | null };
  const stempel: StempelZeile[] = [];
  const aenderungen: AenderungZeile[] = [];
  for (const teil of inStuecken(personen)) {
    const [s, ae] = await Promise.all([
      // Genau die Stempel, die das ERP dem Kern für diesen Monat gibt (src/lib/lohn/daten.ts, monatsEingabe).
      ladeAlleSeiten<StempelZeile>(
        (x, y) => admin.from("time_entries").select("user_id, clock_in, clock_out, ueberlappung_altfall").in("user_id", teil)
          .gte("clock_in", utcVor(a.von)).lt("clock_in", utcNach(a.bis)).order("id").range(x, y),
        "Stempelzeiten",
      ),
      // Stempel-Änderungen nach der Sperre (Antrag/Notweg) — nur sie stehen für Stempel in lohn_aenderungen.
      ladeAlleSeiten<AenderungZeile>(
        (x, y) => admin.from("lohn_aenderungen")
          .select("profile_id, occurred_at, alt_in:alt->>clock_in, alt_out:alt->>clock_out, neu_in:neu->>clock_in, neu_out:neu->>clock_out")
          .eq("tabelle", "time_entries").in("quelle", ["antrag", "notweg"]).in("profile_id", teil)
          .gte("occurred_at", utcVor(a.von)).order("id").range(x, y),
        "Stempel-Änderungen",
      ),
    ]);
    stempel.push(...s);
    aenderungen.push(...ae);
  }
  const probleme = await ladeStempelProbleme(admin, personen, a.jahr, a.monat);

  const antwortPersonen = personen.map((id) => {
    const eigene = stempel
      .filter((s) => s.user_id === id)
      .sort((x, y) => new Date(x.clock_in).getTime() - new Date(y.clock_in).getTime()
        || (x.clock_out ? new Date(x.clock_out).getTime() : Infinity) - (y.clock_out ? new Date(y.clock_out).getTime() : Infinity));
    const p = probleme.get(id) ?? [];
    return {
      erp_profil_id: id,
      stempel: eigene.map((s) => ({ start: s.clock_in, ende: s.clock_out })),
      probleme: {
        offen: p.filter((x) => x.art === "offen").length,
        ueberlappend: zaehleUeberlappungen(eigene.map((s) => ({ start: s.clock_in, ende: s.clock_out, altfall: s.ueberlappung_altfall === true })), monat),
        lang_ungeprueft: p.filter((x) => x.art === "lang").length,
      },
    };
  });

  const aend: StempelAenderung[] = aenderungen.map((z) => ({
    profileId: z.profile_id,
    occurredAt: z.occurred_at,
    alt: z.alt_in ? { clock_in: z.alt_in, clock_out: z.alt_out } : null,
    neu: z.neu_in ? { clock_in: z.neu_in, clock_out: z.neu_out } : null,
  }));

  return {
    ok: true,
    geliefert: antwortPersonen.length,
    body: {
      monat_gesperrt: gesperrt,
      personen: antwortPersonen,
      nachtraeglich_geaendert: nachtraeglichGeaendert(aend, a.von.slice(0, 7), monat),
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/flow/vergleich (nur Lohnmonate ≤ 2026-11)
// ---------------------------------------------------------------------------
export async function vergleichAntwort(admin: SupabaseClient, a: MonatsAnfrage): Promise<Ausgefuehrt> {
  const [gesperrt, personen] = await Promise.all([istMonatGesperrtDb(admin, a.jahr, a.monat), mitAnstellung(admin, a.profile, a.von, a.bis)]);
  const zeilen: MomentaufnahmeRoh[] = [];
  for (const teil of inStuecken(personen)) {
    zeilen.push(...(await ladeAlleSeiten<MomentaufnahmeRoh>(
      (x, y) => admin.from("lohn_fassungen_gueltig")
        .select("profile_id, fassung, art, kern_version, pruefsumme, auszahlungsdatum, brutto, ahv_lohn, alv_lohn, uvg_lohn, uvg_art, " +
          "positionen:ergebnis->positionen, nbu:ergebnis->nbu, bisher:eingaben->kern->bisher")
        .eq("jahr", a.jahr).eq("monat", a.monat).in("profile_id", teil).order("profile_id").range(x, y) as unknown as PromiseLike<{ data: MomentaufnahmeRoh[] | null; error: { message: string } | null }>,
      "Momentaufnahmen",
    )));
  }
  const je = new Map(zeilen.map((z) => [z.profile_id, z]));
  const liste = personen.map((id) => {
    const m = je.get(id);
    return { erp_profil_id: id, momentaufnahme: m ? vergleichAusMomentaufnahme(m) : null };
  });
  return {
    ok: true,
    geliefert: liste.length,
    body: { monat: monatText(a.jahr, a.monat), monat_gesperrt: gesperrt, personen: liste },
  };
}

// ---------------------------------------------------------------------------
// POST /api/flow/lohnabrechnung (A5)
// ---------------------------------------------------------------------------
const ablehnen = (status: number, code: string, meldung: string): Ausgefuehrt => ({ ok: false, status, code, meldung });

export async function lohnabrechnungAblegen(
  admin: SupabaseClient,
  a: AblageAnfrage,
  pdf: Uint8Array,
  ausweis: FlowAusweis,
  abrufId: string,
): Promise<Ausgefuehrt> {
  // Person: internes ERP-Profil (kein Partner-/Lieferanten-Zugang), auch ausgetreten —
  // die Anstellungen führt Trust flow (Entscheid Backoffice 30.10.).
  if ((await nurInterne(admin, [a.profileId])).length === 0) {
    return ablehnen(422, "person_unbekannt", "Keine Mitarbeiterin / kein Mitarbeiter mit dieser ERP-Profil-ID.");
  }
  // Lohnabrechnung: nur Lohnmonate nach lauf_bis. Lohnausweis: das ERP stellt keine mehr aus (Prüfung Jahr in der DB).
  if (a.art === "lohnabrechnung") {
    const einst = await ladeLohnEinstellungen(admin);
    if (!nachLaufBis(einst.laufBis, { jahr: a.jahr, monat: a.monat as number })) {
      return ablehnen(422, "erp_monat", "Für diesen Lohnmonat rechnet das ERP — keine Lohnabrechnung aus Bexio.");
    }
  }

  // Aktuelle Zustell-Wahl der Person (vor dem Ablegen geladen: ein Ladefehler bricht ab, bevor etwas
  // gespeichert ist). Trust flow schickt «papier» und null (noch nicht gewählt) auf Papier.
  const zustellung = (await ladeAktuelleWahl(admin, a.profileId))?.wahl ?? null;

  const r = await speichereBexioFassung(admin, {
    profileId: a.profileId,
    docType: a.art,
    jahr: a.jahr,
    monat: a.monat,
    fassung: a.fassung,
    pdf,
    pdfSha256: a.sha256,
    flowAbrufId: abrufId,
    flowSub: ausweis.sub,
  });
  if (r.modus === "abgelehnt") return ablehnen(r.code === "erp_monat" || r.code === "erp_jahr" ? 422 : 409, r.code, r.meldung);
  if (r.modus === "vorhanden") {
    return { ok: true, geliefert: 0, body: { ok: true, modus: "vorhanden", dokument_id: r.id, erp_fassung: r.version, zustellung } };
  }
  // Wie bei ERP-Abrechnungen: «liegt bereit» an die Person (ohne Beträge), Zustellnachweis. Wirft nie.
  await meldeNeueAbrechnung(admin, {
    profileId: a.profileId,
    jahr: a.jahr,
    monat: a.monat,
    wageDocumentId: r.id,
    art: a.fassung > 1 ? "korrektur" : "regulaer",
    dokument: a.art,
  });
  return { ok: true, geliefert: 1, body: { ok: true, modus: "abgelegt", dokument_id: r.id, erp_fassung: r.version, zustellung } };
}

// ---------------------------------------------------------------------------
// POST /api/flow/saetze (Migration 377)
// ---------------------------------------------------------------------------

/** Rappen-genauer Vergleich (numeric(8,2) aus der DB kommt als Zahl oder Text). */
const gleich = (x: unknown, y: number) => Math.round(Number(x) * 100) === Math.round(y * 100);

export async function saetzeSpeichern(admin: SupabaseClient, saetze: Satz[]): Promise<Ausgefuehrt> {
  const ids = [...new Set(saetze.map((s) => s.profileId))];
  const intern = new Set(await nurInterne(admin, ids));
  const unbekannt = ids.filter((id) => !intern.has(id));
  if (unbekannt.length > 0) {
    return ablehnen(422, "person_unbekannt", `Keine Mitarbeiterin / kein Mitarbeiter mit diesen ERP-Profil-IDs: ${unbekannt.join(", ")}.`);
  }

  type Zeile = { profile_id: string; gueltig_ab: string; kosten_chf_h: unknown; netto_chf_h: unknown };
  const bisher: Zeile[] = [];
  for (const teil of inStuecken(ids)) {
    bisher.push(...(await ladeAlleSeiten<Zeile>(
      (x, y) => admin.from("personal_saetze").select("profile_id, gueltig_ab, kosten_chf_h, netto_chf_h")
        .in("profile_id", teil).in("gueltig_ab", [...new Set(saetze.map((s) => s.gueltigAb))]).order("id").range(x, y),
      "Personal-Sätze",
    )));
  }
  const je = new Map(bisher.map((z) => [`${z.profile_id}|${z.gueltig_ab}`, z]));
  const neu = saetze.filter((s) => {
    const z = je.get(`${s.profileId}|${s.gueltigAb}`);
    return !z || !gleich(z.kosten_chf_h, s.kostenChfH) || !gleich(z.netto_chf_h, s.nettoChfH);
  });
  if (neu.length > 0) {
    const jetzt = new Date().toISOString();
    const { error } = await admin.from("personal_saetze").upsert(
      neu.map((s) => ({
        profile_id: s.profileId,
        gueltig_ab: s.gueltigAb,
        kosten_chf_h: s.kostenChfH,
        netto_chf_h: s.nettoChfH,
        quelle: "trust-flow",
        updated_at: jetzt,
      })),
      { onConflict: "profile_id,gueltig_ab" },
    );
    if (error) throw new Error(`Personal-Sätze konnten nicht gespeichert werden: ${error.message}`);
  }
  return { ok: true, geliefert: neu.length, body: { ok: true, gespeichert: neu.length, unveraendert: saetze.length - neu.length } };
}

// ---------------------------------------------------------------------------
// POST /api/flow/abwesenheiten, /api/flow/arztzeugnis (Migration 380)
// ---------------------------------------------------------------------------

type ZeugnisZeile = AbwesenheitZeile & {
  arztzeugnis_dateiname: string | null;
  arztzeugnis_mime: string | null;
  arztzeugnis_groesse: number | string | null;
  arztzeugnis_sha256: string | null;
};
// Ohne note und decision_note (Freitext, evtl. Gesundheitsdaten) — sie verlassen das ERP nicht.
const ABWESENHEIT_SPALTEN = "id, user_id, type, status, start_date, end_date, ende_offen, created_at, approved_at, " +
  "arztzeugnis_pfad, arztzeugnis_hochgeladen_at, arztzeugnis_dateiname, arztzeugnis_mime, arztzeugnis_groesse, arztzeugnis_sha256";

/** Arztzeugnis aus dem privaten Bucket (nur Server). */
async function ladeZeugnisDatei(admin: SupabaseClient, pfad: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const { data, error } = await admin.storage.from(ARZTZEUGNIS_BUCKET).download(pfad);
  if (error || !data) throw new Error(`Arztzeugnis konnte nicht geladen werden: ${error?.message ?? "keine Datei"}`);
  return { bytes: new Uint8Array(await data.arrayBuffer()), mime: data.type };
}

/** Pfad des Zeugnisses, wenn er zur Abwesenheit passt (<user_id>/<time_off_id>/…); sonst null (laut im Log). */
function zeugnisPfad(z: ZeugnisZeile): string | null {
  if (!z.arztzeugnis_pfad) return null;
  if (arztzeugnisPfadPasst(z.arztzeugnis_pfad, z.user_id, z.id)) return z.arztzeugnis_pfad;
  logError("api.flow.arztzeugnis.pfad", new Error("Pfad des Arztzeugnisses passt nicht zur Abwesenheit"), { id: z.id });
  return null;
}

/** Gespeicherte Angaben zur Datei (seit Migration 380 beim Hochladen gesetzt), sonst null. */
function gespeicherteDaten(z: ZeugnisZeile): ArztzeugnisDaten | null {
  if (!z.arztzeugnis_sha256 || z.arztzeugnis_groesse == null || !z.arztzeugnis_mime || !z.arztzeugnis_dateiname) return null;
  return { dateiname: z.arztzeugnis_dateiname, mime: z.arztzeugnis_mime, groesse: Number(z.arztzeugnis_groesse), sha256: z.arztzeugnis_sha256 };
}

/** Angaben aus der Datei berechnen und nachtragen (Zeugnisse vor Migration 380) — nur solange es dieselbe Datei ist. */
async function datenNachtragen(
  admin: SupabaseClient,
  z: ZeugnisZeile,
  pfad: string,
  datei: { bytes: Uint8Array; mime: string },
): Promise<ArztzeugnisDaten> {
  const endung = (pfad.split(".").pop() ?? "").toLowerCase() || "bin";
  const mime = z.arztzeugnis_mime
    ?? (datei.mime && datei.mime !== "application/octet-stream" ? datei.mime.split(";")[0].trim() : mimeAusEndung(pfad));
  const daten: ArztzeugnisDaten = {
    dateiname: z.arztzeugnis_dateiname ?? arztzeugnisDateiname("", endung),
    mime,
    groesse: datei.bytes.byteLength,
    sha256: sha256Hex(datei.bytes),
  };
  const { error } = await admin.from("time_off")
    .update({ arztzeugnis_dateiname: daten.dateiname, arztzeugnis_mime: daten.mime, arztzeugnis_groesse: daten.groesse, arztzeugnis_sha256: daten.sha256 })
    .eq("id", z.id).eq("arztzeugnis_pfad", pfad).is("arztzeugnis_sha256", null);
  if (error) throw new Error(`Angaben zum Arztzeugnis konnten nicht gespeichert werden: ${error.message}`);
  return daten;
}

export async function abwesenheitenAntwort(admin: SupabaseClient, a: AbwesenheitenAnfrage): Promise<Ausgefuehrt> {
  // Personen wie /stempel: jedes interne ERP-Profil aus `profile` (auch ausgetretene).
  const personen = await nurInterne(admin, a.profile);
  const zeilen: ZeugnisZeile[] = [];
  for (const teil of inStuecken(personen)) {
    // Alle Abwesenheiten, die den Monat berühren (start_date/end_date sind Zürcher Kalendertage).
    zeilen.push(...(await ladeAlleSeiten<ZeugnisZeile>(
      (x, y) => admin.from("time_off").select(ABWESENHEIT_SPALTEN).in("user_id", teil)
        .lte("start_date", a.bis).gte("end_date", a.von).order("id").range(x, y) as unknown as PromiseLike<{ data: ZeugnisZeile[] | null; error: { message: string } | null }>,
      "Abwesenheiten",
    )));
  }
  const zeugnisse = new Map<string, ArztzeugnisDaten>();
  for (const z of zeilen) {
    const pfad = zeugnisPfad(z);
    if (!pfad) continue;
    zeugnisse.set(z.id, gespeicherteDaten(z) ?? (await datenNachtragen(admin, z, pfad, await ladeZeugnisDatei(admin, pfad))));
  }
  const liste = personen.map((id) => ({
    erp_profil_id: id,
    abwesenheiten: zeilen
      .filter((z) => z.user_id === id)
      .sort((x, y) => x.start_date.localeCompare(y.start_date) || x.end_date.localeCompare(y.end_date) || x.id.localeCompare(y.id))
      .map((z) => abwesenheitFuerFlow(z, zeugnisse.get(z.id) ?? null)),
  }));
  return { ok: true, geliefert: liste.length, body: { monat: monatText(a.jahr, a.monat), personen: liste } };
}

export async function arztzeugnisAntwort(admin: SupabaseClient, a: { timeOffId: string }): Promise<Ausgefuehrt> {
  const { data, error } = await admin.from("time_off").select(ABWESENHEIT_SPALTEN).eq("id", a.timeOffId).maybeSingle();
  if (error) throw new Error(`Abwesenheit konnte nicht geladen werden: ${error.message}`);
  const z = data as ZeugnisZeile | null;
  if (!z || (await nurInterne(admin, [z.user_id])).length === 0) {
    return ablehnen(404, "abwesenheit_unbekannt", "Keine Abwesenheit mit dieser ID.");
  }
  const pfad = zeugnisPfad(z);
  if (!pfad) return ablehnen(404, "kein_arztzeugnis", "Zu dieser Abwesenheit liegt kein Arztzeugnis vor.");

  const datei = await ladeZeugnisDatei(admin, pfad);
  if (datei.bytes.byteLength === 0 || datei.bytes.byteLength > ARZTZEUGNIS_MAX_BYTES) {
    throw new Error(`Arztzeugnis leer oder grösser als 10 MB (${datei.bytes.byteLength} Bytes).`);
  }
  const gespeichert = gespeicherteDaten(z);
  let daten: ArztzeugnisDaten;
  if (gespeichert) {
    // Unversehrtheit: die Datei muss der beim Hochladen gemerkten Prüfsumme entsprechen.
    if (sha256Hex(datei.bytes) !== gespeichert.sha256 || datei.bytes.byteLength !== gespeichert.groesse) {
      throw new Error("Arztzeugnis weicht von der beim Hochladen gespeicherten Prüfsumme ab.");
    }
    daten = gespeichert;
  } else {
    daten = await datenNachtragen(admin, z, pfad, datei);
  }

  // Datei nicht im Körper (Vercel nimmt nur ~4,5 MB Antwort an), sondern als kurzlebiger signierter Link;
  // Trust flow lädt sie selbst und prüft die sha256.
  const { data: link, error: lErr } = await admin.storage.from(ARZTZEUGNIS_BUCKET).createSignedUrl(pfad, ARZTZEUGNIS_LINK_S);
  if (lErr || !link?.signedUrl) throw new Error(`Link zum Arztzeugnis fehlgeschlagen: ${lErr?.message ?? "kein Link"}`);
  const gueltigBis = new Date(Date.now() + ARZTZEUGNIS_LINK_S * 1000).toISOString();

  // Erste Übergabe an Trust flow merken (Link ausgestellt; einmal je Datei, ein neues Zeugnis setzt sie zurück).
  // Gelöscht wird nichts.
  const { error: uErr } = await admin.from("time_off").update({ arztzeugnis_an_flow_at: new Date().toISOString() })
    .eq("id", z.id).eq("arztzeugnis_pfad", pfad).is("arztzeugnis_an_flow_at", null);
  if (uErr) throw new Error(`Übergabe konnte nicht vermerkt werden: ${uErr.message}`);

  return {
    ok: true,
    geliefert: 1,
    body: {
      ok: true,
      mime: daten.mime,
      dateiname: daten.dateiname,
      sha256: daten.sha256,
      groesse: daten.groesse,
      url: link.signedUrl,
      gueltig_bis: gueltigBis,
    },
  };
}
