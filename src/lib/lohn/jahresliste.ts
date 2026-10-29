// Jahresliste Lohn (Phase 2, erweitert Phase 4) — Grundlage für
// Lohnbescheinigung AK 40 und Lohnausweis. Rein (ohne DB), getestet in
// jahresliste.test.ts.
//
// Je Person und Lohnmonat zählt nur die LETZTE Fassung. Ausbezahlt wurde aber
// in Schritten: die erste Fassung am ursprünglichen Tag, jede Korrektur ihre
// Differenz am eigenen Tag. Die Liste verteilt deshalb je Monat die Beträge
// auf die Auszahlungstage (Summe = letzte Fassung) und ordnet sie dem
// Auszahlungsjahr zu (Auszahlungsprinzip). Arbeitsjahr = Jahr des Lohnmonats.
//
// 2'500-Grenze (Art. 34d AHVV): Ist der AHV-Lohn einer Person im
// Auszahlungsjahr insgesamt höchstens CHF 2'500 und hat sie für dieses Jahr
// keine Beiträge verlangt, ist der ganze AHV-Lohn beitragsfrei.
//
// Phase 4 (Lohnausweis): je Fassung zusätzlich der steuerbare Lohn, die
// steuerbaren Zusatzposten (Ziff. 7, mit Bezeichnung), Spesen (Ziff. 13), der
// Auszahlungsbetrag und die Abzüge je Art NETTO (Rückerstattungen
// eingerechnet). Fassungen vor Phase 4 (auch Altbestand) haben keine
// Zusatzposten: steuerbar = Brutto, Spesen 0, Auszahlung = Netto; ihre
// Abzüge je Art stehen in ergebnis.abzuege (Feld «art») — fehlen sie, ist das
// ein Fehler (fassungAusMomentaufnahme), nie eine Schätzung.

import { AHV_GERINGFUEGIG_GRENZE, summeChf, type AbzugArt } from "./kern";

export interface FassungFuerListe {
  profile_id: string;
  jahr: number;
  monat: number;
  fassung: number;
  art: "regulaer" | "korrektur" | "altbestand";
  auszahlungsdatum: string;
  /** Lohnmonat liegt im Papierkorb → zählt nicht. */
  im_papierkorb: boolean;
  brutto: number;
  netto: number;
  ahv_lohn: number;
  alv_lohn: number;
  uvg_lohn: number;
  uvg_art: "bu" | "bu_nbu";
  /** Quellensteuer netto (nach Rückerstattungen). */
  quellensteuer: number;
  lohnperiode: { von: string; bis: string } | null;
  // --- Phase 4 ---
  /** Steuerbarer Lohn (Lohnausweis Ziff. 8). */
  steuerbar: number;
  /** Davon steuerbare Zusatzposten «Lohn» (Ziff. 7). */
  zusatz_steuerbar: number;
  zusatz_texte: string[];
  /** Spesen (Ziff. 13). */
  spesen: number;
  spesen_texte: string[];
  /** Netto + Spesen. */
  auszahlungsbetrag: number;
  /** Abzüge je Art netto (Ziff. 9: AHV/IV/EO + ALV + NBU, Ziff. 10.1: BVG). */
  abzug_ahv_iv_eo: number;
  abzug_alv: number;
  abzug_nbu: number;
  abzug_bvg: number;
  abzug_ktg: number;
}

export interface JahreslistenZeile {
  profile_id: string;
  arbeitsjahr: number;
  monat: number;
  auszahlungsjahr: number;
  auszahlungsdaten: string[];
  fassung: number;
  lohnperiode_von: string | null;
  lohnperiode_bis: string | null;
  brutto: number;
  netto: number;
  ahv_lohn: number;
  ahv_beitragsfrei: number;
  alv_lohn: number;
  uvg_lohn_nur_bu: number;
  uvg_lohn_bu_nbu: number;
  quellensteuer: number;
  steuerbar: number;
  zusatz_steuerbar: number;
  zusatz_texte: string[];
  spesen: number;
  spesen_texte: string[];
  auszahlungsbetrag: number;
  abzug_ahv_iv_eo: number;
  abzug_alv: number;
  abzug_nbu: number;
  abzug_bvg: number;
  abzug_ktg: number;
}

const WERTE = [
  "brutto", "netto", "ahv_lohn", "alv_lohn", "uvg_lohn", "quellensteuer",
  "steuerbar", "zusatz_steuerbar", "spesen", "auszahlungsbetrag",
  "abzug_ahv_iv_eo", "abzug_alv", "abzug_nbu", "abzug_bvg", "abzug_ktg",
] as const;
type Werte = Record<(typeof WERTE)[number], number>;

interface Teil extends Werte {
  datum: string;
  uvg_art: "bu" | "bu_nbu";
  zusatz_texte: string[];
  spesen_texte: string[];
}

