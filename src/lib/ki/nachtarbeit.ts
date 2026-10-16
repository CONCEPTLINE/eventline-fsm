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
//    Segment in irgendeiner Tiefe und nie 99_System (die Liste enthaelt
//    schon keine Ordner unter inaktiven). Ungueltige Alternativen fallen still weg (max 2).
//  - Begruendung/Partei werden nochmals minimiert; in 06_PERSONAL fallen
//    sie ganz weg (zusaetzlich zur Regel auf dem Rig).
//  - Schon offen oder angenommen/korrigiert (Verschiebung steht aus) ->
//    doppelt. Ausnahme (Migration 329): ein Eintrag MIT `rezept` ersetzt
//    einen OFFENEN Vorschlag mit anderem oder keinem Rezept (ersetzen; die
//    Route loescht den alten bedingt — offen, nie entschieden). Angenommen/korrigiert
//    wird nie ersetzt. `name_vorschlag` nur, wenn lib/ki/dateiname ihn
//    gegen den Dateinamen aus dem Index annimmt — sonst still null.
//  - zz MIT `beschrieb` (Objekt) und OHNE ziel_ordner (Rig zz/v3): gleiche
//    Pfad-Pruefung, Rezept Pflicht, leseZzBeschrieb (lib/ki/zz-entscheid)
//    -> null = ungueltig; fakten (filtereFakt, max 12) und kandidaten (nur
//    aktive Ordner, max 8) -> Warteschlange nas_zz_beschriebe (beschriebe).
//    Doppelt wie oben (offen mit gleichem Rezept, ausstehend) und wenn der
//    offene Vorschlag der zweite Blick desselben Rezepts ist («zz/v4+zb»,
//    lib/ki/zweiter-blick, Migration 347).
//    Ausnahme (16.10.2026): ein zweiter Blick desselben Rezepts und desselben
//    Datei-Inhalts von einem ANDEREN lokalen Modell als der Beschrieb hinter
//    dem offenen Vorschlag -> nachlesen (die Zeile in nas_zz_beschriebe
//    bekommt den neuen Beschrieb und wartet wieder; die Warteschlange ersetzt
//    ihren eigenen offenen Vorschlag, nur solange er offen und nie
//    entschieden ist). Das Rig liest nur Ergebnisse nicht freigegebener
//    Modelle nach (am 16.10. 13 Dokumente vom ungeprueften 12B); dasselbe
//    Modell nochmals bleibt doppelt.
//  - Abgelehnt (180 Tage) mit gleichem Ziel -> abgelehnt_bekannt;
//    Frist mit gleichem Datum fuer dieselbe Datei (gleicher Pfad, gleicher
//    Ablage-Eintrag ODER gleicher Inhalt per sha256 — auch nach dem
//    Verschieben; jede Art, jeder Status, auch aus der Ablage) ->
//    frist_bekannt. Eine verworfene Frist wird so nie wiederbelebt.
//  - Gleicher SACHVERHALT (Art + Partei, lib/ki/fristen-sachverhalt) mit
//    gleichem Datum aus einer ANDEREN Datei (Vertrag als .docx und .pdf,
//    Entwurf und Historie-Kopie): offener Vorschlag -> die Datei kommt als
//    weiteres Quell-Dokument dazu (fristErgaenzt bzw. weitere_pfade einer
//    neuen Zeile derselben Lieferung); schon entschieden (aktiv, erledigt,
//    verworfen) -> frist_bekannt. Ohne Partei kein Sachverhalt.
//  - Unicode (§3.0, lib/ki/pfade): das Rig meldet NFC, verglichen wird in
//    NFC; in die Zeilen kommt die Schreibweise aus Datei-Index bzw.
//    Ordnerliste (Bytes auf dem NAS), nie die normalisierte.

