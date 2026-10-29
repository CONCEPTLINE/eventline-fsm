// Jahresliste Lohn (Phase 2) — Grundlage für Lohnbescheinigung AK 40 und
// Lohnausweis. Rein (ohne DB), getestet in jahresliste.test.ts.
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

import { AHV_GERINGFUEGIG_GRENZE, summeChf } from "./kern";

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
  quellensteuer: number;
  lohnperiode: { von: string; bis: string } | null;
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
}

const WERTE = ["brutto", "netto", "ahv_lohn", "alv_lohn", "uvg_lohn", "quellensteuer"] as const;
type Werte = Record<(typeof WERTE)[number], number>;

interface Teil extends Werte {
  datum: string;
  uvg_art: "bu" | "bu_nbu";
}

/** Verteilung eines Lohnmonats auf seine Auszahlungstage. */
function teileDesMonats(kette: FassungFuerListe[]): Teil[] {
  const sortiert = [...kette].sort((a, b) => a.fassung - b.fassung);
  const teile: Teil[] = [];
  let vor: FassungFuerListe | null = null;
  for (const f of sortiert) {
    if (!vor || f.art !== "korrektur") {
      // Erste bzw. ersetzende reguläre Fassung: der ganze Monat am eigenen Tag.
      teile.length = 0;
      teile.push({ datum: f.auszahlungsdatum, uvg_art: f.uvg_art, ...Object.fromEntries(WERTE.map((k) => [k, f[k]])) as Werte });
    } else {
      const diff = Object.fromEntries(WERTE.map((k) => [k, summeChf([f[k], -vor![k]])])) as Werte;
      // UVG-Art wechselt (NBU neu/entfallen): Vorfassung ganz umbuchen.
      if (f.uvg_art !== vor.uvg_art) {
        teile.push({ datum: f.auszahlungsdatum, uvg_art: vor.uvg_art, ...Object.fromEntries(WERTE.map((k) => [k, k === "uvg_lohn" ? -vor![k] : 0])) as Werte });
        teile.push({ datum: f.auszahlungsdatum, uvg_art: f.uvg_art, ...diff, uvg_lohn: f.uvg_lohn });
      } else {
        teile.push({ datum: f.auszahlungsdatum, uvg_art: f.uvg_art, ...diff });
      }
    }
    vor = f;
  }
  return teile;
}

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