const werteVon = (f: FassungFuerListe): Werte => Object.fromEntries(WERTE.map((k) => [k, f[k]])) as Werte;
const nullWerte = (): Werte => Object.fromEntries(WERTE.map((k) => [k, 0])) as Werte;

/** Verteilung eines Lohnmonats auf seine Auszahlungstage. */
function teileDesMonats(kette: FassungFuerListe[]): Teil[] {
  const sortiert = [...kette].sort((a, b) => a.fassung - b.fassung);
  const teile: Teil[] = [];
  let vor: FassungFuerListe | null = null;
  for (const f of sortiert) {
    const texte = { zusatz_texte: f.zusatz_texte, spesen_texte: f.spesen_texte };
    if (!vor || f.art !== "korrektur") {
      // Erste bzw. ersetzende reguläre Fassung: der ganze Monat am eigenen Tag.
      teile.length = 0;
      teile.push({ datum: f.auszahlungsdatum, uvg_art: f.uvg_art, ...texte, ...werteVon(f) });
    } else {
      const v: FassungFuerListe = vor;
      const diff = Object.fromEntries(WERTE.map((k) => [k, summeChf([f[k], -v[k]])])) as Werte;
      // UVG-Art wechselt (NBU neu/entfallen): Vorfassung ganz umbuchen.
      if (f.uvg_art !== v.uvg_art) {
        teile.push({ datum: f.auszahlungsdatum, uvg_art: v.uvg_art, zusatz_texte: [], spesen_texte: [], ...nullWerte(), uvg_lohn: -v.uvg_lohn });
        teile.push({ datum: f.auszahlungsdatum, uvg_art: f.uvg_art, ...texte, ...diff, uvg_lohn: f.uvg_lohn });
      } else {
        teile.push({ datum: f.auszahlungsdatum, uvg_art: f.uvg_art, ...texte, ...diff });
      }
    }
    vor = f;
  }
  return teile;
}

const eindeutig = (l: string[]) => Array.from(new Set(l.map((t) => t.trim()).filter(Boolean)));

export function jahresliste(
  fassungen: FassungFuerListe[],
  opts: { jahr: number; basis: "auszahlung" | "arbeit"; ahvVerlangt: (profileId: string, jahr: number) => boolean },
): JahreslistenZeile[] {
  const ketten = new Map<string, FassungFuerListe[]>();
  for (const f of fassungen) {
    const k = `${f.profile_id}|${f.jahr}|${f.monat}`;
    ketten.set(k, [...(ketten.get(k) ?? []), f]);
  }
  const zeilen: JahreslistenZeile[] = [];
  for (const kette of ketten.values()) {
    const letzte = kette.reduce((a, b) => (b.fassung > a.fassung ? b : a));
    if (letzte.im_papierkorb) continue;
    const jeJahr = new Map<number, Teil[]>();
    for (const t of teileDesMonats(kette)) {
      const j = Number(t.datum.slice(0, 4));
      jeJahr.set(j, [...(jeJahr.get(j) ?? []), t]);
    }
    for (const [azJahr, teile] of jeJahr) {
      if (opts.basis === "auszahlung" ? azJahr !== opts.jahr : letzte.jahr !== opts.jahr) continue;
      const s = (k: (typeof WERTE)[number], nur?: "bu" | "bu_nbu") => summeChf(teile.filter((t) => !nur || t.uvg_art === nur).map((t) => t[k]));
      zeilen.push({
        profile_id: letzte.profile_id,
        arbeitsjahr: letzte.jahr,
        monat: letzte.monat,
        auszahlungsjahr: azJahr,
        auszahlungsdaten: Array.from(new Set(teile.map((t) => t.datum))).sort(),
        fassung: letzte.fassung,
        lohnperiode_von: letzte.lohnperiode?.von ?? null,
        lohnperiode_bis: letzte.lohnperiode?.bis ?? null,
        brutto: s("brutto"),
        netto: s("netto"),
        ahv_lohn: s("ahv_lohn"),
        ahv_beitragsfrei: 0,
        alv_lohn: s("alv_lohn"),
        uvg_lohn_nur_bu: s("uvg_lohn", "bu"),
        uvg_lohn_bu_nbu: s("uvg_lohn", "bu_nbu"),
        quellensteuer: s("quellensteuer"),
        steuerbar: s("steuerbar"),
        zusatz_steuerbar: s("zusatz_steuerbar"),
        zusatz_texte: eindeutig(teile.filter((t) => t.zusatz_steuerbar !== 0).flatMap((t) => t.zusatz_texte)),
        spesen: s("spesen"),
        spesen_texte: eindeutig(teile.filter((t) => t.spesen !== 0).flatMap((t) => t.spesen_texte)),
        auszahlungsbetrag: s("auszahlungsbetrag"),
        abzug_ahv_iv_eo: s("abzug_ahv_iv_eo"),
        abzug_alv: s("abzug_alv"),
        abzug_nbu: s("abzug_nbu"),
        abzug_bvg: s("abzug_bvg"),
        abzug_ktg: s("abzug_ktg"),
      });
    }
  }
  // 2'500-Grenze je Person und Auszahlungsjahr (über alle Monate dieses Jahres).
  const ahvJeJahr = new Map<string, number>();
  for (const f of ketten.values()) {
    const letzte = f.reduce((a, b) => (b.fassung > a.fassung ? b : a));
    if (letzte.im_papierkorb) continue;
    for (const t of teileDesMonats(f)) {
      const k = `${letzte.profile_id}|${t.datum.slice(0, 4)}`;
      ahvJeJahr.set(k, summeChf([ahvJeJahr.get(k) ?? 0, t.ahv_lohn]));
    }
  }
  for (const z of zeilen) {
    const total = ahvJeJahr.get(`${z.profile_id}|${z.auszahlungsjahr}`) ?? 0;
    if (total <= AHV_GERINGFUEGIG_GRENZE && !opts.ahvVerlangt(z.profile_id, z.auszahlungsjahr)) z.ahv_beitragsfrei = z.ahv_lohn;
  }
  return zeilen.sort((a, b) => a.profile_id.localeCompare(b.profile_id) || a.arbeitsjahr - b.arbeitsjahr || a.monat - b.monat || a.auszahlungsjahr - b.auszahlungsjahr);
}