import { minimiereText } from "./ablage-entscheid";
import { leseNasPfad } from "./bereinigen";
import { pruefeNeuenDateinamen } from "./dateiname";
import { filtereFakt, leseZzBeschrieb, type ZzBeschrieb } from "./zz-entscheid";
import { istZweiterBlick, zweiterBlickBleibt } from "./zweiter-blick";
import { hatZzSegment, zielGesperrt } from "./pfade";
import { berechneFrist, FRIST_ART_LABEL, FRIST_ARTEN, leseDatum, type FristGrund } from "./fristen";
import { fristSachverhalt, sachSchluessel } from "./fristen-sachverhalt";
import { KI_ENTSCHEID_BEGRUENDUNG_MAX, KI_NACHTARBEIT_MAX_EINTRAEGE } from "./konstanten";
import type { FristArt, FristBedingungen, FristStatus, NasVorschlagArt, NasVorschlagQuelle, OrdnerSicherheit } from "./typen";

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
  /** Migration 329 — Version der Vorschlags-Regeln, null bei aelteren Rig-Builds. */
  rezept: string | null;
  /** Migration 329 — gepruefter neuer Dateiname (lib/ki/dateiname) oder null. */
  name_vorschlag: string | null;
}

/** Zeile fuer nas_zz_beschriebe (Migration 329, Warteschlange fuer Claude). */
export interface ZzBeschriebNeu {
  pfad: string;
  sha256: string | null;
  ordner_ist: string;
  rezept: string;
  beschrieb: ZzBeschrieb;
  /** Gefilterte Fakten-Hinweise (filtereFakt), hoechstens 12 je <= 300 Zeichen. */
  fakten: string[];
  /** Aktive Ordner (Schreibweise ablage_ordner), hoechstens 8. */
  kandidaten: string[];
  lauf_id: string | null;
  modell: string | null;
}

/** Offener Vorschlag in der DB (status offen) — fuer das Ersetzen. */
export interface NasVorschlagOffen {
  id: string;
  rezept: string | null;
}

/** Zeile in nas_zz_beschriebe hinter einem offenen Vorschlag des zweiten
 *  Blicks (nicht in Arbeit, vorschlag_id = Vorschlag): von welchem lokalen
 *  Modell der Beschrieb stammt (vor dem 16.10. stand dort nach der
 *  Verarbeitung das Claude-Modell — zaehlt als anderes Modell). */
export interface ZzBeschriebBasis {
  id: string;
  sha256: string | null;
  modell: string | null;
}

/** Nachlesen (16.10.2026): neuer Beschrieb fuer die Zeile `id`, die dann
 *  wieder wartet und ihren eigenen offenen Vorschlag `vorschlag_id` ersetzt. */
export interface ZzNachlesen {
  id: string;
  vorschlag_id: string;
  ordner_ist: string;
  beschrieb: ZzBeschrieb;
  fakten: string[];
  kandidaten: string[];
  lauf_id: string | null;
  modell: string;
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
  /** Art + Partei normalisiert (Migration 321), null ohne Partei. */
  sachverhalt: string | null;
  /** Weitere Dateien derselben Frist aus dieser Lieferung. */
  weitere_pfade: string[];
}

/** Bekannte Frist eines Sachverhalts (Schluessel sachSchluessel). */
export interface FristSachverhaltBekannt {
  id: string;
  status: FristStatus;
}

