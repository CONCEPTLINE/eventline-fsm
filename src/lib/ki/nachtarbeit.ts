// Pruef-Logik der Nachtarbeit (docs/lokale-ki/MASTERPLAN.md §3.6): was das
// Hauptmodell nachts auf dem Rig findet — Vorschlaege fuer den Rueckstau in
// den ZZ_*-Ordnern, «zweiter Blick» auf die Ablage des Tages und Fristen —,
// wird hier gegen den Datei-Index, die AKTIVE Ordnerliste und das schon
// Bekannte geprueft. Rein (kein I/O): die Route laedt die Daten und reicht
// sie hinein, schreibt danach nur, was hier angenommen wurde.
//
// Regeln (Vertrag):
//  - Pfad muss im Datei-Index stehen, ordner_ist dem Index-Ordner
//    entsprechen (sonst pfad_bewegt).
//  - zz nur fuer Dateien unter einem ZZ_*-Segment, nachpruefung nur fuer
//    andere und nur mit Ziel != Ist.
//  - Ziel und Alternativen: aktiver Ordner aus der Liste, nie ein ZZ_*-
//    Segment in irgendeiner Tiefe (die Liste enthaelt schon keine Ordner
//    unter inaktiven). Ungueltige Alternativen fallen still weg (max 2).
//  - Begruendung/Partei werden nochmals minimiert; in 06_PERSONAL fallen
//    sie ganz weg (zusaetzlich zur Regel auf dem Rig).
//  - Schon offen oder angenommen/korrigiert (Verschiebung steht aus) ->
//    doppelt; abgelehnt (180 Tage) mit gleichem Ziel -> abgelehnt_bekannt;
//    Frist mit gleichem Datum fuer dieselbe Datei (gleicher Pfad, gleicher
//    Ablage-Eintrag ODER gleicher Inhalt per sha256 — auch nach dem
//    Verschieben; jede Art, jeder Status, auch aus der Ablage) ->
//    frist_bekannt. Eine verworfene Frist wird so nie wiederbelebt.

import { minimiereText } from "./ablage-entscheid";
import { leseNasPfad } from "./bereinigen";
import { berechneFrist, FRIST_ART_LABEL, FRIST_ARTEN, leseDatum, type FristGrund } from "./fristen";
import { KI_ENTSCHEID_BEGRUENDUNG_MAX, KI_NACHTARBEIT_MAX_EINTRAEGE } from "./konstanten";
import type { FristArt, FristBedingungen, NasVorschlagArt, NasVorschlagQuelle, OrdnerSicherheit } from "./typen";

export type NachtarbeitListe = "vorschlaege" | "fristen";
export type NachtarbeitGrund =
  | "ungueltig"
  | "pfad_bewegt"
  | "kein_zz"
  | "ist_zz"
  | "ziel_ungueltig"
  | "ziel_gleich"
  | "abgelehnt_bekannt"
  | "frist_bekannt"
  | FristGrund;

export interface NachtarbeitAbweisung {
  liste: NachtarbeitListe;
  index: number;
  grund: NachtarbeitGrund;
}

/** Gepruefter Body von POST /api/ki/nachtarbeit (Listen noch roh). */
export interface NachtarbeitEingabe {
  lauf_id: string | null;
  modell: string | null;
  vorschlaege: unknown[];
  fristen: unknown[];
}

/** Zeile fuer nas_vorschlaege (Migration 303). */
export interface NasVorschlagNeu {
  art: NasVorschlagArt;
  pfad: string;
  sha256: string | null;
  ordner_ist: string;
  ziel_ordner: string;
  alternativen: string[];
  sicherheit: OrdnerSicherheit;
  quelle: NasVorschlagQuelle;
  begruendung: string | null;
  modell: string | null;
  lauf_id: string | null;
}

/** Zeile fuer ablage_fristen (Migration 304) — immer quelle ki, status vorschlag. */
export interface FristNeu {
  ablage_item_id: string | null;
  pfad: string;
  sha256: string | null;
  art: FristArt;
  datum: string;
  bezeichnung: string;
  grundlage: FristBedingungen;
  quelle: "ki";
  status: "vorschlag";
  sicherheit: OrdnerSicherheit | null;
}