// ---------------------------------------------------------------------------
// Momentaufnahme-Zeile (DB) → Fassung für die Liste
// ---------------------------------------------------------------------------

/** Was aus lohn_momentaufnahmen gelesen wird (Spalten + Teile des Ergebnisses). */
export interface MomentaufnahmeFuerListe {
  profile_id: string;
  jahr: number;
  monat: number;
  fassung: number;
  art: FassungFuerListe["art"];
  auszahlungsdatum: string;
  im_papierkorb: boolean;
  brutto: number | string;
  netto: number | string;
  auszahlungsbetrag: number | string | null;
  ahv_lohn: number | string;
  alv_lohn: number | string;
  uvg_lohn: number | string;
  uvg_art: "bu" | "bu_nbu";
  quellensteuer: number | string;
  lohnperiode: { von: string; bis: string } | null;
  /** ergebnis->abzuege */
  abzuege: { art: AbzugArt; betrag: number }[] | null;
  /** ergebnis->zusatzposten (fehlt vor Phase 4) */
  zusatzposten: { art: string; bezeichnung: string; betrag: number; steuerbar: boolean }[] | null;
  /** ergebnis->loehne->steuerbar (fehlt vor Phase 4) */
  steuerbar: number | string | null;
  /** ergebnis->spesen (fehlt vor Phase 4) */
  spesen: number | string | null;
}

export function fassungAusMomentaufnahme(r: MomentaufnahmeFuerListe): FassungFuerListe {
  if (!Array.isArray(r.abzuege)) {
    throw new Error(`Fassung ${r.fassung} ${r.jahr}-${String(r.monat).padStart(2, "0")} hat keine Abzüge je Art — Lohnausweis nicht möglich`);
  }
  const abzug = (art: AbzugArt) => summeChf(r.abzuege!.filter((a) => a.art === art).map((a) => Number(a.betrag)));
  const zp = Array.isArray(r.zusatzposten) ? r.zusatzposten : [];
  const zLohnSteuerbar = zp.filter((z) => z.art === "lohn" && z.steuerbar);
  const zSpesen = zp.filter((z) => z.art === "spesen");
  const brutto = Number(r.brutto);
  const netto = Number(r.netto);
  return {
    profile_id: r.profile_id,
    jahr: r.jahr,
    monat: r.monat,
    fassung: r.fassung,
    art: r.art,
    auszahlungsdatum: r.auszahlungsdatum,
    im_papierkorb: r.im_papierkorb,
    brutto,
    netto,
    ahv_lohn: Number(r.ahv_lohn),
    alv_lohn: Number(r.alv_lohn),
    uvg_lohn: Number(r.uvg_lohn),
    uvg_art: r.uvg_art,
    quellensteuer: Number(r.quellensteuer),
    lohnperiode: r.lohnperiode,
    steuerbar: r.steuerbar == null ? brutto : Number(r.steuerbar),
    zusatz_steuerbar: summeChf(zLohnSteuerbar.map((z) => Number(z.betrag))),
    zusatz_texte: zLohnSteuerbar.map((z) => z.bezeichnung),
    spesen: r.spesen == null ? 0 : Number(r.spesen),
    spesen_texte: zSpesen.map((z) => z.bezeichnung),
    auszahlungsbetrag: r.auszahlungsbetrag == null ? netto : Number(r.auszahlungsbetrag),
    abzug_ahv_iv_eo: abzug("ahv_iv_eo"),
    abzug_alv: abzug("alv"),
    abzug_nbu: abzug("nbu"),
    abzug_bvg: abzug("bvg"),
    abzug_ktg: abzug("ktg"),
  };
}