/** Was die Route aus der Datenbank laedt. Alle Schluessel in NFC. */
export interface NachtarbeitDaten {
  heute: string;
  /** Aktive Zielordner ohne Kappung (ladeAktiveOrdner, ohne Ordner unter
   *  inaktiven): NFC -> Schreibweise in ablage_ordner (nfcZuRoh). */
  ordnerAktiv: ReadonlyMap<string, string>;
  /** Namen aller Profile fuer die Minimierung. */
  namen: readonly string[];
  /** Datei-Index (ladeIndexZeilenNfc): NFC-Pfad -> gespeicherter Pfad,
   *  Ordner und Dateiname (Schreibweise wie auf dem NAS). */
  index: ReadonlyMap<string, { pfad: string; ordner_pfad: string; name: string }>;
  /** Offene Vorschlaege (status offen) je vorschlagSchluessel(art, pfad). */
  offen: ReadonlyMap<string, NasVorschlagOffen>;
  /** Beschrieb hinter offenen Vorschlaegen des zweiten Blicks, je Vorschlags-id (fehlt = keiner bekannt). */
  zbBasis?: ReadonlyMap<string, ZzBeschriebBasis>;
  /** Angenommene/korrigierte Vorschlaege (Verschiebung steht noch aus) als
   *  vorschlagSchluessel(art, pfad) — werden nie ersetzt. */
  ausstehend: ReadonlySet<string>;
  /** Abgelehnt in den letzten 180 Tagen als sperrSchluessel(pfad, ziel). */
  abgelehnt: ReadonlySet<string>;
  /** Bekannte Fristen als fristSchluesselPfad/fristSchluesselItem/fristSchluesselSha. */
  fristen: ReadonlySet<string>;
  /** Bekannte Fristen je sachSchluessel(sachverhalt, datum) — ein offener
   *  Vorschlag geht vor (dorthin kommen weitere Dokumente). */
  sachverhalte: ReadonlyMap<string, FristSachverhaltBekannt>;
  /** Ablage-Eintrag je Pfad (ordner_pfad/abgelegt_name). */
  itemJePfad: ReadonlyMap<string, string>;
  /** Ablage-Eintraege je Inhalts-Hash (sha256). */
  itemsJeSha: ReadonlyMap<string, readonly string[]>;
}

export interface NachtarbeitPruefung {
  vorschlaege: NasVorschlagNeu[];
  /** Neue Zeilen, die einen offenen Vorschlag mit aelterem Rezept ersetzen
   *  (altId bedingt loeschen, erst dann die neue Zeile einfuegen). */
  ersetzen: { altId: string; zeile: NasVorschlagNeu }[];
  /** zz-Eintraege mit Beschrieb statt Ziel (rezept zz/v3) -> nas_zz_beschriebe. */
  beschriebe: ZzBeschriebNeu[];
  /** Zweiter Blick eines anderen lokalen Modells fuer denselben Inhalt -> bestehende Zeile neu lesen lassen. */
  nachlesen: ZzNachlesen[];
  fristen: FristNeu[];
  /** Weitere Quell-Dokumente fuer schon offene Vorschlaege (id = Frist). */
  fristErgaenzt: { id: string; pfad: string }[];
  /** Fristen, die als weiteres Dokument einer bestehenden oder neuen Frist
   *  zusammengefuehrt wurden (statt eigener Zeile). */
  zusammengefuehrt: number;
  doppelt: number;
  abgewiesen: NachtarbeitAbweisung[];
}

// Schluessel immer in NFC (gespeichert ist die Schreibweise der Platte).
export const vorschlagSchluessel = (art: string, pfad: string) => `${art}\u0000${pfad.normalize("NFC")}`;
export const sperrSchluessel = (pfad: string, ziel: string) => `${pfad.normalize("NFC")}\u0000${ziel.normalize("NFC")}`;
export const fristSchluesselPfad = (pfad: string, datum: string) => `p\u0000${pfad.normalize("NFC")}\u0000${datum}`;
export const fristSchluesselItem = (itemId: string, datum: string) => `i\u0000${itemId}\u0000${datum}`;
export const fristSchluesselSha = (sha256: string, datum: string) => `s\u0000${sha256.toLowerCase()}\u0000${datum}`;

const SICHERHEITEN: readonly OrdnerSicherheit[] = ["hoch", "mittel", "niedrig"];
const QUELLEN: readonly NasVorschlagQuelle[] = ["regel", "vorbild", "modell"];
const SHA_RE = /^[0-9a-f]{64}$/i;
const PARTEI_MAX = 60;
const REZEPT_MAX = 20;
const ZZ_FAKTEN_MAX = 12;
const ZZ_FAKT_LAENGE_MAX = 300;
const ZZ_KANDIDATEN_MAX = 8;
const BEZEICHNUNG_MAX = 120;