/** Was die Route aus der Datenbank laedt. */
export interface NachtarbeitDaten {
  heute: string;
  /** Aktive Zielordner (ladeAblageKontext, ohne Ordner unter inaktiven). */
  ordnerAktiv: ReadonlySet<string>;
  /** Namen aller Profile fuer die Minimierung. */
  namen: readonly string[];
  /** Datei-Index: pfad -> Ordner und Dateiname. */
  index: ReadonlyMap<string, { ordner_pfad: string; name: string }>;
  /** Offene sowie angenommene/korrigierte (Verschiebung steht noch aus)
   *  Vorschlaege als vorschlagSchluessel(art, pfad). */
  offen: ReadonlySet<string>;
  /** Abgelehnt in den letzten 180 Tagen als sperrSchluessel(pfad, ziel). */
  abgelehnt: ReadonlySet<string>;
  /** Bekannte Fristen als fristSchluesselPfad/fristSchluesselItem/fristSchluesselSha. */
  fristen: ReadonlySet<string>;
  /** Ablage-Eintrag je Pfad (ordner_pfad/abgelegt_name). */
  itemJePfad: ReadonlyMap<string, string>;
  /** Ablage-Eintraege je Inhalts-Hash (sha256). */
  itemsJeSha: ReadonlyMap<string, readonly string[]>;
}

export interface NachtarbeitPruefung {
  vorschlaege: NasVorschlagNeu[];
  fristen: FristNeu[];
  doppelt: number;
  abgewiesen: NachtarbeitAbweisung[];
}

export const vorschlagSchluessel = (art: string, pfad: string) => `${art}\u0000${pfad}`;
export const sperrSchluessel = (pfad: string, ziel: string) => `${pfad}\u0000${ziel}`;
export const fristSchluesselPfad = (pfad: string, datum: string) => `p\u0000${pfad}\u0000${datum}`;
export const fristSchluesselItem = (itemId: string, datum: string) => `i\u0000${itemId}\u0000${datum}`;
export const fristSchluesselSha = (sha256: string, datum: string) => `s\u0000${sha256.toLowerCase()}\u0000${datum}`;

const SICHERHEITEN: readonly OrdnerSicherheit[] = ["hoch", "mittel", "niedrig"];
const QUELLEN: readonly NasVorschlagQuelle[] = ["regel", "vorbild", "modell"];
const SHA_RE = /^[0-9a-f]{64}$/i;
const PARTEI_MAX = 60;
const BEZEICHNUNG_MAX = 120;

function istObjekt(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function kurzText(roh: unknown, max: number): string | null {
  return typeof roh === "string" && roh.trim() ? roh.trim().slice(0, max) : null;
}

/** Hat der ORDNER-Pfad irgendwo ein ZZ_*-Segment (jede Tiefe)? */
export function hatZzSegment(ordner: string): boolean {
  return ordner.split("/").some((s) => /^zz_/i.test(s));
}

/** Personalakten-Bereich: dort gehen keine Freitexte nach Supabase. */
export function istPersonalPfad(pfad: string): boolean {
  return /^06_PERSONAL(\/|$)/i.test(pfad);
}

/** Ordnerpfad vom Rig (Ziel/Alternative): normalisiert, sonst null. */
function leseOrdner(roh: unknown): string | null {
  return typeof roh === "string" ? leseNasPfad(roh) : null;
}

/** Body pruefen: Listen (fehlend = leer), zusammen hoechstens 200 Eintraege. */
export function leseNachtarbeitBody(body: unknown): { ok: true; eingabe: NachtarbeitEingabe } | { ok: false; fehler: string } {
  if (!istObjekt(body)) return { ok: false, fehler: "Body fehlt" };
  const vorschlaege = body.vorschlaege ?? [];
  const fristen = body.fristen ?? [];
  if (!Array.isArray(vorschlaege) || !Array.isArray(fristen)) return { ok: false, fehler: "vorschlaege/fristen müssen Listen sein" };
  if (vorschlaege.length + fristen.length > KI_NACHTARBEIT_MAX_EINTRAEGE) {
    return { ok: false, fehler: `Höchstens ${KI_NACHTARBEIT_MAX_EINTRAEGE} Einträge pro Aufruf` };
  }
  return {
    ok: true,
    eingabe: { lauf_id: kurzText(body.lauf_id, 80), modell: kurzText(body.modell, 80), vorschlaege, fristen },
  };
}

/** Alle gueltigen Pfade und sha256 der Eingabe — damit die Route nur die
 *  noetigen Index-/Ablage-/Fristen-Zeilen laedt. */
export function bezuegeDerEingabe(e: NachtarbeitEingabe): { pfade: string[]; shas: string[] } {
  const pfade = new Set<string>();
  const shas = new Set<string>();
  for (const x of [...e.vorschlaege, ...e.fristen]) {
    if (!istObjekt(x)) continue;
    const pfad = leseNasPfad(x.pfad);
    if (pfad) pfade.add(pfad);
    if (typeof x.sha256 === "string" && SHA_RE.test(x.sha256)) shas.add(x.sha256.toLowerCase());
  }
  return { pfade: [...pfade], shas: [...shas] };
}

function leseSha(roh: unknown): string | null {
  return typeof roh === "string" && SHA_RE.test(roh) ? roh.toLowerCase() : null;
}

/** Ganzzahl in [min, max] oder null; `undefined` = ungueltig. */
function leseZahl(roh: unknown, min: number, max: number): number | null | undefined {
  if (roh === null || roh === undefined) return null;
  return typeof roh === "number" && Number.isInteger(roh) && roh >= min && roh <= max ? roh : undefined;
}

/** Datum oder null; `undefined` = ungueltig. */
function leseDatumFeld(roh: unknown): string | null | undefined {
  if (roh === null || roh === undefined) return null;
  return leseDatum(roh) ?? undefined;
}

/** Bedingungen streng lesen — ein ungueltiges Feld verwirft die Frist. */
export function leseBedingungen(roh: unknown): FristBedingungen | null {
  if (!istObjekt(roh)) return null;
  const beginn = leseDatumFeld(roh.beginn);
  const ende = leseDatumFeld(roh.ende);
  const faellig = leseDatumFeld(roh.faellig);
  const laufzeit = leseZahl(roh.laufzeit_monate, 1, 120);
  const verl = leseZahl(roh.verlaengerung_monate, 1, 60);
  if (beginn === undefined || ende === undefined || faellig === undefined || laufzeit === undefined || verl === undefined) return null;
  let kuendigungsfrist: FristBedingungen["kuendigungsfrist"] = null;
  if (roh.kuendigungsfrist !== null && roh.kuendigungsfrist !== undefined) {
    const k = roh.kuendigungsfrist;
    if (!istObjekt(k)) return null;
    const anzahl = leseZahl(k.anzahl, 1, 24);
    if (typeof anzahl !== "number" || (k.einheit !== "tage" && k.einheit !== "wochen" && k.einheit !== "monate")) return null;
    kuendigungsfrist = { anzahl, einheit: k.einheit };
  }
  return { beginn, ende, faellig, laufzeit_monate: laufzeit, verlaengerung_monate: verl, kuendigungsfrist };
}

/** Prueft beide Listen gegen die geladenen Daten (MASTERPLAN §3.6). */
export function pruefeNachtarbeit(e: NachtarbeitEingabe, d: NachtarbeitDaten): NachtarbeitPruefung {
  const aus: NachtarbeitPruefung = { vorschlaege: [], fristen: [], doppelt: 0, abgewiesen: [] };
  const weg = (liste: NachtarbeitListe, index: number, grund: NachtarbeitGrund): void => {
    aus.abgewiesen.push({ liste, index, grund });
  };
  const zielOk = (o: string | null): o is string => !!o && d.ordnerAktiv.has(o) && !hatZzSegment(o);

  // ── Vorschlaege ──
  const offen = new Set(d.offen);
  e.vorschlaege.forEach((roh, i) => {
    if (!istObjekt(roh)) return weg("vorschlaege", i, "ungueltig");
    const art = roh.art;
    const pfad = leseNasPfad(roh.pfad);
    const sicherheit = roh.sicherheit as OrdnerSicherheit;
    const quelle = roh.quelle as NasVorschlagQuelle;
    if ((art !== "zz" && art !== "nachpruefung") || !pfad || typeof roh.ordner_ist !== "string") return weg("vorschlaege", i, "ungueltig");
    if (!SICHERHEITEN.includes(sicherheit) || !QUELLEN.includes(quelle)) return weg("vorschlaege", i, "ungueltig");

    const zeile = d.index.get(pfad);
    const ordnerIst = roh.ordner_ist.normalize("NFC");
    if (!zeile || zeile.ordner_pfad !== ordnerIst) return weg("vorschlaege", i, "pfad_bewegt");

    const unterZz = hatZzSegment(ordnerIst);
    if (art === "zz" && !unterZz) return weg("vorschlaege", i, "kein_zz");
    if (art === "nachpruefung" && unterZz) return weg("vorschlaege", i, "ist_zz");

    const ziel = leseOrdner(roh.ziel_ordner);
    if (!zielOk(ziel)) return weg("vorschlaege", i, "ziel_ungueltig");
    if (ziel === ordnerIst) return weg("vorschlaege", i, "ziel_gleich");

    const schluessel = vorschlagSchluessel(art, pfad);
    if (offen.has(schluessel)) {
      aus.doppelt++;
      return;
    }
    if (d.abgelehnt.has(sperrSchluessel(pfad, ziel))) return weg("vorschlaege", i, "abgelehnt_bekannt");

    const alternativen: string[] = [];
    if (Array.isArray(roh.alternativen)) {
      for (const a of roh.alternativen as unknown[]) {
        if (alternativen.length >= 2) break;
        const o = leseOrdner(a);
        if (zielOk(o) && o !== ziel && o !== ordnerIst && !alternativen.includes(o)) alternativen.push(o);
      }
    }

    let begruendung: string | null = null;
    if (!istPersonalPfad(pfad) && typeof roh.begruendung === "string") {
      begruendung = minimiereText(roh.begruendung.slice(0, 1000), d.namen).slice(0, KI_ENTSCHEID_BEGRUENDUNG_MAX) || null;
    }

    offen.add(schluessel);
    aus.vorschlaege.push({
      art,
      pfad,
      sha256: leseSha(roh.sha256),
      ordner_ist: ordnerIst,
      ziel_ordner: ziel,
      alternativen,
      sicherheit,
      quelle,
      begruendung,
      modell: e.modell,
      lauf_id: e.lauf_id,
    });
  });

  // ── Fristen ──
  const bekannt = new Set(d.fristen);
  e.fristen.forEach((roh, i) => {
    if (!istObjekt(roh)) return weg("fristen", i, "ungueltig");
    const pfad = leseNasPfad(roh.pfad);
    const art = roh.art as FristArt;
    const bedingungen = leseBedingungen(roh.bedingungen);
    if (!pfad || !FRIST_ARTEN.includes(art) || !bedingungen) return weg("fristen", i, "ungueltig");
    const sicherheitRoh = roh.sicherheit ?? null;
    if (sicherheitRoh !== null && !SICHERHEITEN.includes(sicherheitRoh as OrdnerSicherheit)) return weg("fristen", i, "ungueltig");

    const zeile = d.index.get(pfad);
    if (!zeile) return weg("fristen", i, "pfad_bewegt");

    const rechnung = berechneFrist(art, bedingungen, d.heute);
    if (!rechnung.ok) return weg("fristen", i, rechnung.grund);
    const datum = rechnung.datum;

    const sha = leseSha(roh.sha256);
    const jeSha = sha ? d.itemsJeSha.get(sha) : undefined;
    const itemId = d.itemJePfad.get(pfad) ?? (jeSha && jeSha.length === 1 ? jeSha[0] : null);

    const sp = fristSchluesselPfad(pfad, datum);
    const si = itemId ? fristSchluesselItem(itemId, datum) : null;
    const ss = sha ? fristSchluesselSha(sha, datum) : null;
    if (bekannt.has(sp) || (si && bekannt.has(si)) || (ss && bekannt.has(ss))) return weg("fristen", i, "frist_bekannt");

    let partei: string | null = null;
    if (!istPersonalPfad(pfad) && typeof roh.partei === "string") {
      partei = minimiereText(roh.partei.slice(0, 200), d.namen).slice(0, PARTEI_MAX) || null;
    }

    bekannt.add(sp);
    if (si) bekannt.add(si);
    if (ss) bekannt.add(ss);
    aus.fristen.push({
      ablage_item_id: itemId,
      pfad,
      sha256: sha,
      art,
      datum,
      bezeichnung: `${FRIST_ART_LABEL[art]} · ${partei ?? zeile.name}`.slice(0, BEZEICHNUNG_MAX),
      grundlage: bedingungen,
      quelle: "ki",
      status: "vorschlag",
      sicherheit: sicherheitRoh as OrdnerSicherheit | null,
    });
  });

  return aus;
}