function istObjekt(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function kurzText(roh: unknown, max: number): string | null {
  return typeof roh === "string" && roh.trim() ? roh.trim().slice(0, max) : null;
}

export { hatZzSegment };

/** Rezept vom Rig: 1–20 Zeichen ohne Leer-/Steuerzeichen, sonst null. */
function leseRezept(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const r = roh.trim();
  return r.length > 0 && r.length <= REZEPT_MAX && /^[!-~]+$/.test(r) ? r : null; // druckbares ASCII
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

/** Partei einer Frist (minimiert; in 06_PERSONAL nie). */
export function leseFristPartei(roh: unknown, pfad: string, namen: readonly string[]): string | null {
  if (istPersonalPfad(pfad) || typeof roh !== "string") return null;
  return minimiereText(roh.slice(0, 200), namen).slice(0, PARTEI_MAX) || null;
}

/** Alle Sachverhalte der Eingabe — damit die Route nur die noetigen
 *  Fristen-Zeilen laedt (ungeprueft: ein Sachverhalt zu viel schadet nicht). */
export function sachverhalteDerEingabe(e: NachtarbeitEingabe, namen: readonly string[]): string[] {
  const aus = new Set<string>();
  for (const x of e.fristen) {
    if (!istObjekt(x)) continue;
    const pfad = leseNasPfad(x.pfad);
    if (!pfad || !FRIST_ARTEN.includes(x.art as FristArt)) continue;
    const s = fristSachverhalt(x.art as FristArt, leseFristPartei(x.partei, pfad, namen));
    if (s) aus.add(s);
  }
  return [...aus];
}

/** Prueft beide Listen gegen die geladenen Daten (MASTERPLAN §3.6). */
export function pruefeNachtarbeit(e: NachtarbeitEingabe, d: NachtarbeitDaten): NachtarbeitPruefung {
  const aus: NachtarbeitPruefung = { vorschlaege: [], ersetzen: [], beschriebe: [], nachlesen: [], fristen: [], fristErgaenzt: [], zusammengefuehrt: 0, doppelt: 0, abgewiesen: [] };
  const weg = (liste: NachtarbeitListe, index: number, grund: NachtarbeitGrund): void => {
    aus.abgewiesen.push({ liste, index, grund });
  };
  /** Ziel (NFC) -> Schreibweise aus ablage_ordner; null = kein gueltiges
   *  Ziel (inaktiv/unbekannt, ZZ_*, 99_System). */
  const zielRoh = (o: string | null): string | null => (o && !zielGesperrt(o) ? (d.ordnerAktiv.get(o) ?? null) : null);

  // ── Vorschlaege ──
  /** Schon in dieser Lieferung angenommen — ein zweiter Eintrag ist doppelt. */
  const neu = new Set<string>();
  e.vorschlaege.forEach((roh, i) => {
    if (!istObjekt(roh)) return weg("vorschlaege", i, "ungueltig");
    const art = roh.art;
    const pfad = leseNasPfad(roh.pfad);
    const sicherheit = roh.sicherheit as OrdnerSicherheit;
    const quelle = roh.quelle as NasVorschlagQuelle;
    if ((art !== "zz" && art !== "nachpruefung") || !pfad || typeof roh.ordner_ist !== "string") return weg("vorschlaege", i, "ungueltig");
    // zz/v3: Beschrieb statt Ziel (das FSM fragt Claude, lib/ki/zz-warteschlange).
    const mitBeschrieb = art === "zz" && (roh.ziel_ordner === undefined || roh.ziel_ordner === null) && istObjekt(roh.beschrieb);
    if (!mitBeschrieb && (!SICHERHEITEN.includes(sicherheit) || !QUELLEN.includes(quelle))) return weg("vorschlaege", i, "ungueltig");

    // Vergleich in NFC, Index-Zeile in der Schreibweise der Platte.
    const zeile = d.index.get(pfad);
    const ordnerIst = roh.ordner_ist.normalize("NFC");
    if (!zeile || zeile.ordner_pfad.normalize("NFC") !== ordnerIst) return weg("vorschlaege", i, "pfad_bewegt");

    const unterZz = hatZzSegment(ordnerIst);
    if (art === "zz" && !unterZz) return weg("vorschlaege", i, "kein_zz");
    if (art === "nachpruefung" && unterZz) return weg("vorschlaege", i, "ist_zz");

    if (mitBeschrieb) {
      const rezept = leseRezept(roh.rezept);
      const beschrieb = rezept ? leseZzBeschrieb(roh.beschrieb, d.namen) : null;
      if (!rezept || !beschrieb) return weg("vorschlaege", i, "ungueltig");
      const schluessel = vorschlagSchluessel(art, pfad);
      const alt = d.offen.get(schluessel);
      const sha256 = leseSha(roh.sha256);
      // Zweiter Blick desselben Rezepts und Inhalts von einem anderen lokalen
      // Modell (16.10.2026): die Zeile hinter dem offenen Vorschlag liest neu.
      const basis = alt && alt.rezept === rezept && istZweiterBlick(rezept) ? d.zbBasis?.get(alt.id) : undefined;
      const nachlesen = !!basis && !!e.modell && basis.sha256 === sha256 && basis.modell !== e.modell;
      // Schon entschieden (Verschiebung steht aus) oder offen mit demselben
      // Rezept -> doppelt; ebenso, wenn der offene Vorschlag der zweite Blick
      // desselben Rezepts ist (Migration 347: das schnelle Modell ueberstimmt
      // das grosse nie). Sonst wartet der Beschrieb auf Claude (dort wird ein
      // aelterer offener Vorschlag ersetzt).
      if (neu.has(schluessel) || d.ausstehend.has(schluessel) || (alt && !nachlesen && (alt.rezept === rezept || zweiterBlickBleibt(alt.rezept, rezept)))) {
        aus.doppelt++;
        return;
      }
      const fakten: string[] = [];
      if (Array.isArray(roh.fakten)) {
        for (const f of roh.fakten as unknown[]) {
          if (fakten.length >= ZZ_FAKTEN_MAX) break;
          const g = filtereFakt(f);
          if (g && g.length <= ZZ_FAKT_LAENGE_MAX) fakten.push(g);
        }
      }
      const kandidaten: string[] = [];
      const kandidatenNfc: string[] = [];
      if (Array.isArray(roh.kandidaten)) {
        for (const k of roh.kandidaten as unknown[]) {
          if (kandidaten.length >= ZZ_KANDIDATEN_MAX) break;
          const o = leseOrdner(k);
          const oRoh = zielRoh(o);
          if (o && oRoh && o !== ordnerIst && !kandidatenNfc.includes(o)) {
            kandidatenNfc.push(o);
            kandidaten.push(oRoh);
          }
        }
      }
      neu.add(schluessel);
      if (nachlesen && alt && basis && e.modell) {
        aus.nachlesen.push({
          id: basis.id,
          vorschlag_id: alt.id,
          ordner_ist: zeile.ordner_pfad,
          beschrieb,
          fakten,
          kandidaten,
          lauf_id: e.lauf_id,
          modell: e.modell,
        });
        return;
      }
      aus.beschriebe.push({
        pfad: zeile.pfad,
        sha256,
        ordner_ist: zeile.ordner_pfad,
        rezept,
        beschrieb,
        fakten,
        kandidaten,
        lauf_id: e.lauf_id,
        modell: e.modell,
      });
      return;
    }

    const zielNfc = leseOrdner(roh.ziel_ordner);
    const ziel = zielRoh(zielNfc);
    if (!zielNfc || !ziel) return weg("vorschlaege", i, "ziel_ungueltig");
    if (zielNfc === ordnerIst) return weg("vorschlaege", i, "ziel_gleich");

    const rezept = leseRezept(roh.rezept);
    const schluessel = vorschlagSchluessel(art, pfad);
    const alt = d.offen.get(schluessel);
    // Ersetzen nur mit Rezept, nur offen, nur bei anderem/keinem alten Rezept.
    const ersetzt = !!alt && rezept !== null && alt.rezept !== rezept;
    if (neu.has(schluessel) || d.ausstehend.has(schluessel) || (alt && !ersetzt)) {
      aus.doppelt++;
      return;
    }
    if (d.abgelehnt.has(sperrSchluessel(pfad, zielNfc))) return weg("vorschlaege", i, "abgelehnt_bekannt");

    const alternativen: string[] = [];
    const alternativenNfc: string[] = [];
    if (Array.isArray(roh.alternativen)) {
      for (const a of roh.alternativen as unknown[]) {
        if (alternativen.length >= 2) break;
        const o = leseOrdner(a);
        const oRoh = zielRoh(o);
        if (o && oRoh && o !== zielNfc && o !== ordnerIst && !alternativenNfc.includes(o)) {
          alternativenNfc.push(o);
          alternativen.push(oRoh);
        }
      }
    }

    let begruendung: string | null = null;
    if (!istPersonalPfad(pfad) && typeof roh.begruendung === "string") {
      begruendung = minimiereText(roh.begruendung.slice(0, 1000), d.namen).slice(0, KI_ENTSCHEID_BEGRUENDUNG_MAX) || null;
    }

    neu.add(schluessel);
    const zeileNeu: NasVorschlagNeu = {
      art,
      pfad: zeile.pfad,
      sha256: leseSha(roh.sha256),
      ordner_ist: zeile.ordner_pfad,
      ziel_ordner: ziel,
      alternativen,
      sicherheit,
      quelle,
      begruendung,
      modell: e.modell,
      lauf_id: e.lauf_id,
      rezept,
      // Gegen den Namen auf der Platte (Index); ungueltig -> still null.
      name_vorschlag: pruefeNeuenDateinamen(roh.name_vorschlag, zeile.name),
    };
    if (alt && ersetzt) aus.ersetzen.push({ altId: alt.id, zeile: zeileNeu });
    else aus.vorschlaege.push(zeileNeu);
  });

  // ── Fristen ──
  const bekannt = new Set(d.fristen);
  /** Sachverhalte dieser Lieferung -> Index in aus.fristen. */
  const neuJeSach = new Map<string, number>();
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

    const partei = leseFristPartei(roh.partei, pfad, d.namen);
    const sachverhalt = fristSachverhalt(art, partei);
    const merke = () => {
      bekannt.add(sp);
      if (si) bekannt.add(si);
      if (ss) bekannt.add(ss);
    };

    // Gleicher Sachverhalt + Datum aus einer anderen Datei: keine eigene Zeile.
    if (sachverhalt) {
      const sk = sachSchluessel(sachverhalt, datum);
      const neuIndex = neuJeSach.get(sk);
      if (neuIndex !== undefined) {
        const ziel = aus.fristen[neuIndex];
        const nfc = zeile.pfad.normalize("NFC");
        if (ziel.pfad.normalize("NFC") !== nfc && !ziel.weitere_pfade.some((p) => p.normalize("NFC") === nfc)) ziel.weitere_pfade.push(zeile.pfad);
        merke();
        aus.zusammengefuehrt++;
        return;
      }
      const da = d.sachverhalte.get(sk);
      if (da) {
        if (da.status !== "vorschlag") return weg("fristen", i, "frist_bekannt");
        merke();
        aus.fristErgaenzt.push({ id: da.id, pfad: zeile.pfad });
        aus.zusammengefuehrt++;
        return;
      }
      neuJeSach.set(sk, aus.fristen.length);
    }

    merke();
    aus.fristen.push({
      ablage_item_id: itemId,
      pfad: zeile.pfad,
      sha256: sha,
      art,
      datum,
      bezeichnung: `${FRIST_ART_LABEL[art]} · ${partei ?? zeile.name}`.slice(0, BEZEICHNUNG_MAX),
      grundlage: bedingungen,
      quelle: "ki",
      status: "vorschlag",
      sicherheit: sicherheitRoh as OrdnerSicherheit | null,
      sachverhalt,
      weitere_pfade: [],
    });
  });

  return aus;
}
