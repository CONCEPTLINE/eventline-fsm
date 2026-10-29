// Rechenkern Lohn — ein Monat einer Person.
//
// rechneMonat(eingabe) ist die EINE Rechnung für alle Wege (Monatstabelle,
// Lohnabrechnung, Excel, Lohn-Details, «Mein Monat», Prognosen). Rein:
// gleiche Eingabe → gleiches Ergebnis, kein Datenbank-Zugriff.
//
// Ablauf:
//   1. Stempel auf Tage verteilen (verteilung.ts): Überlappungen einmal,
//      offene Stempel nicht, ausserhalb der Anstellung nicht.
//   2. Je Tag die gültige Lohnzeile (Lohn TAGEWEISE). Fehlt sie an einem Tag
//      mit Arbeit innerhalb der Anstellung → Fehler (kein Ersatzlohn).
//   3. Basislohn je Tag = Stundenlohn ohne Ferienzuschlag.
//   4. Zuschläge: Sonntag/Feiertag 50 % für die ersten 6 Sonn-/Feiertage im
//      Kalenderjahr, Nacht 25 % für die ersten 24 Nächte, danach Zeitzuschlag
//      10 % (Zeit, kein Geld).
//   5. Prozent-Lohnarten auf (Stundenlohn + Zuschläge): 1. August 0,39 %,
//      Ferienzuschlag 8,33 % / 10,64 %.
//   6. Firmensätze nach Auszahlungsdatum (Auszahlungsprinzip), eigene Sätze
//      der Lohnzeile nach Arbeitstagen. Fehlende Sätze → Fehler (keine
//      Ersatzsätze).
//   7. Abzüge: AHV/IV/EO, ALV (bis Höchstlohn), NBU nur wenn versichert
//      (nbu.ts), BVG, KTG, Quellensteuer (fester Satz).
//   8. Jeder Betrag einmal auf 5 Rappen gerundet (regeln.ts).

import type {
  Abzug,
  AbzugArt,
  AbzugsSaetze,
  Anstellung,
  ArbeitgeberArt,
  ArbeitgeberBeitrag,
  ArbeitgeberSaetze,
  Einsatzeinheit,
  Firmensatz,
  Hinweis,
  Lohnzeile,
  MonatsEingabe,
  MonatsErgebnis,
  Position,
  Stempel,
  TagesZeile,
} from "./typen";
import {
  AHV_GERINGFUEGIG_GRENZE,
  ALV_HOECHSTLOHN_JAHR,
  FEIERTAG_1AUG_PCT,
  FERIEN_JUGEND_BIS_ALTER,
  KERN_VERSION,
  NACHT_MAX_JE_JAHR,
  NACHT_ZUSCHLAG_PCT,
  SONNTAG_MAX_JE_JAHR,
  SONNTAG_ZUSCHLAG_PCT,
  UVG_HOECHSTLOHN_JAHR,
  ZEITZUSCHLAG_PCT,
  ferienPctNachAlter,
  fmtProzent,
  rundeChf,
  summeChf,
} from "./regeln";
import { nbuStatus } from "./nbu";
import { feiertagsKarte, rangImJahr, sonntagOderFeiertag, verteile } from "./verteilung";
import { istIsoDatum, jeLokalerStunde, lokalesDatum, monatIndex, monatsErster, monatsLetzter, plusTage, zuMs } from "./zeit";

/** Fehler des Kerns — die Rechnung ist nicht möglich (fehlende Daten). */
export class KernFehler extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KernFehler";
    this.code = code;
  }
}

const AN_SCHLUESSEL: (keyof AbzugsSaetze)[] = ["ahvIvEo", "alv", "nbu", "bvg", "ktg", "quellensteuer"];
const AG_SCHLUESSEL: (keyof ArbeitgeberSaetze)[] = ["ahvIvEo", "alv", "fak", "bu", "bvg", "verwaltung"];

function pruefeSaetze(wo: string, an: AbzugsSaetze, ag: ArbeitgeberSaetze): void {
  for (const k of AN_SCHLUESSEL) {
    const v = an?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new KernFehler("satz_fehlt", `${wo}: Satz Arbeitnehmer «${k}» fehlt oder ist ungültig`);
    }
  }
  for (const k of AG_SCHLUESSEL) {
    const v = ag?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new KernFehler("satz_fehlt", `${wo}: Satz Arbeitgeber «${k}» fehlt oder ist ungültig`);
    }
  }
}

/** Firmensätze, die am Datum gelten (jüngstes «gültig ab» ≤ Datum). */
export function firmensatzAm(firmensaetze: Firmensatz[], datum: string): Firmensatz | null {
  let best: Firmensatz | null = null;
  for (const f of firmensaetze) {
    if (f.gueltigAb <= datum && (!best || f.gueltigAb > best.gueltigAb)) best = f;
  }
  return best;
}

/** Lohnzeile, die am Tag gilt. Mehrere gültige Zeilen → Fehler. */
export function lohnzeileAm(lohnzeilen: Lohnzeile[], datum: string): Lohnzeile | null {
  let treffer: Lohnzeile | null = null;
  for (const z of lohnzeilen) {
    if (z.gueltigAb <= datum && (z.gueltigBis == null || datum <= z.gueltigBis)) {
      if (treffer) {
        throw new KernFehler("lohnzeilen_ueberlappen", `Am ${datum} gelten zwei Lohnzeilen (ab ${treffer.gueltigAb} und ab ${z.gueltigAb})`);
      }
      treffer = z;
    }
  }
  return treffer;
}

function tageImMonat(jahr: number, monat: number): string[] {
  const out: string[] = [];
  const letzter = monatsLetzter(jahr, monat);
  for (let d = monatsErster(jahr, monat); d <= letzter; d = plusTage(d, 1)) out.push(d);
  return out;
}

function lohnperiode(jahr: number, monat: number, anstellungen: Anstellung[] | null): { von: string; bis: string } | null {
  const erster = monatsErster(jahr, monat);
  const letzter = monatsLetzter(jahr, monat);
  if (anstellungen == null) return { von: erster, bis: letzter };
  let von: string | null = null;
  let bis: string | null = null;
  for (const a of anstellungen) {
    const aBis = a.austritt ?? "9999-12-31";
    if (a.eintritt > letzter || aBis < erster) continue;
    const v = a.eintritt > erster ? a.eintritt : erster;
    const b = aBis < letzter ? aBis : letzter;
    if (!von || v < von) von = v;
    if (!bis || b > bis) bis = b;
  }
  return von && bis ? { von, bis } : null;
}

function fmtH(min: number): string {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
}

function fmtChf(n: number): string {
  return new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

interface Gruppe {
  basislohn: number;
  ferienPct: number;
  normal: number;
  sonntag: number;
  nacht: number;
}

/** Rohe Minuten eines Stempels im Monat (vor dem Zusammenführen). */
function rohMinutenImMonat(stempel: Stempel[], prefix: string): number {
  let n = 0;
  for (const s of stempel) {
    if (s.ende == null) continue;
    jeLokalerStunde(zuMs(s.start), zuMs(s.ende), (datum, _h, min) => {
      if (datum.startsWith(prefix)) n += min;
    });
  }
  return n;
}

export function rechneMonat(e: MonatsEingabe): MonatsErgebnis {
  const { jahr, monat, person } = e;
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100 || !Number.isInteger(monat) || monat < 1 || monat > 12) {
    throw new KernFehler("eingabe", `Ungültiger Monat ${jahr}-${monat}`);
  }
  if (!istIsoDatum(e.auszahlungsdatum)) throw new KernFehler("eingabe", "Auszahlungsdatum fehlt");
  for (const z of e.lohnzeilen) {
    if (!istIsoDatum(z.gueltigAb) || (z.gueltigBis != null && !istIsoDatum(z.gueltigBis))) {
      throw new KernFehler("eingabe", "Lohnzeile mit ungültigem Datum");
    }
  }
  // Sätze und Stundenlohn werden geprüft, wo sie gebraucht werden: eine
  // unvollständige Zeile, die den Monat nicht betrifft (oder «kein Lohn» ist),
  // blockiert die Rechnung nicht — eine gebrauchte schon.

  const prefix = `${jahr}-${String(monat).padStart(2, "0")}-`;
  const erster = monatsErster(jahr, monat);
  const letzter = monatsLetzter(jahr, monat);
  const hinweise: Hinweis[] = [];
  const anstellungen = person.anstellungen;
  if (anstellungen == null) {
    hinweise.push({ code: "anstellung_unbekannt", text: "Anstellung (Eintritt/Austritt) nicht erfasst — ganzer Monat angenommen" });
  }

  // --- 1. Verteilen ---------------------------------------------------------
  const feiertage = feiertagsKarte(e.feiertage);
  const v = verteile(e.stempel, anstellungen, feiertage);
  const rangNacht = rangImJahr(v.naechte);
  const rangSonntag = rangImJahr(v.sonntage);

  // --- 2.–4. Tageweise Lohn und Zuschläge ----------------------------------
  const gruppen = new Map<string, Gruppe>();
  const tage: TagesZeile[] = [];
  let minuten = 0;
  let ohneLohnMinuten = 0;
  let ausserhalb = 0;
  let sonntagMit = 0;
  let sonntagOhne = 0;
  let nachtMit = 0;
  let nachtOhne = 0;
  const sonntageImMonat = new Map<string, number>();
  const naechteImMonat = new Map<string, number>();
  let ferienJugendLetzterMonat = false;

  for (const datum of tageImMonat(jahr, monat)) {
    const b = v.tage.get(datum);
    if (!b) continue;
    ausserhalb += b.ausserhalbAnstellung;
    const zeileTag: TagesZeile = {
      datum,
      minuten: b.minuten,
      nachtMinuten: b.nachtMinuten,
      sonntagMinuten: b.sonntagMinuten,
      feiertagName: sonntagOderFeiertag(datum, feiertage),
      lohnzeileId: null,
      basislohn: null,
      ferienPct: null,
      ausserhalbAnstellung: b.ausserhalbAnstellung,
    };
    tage.push(zeileTag);
    if (b.minuten === 0) continue;

    const zeile = lohnzeileAm(e.lohnzeilen, datum);
    if (!zeile) {
      throw new KernFehler("lohnzeile_fehlt", `Am ${datum} sind ${fmtH(b.minuten)} gestempelt, aber keine Lohnzeile ist gültig`);
    }
    zeileTag.lohnzeileId = zeile.id ?? null;
    for (const [k, min] of b.sonntag) sonntageImMonat.set(k, (sonntageImMonat.get(k) ?? 0) + min);
    for (const [k, min] of b.nacht) naechteImMonat.set(k, (naechteImMonat.get(k) ?? 0) + min);
    if (zeile.ohneLohn) {
      ohneLohnMinuten += b.minuten;
      continue;
    }
    if (!Number.isFinite(zeile.stundenlohn) || zeile.stundenlohn < 0) {
      throw new KernFehler("eingabe", `Lohnzeile ab ${zeile.gueltigAb}: Stundenlohn ungültig`);
    }
    let ferienPct: number;
    if (zeile.ferienPctFix != null) {
      ferienPct = zeile.ferienPctFix;
    } else {
      if (!person.geburtsdatum) {
        throw new KernFehler("geburtsdatum_fehlt", "Geburtsdatum fehlt — Ferienzuschlag (8,33 % oder 10,64 %) nicht bestimmbar");
      }
      ferienPct = ferienPctNachAlter(person.geburtsdatum, jahr, monat);
      const [gj, gm] = person.geburtsdatum.split("-").map(Number);
      if (monatIndex(gj + FERIEN_JUGEND_BIS_ALTER, gm) === monatIndex(jahr, monat)) ferienJugendLetzterMonat = true;
    }
    const basislohn = zeile.stundenlohnArt === "inkl_ferien" ? zeile.stundenlohn / (1 + ferienPct / 100) : zeile.stundenlohn;
    zeileTag.basislohn = basislohn;
    zeileTag.ferienPct = ferienPct;
    const key = `${basislohn.toFixed(8)}|${ferienPct}`;
    let g = gruppen.get(key);
    if (!g) {
      g = { basislohn, ferienPct, normal: 0, sonntag: 0, nacht: 0 };
      gruppen.set(key, g);
    }
    minuten += b.minuten;
    g.normal += b.minuten;
    for (const [k, min] of b.sonntag) {
      if ((rangSonntag.get(k) ?? Infinity) <= SONNTAG_MAX_JE_JAHR) {
        g.sonntag += min;
        sonntagMit += min;
      } else {
        sonntagOhne += min;
      }
    }
    for (const [k, min] of b.nacht) {
      if ((rangNacht.get(k) ?? Infinity) <= NACHT_MAX_JE_JAHR) {
        g.nacht += min;
        nachtMit += min;
      } else {
        nachtOhne += min;
      }
    }
  }
  const zeitzuschlagMinuten = (nachtOhne * ZEITZUSCHLAG_PCT) / 100;

  // --- 5. Positionen ----------------------------------------------------------
  const positionen: Position[] = [];
  const gruppenListe = Array.from(gruppen.values()).sort((a, b) => a.basislohn - b.basislohn || a.ferienPct - b.ferienPct);
  const basisJeFerien = new Map<number, number>();
  let basisTotal = 0;
  const mehrereAnsaetze = gruppenListe.length > 1;
  for (const g of gruppenListe) {
    const normal = (g.normal / 60) * g.basislohn;
    const sonntag = (g.sonntag / 60) * g.basislohn * (SONNTAG_ZUSCHLAG_PCT / 100);
    const nacht = (g.nacht / 60) * g.basislohn * (NACHT_ZUSCHLAG_PCT / 100);
    basisJeFerien.set(g.ferienPct, (basisJeFerien.get(g.ferienPct) ?? 0) + normal + sonntag + nacht);
    basisTotal += normal + sonntag + nacht;
    const zusatz = mehrereAnsaetze ? ` (CHF ${fmtChf(g.basislohn)})` : "";
    if (g.normal > 0) {
      positionen.push({ lohnart: "normal", bezeichnung: `Stundenlohn${zusatz}`, minuten: g.normal, ansatz: g.basislohn, prozent: null, basis: null, betrag: rundeChf(normal) });
    }
    if (g.sonntag > 0) {
      positionen.push({ lohnart: "sonntag", bezeichnung: `Sonntags-/Feiertagszuschlag ${SONNTAG_ZUSCHLAG_PCT} %${zusatz}`, minuten: g.sonntag, ansatz: g.basislohn * (SONNTAG_ZUSCHLAG_PCT / 100), prozent: SONNTAG_ZUSCHLAG_PCT, basis: null, betrag: rundeChf(sonntag) });
    }
    if (g.nacht > 0) {
      positionen.push({ lohnart: "nacht", bezeichnung: `Nachtzuschlag ${NACHT_ZUSCHLAG_PCT} %${zusatz}`, minuten: g.nacht, ansatz: g.basislohn * (NACHT_ZUSCHLAG_PCT / 100), prozent: NACHT_ZUSCHLAG_PCT, basis: null, betrag: rundeChf(nacht) });
    }
  }
  if (basisTotal > 0) {
    positionen.push({ lohnart: "feiertag_1aug", bezeichnung: `Feiertagsentschädigung 1. August ${fmtProzent(FEIERTAG_1AUG_PCT)}`, minuten: null, ansatz: null, prozent: FEIERTAG_1AUG_PCT, basis: basisTotal, betrag: rundeChf((basisTotal * FEIERTAG_1AUG_PCT) / 100) });
  }
  for (const [pct, basis] of Array.from(basisJeFerien.entries()).sort((a, b) => a[0] - b[0])) {
    if (basis <= 0) continue;
    positionen.push({ lohnart: "ferien", bezeichnung: `Ferienzuschlag ${fmtProzent(pct)}`, minuten: null, ansatz: null, prozent: pct, basis, betrag: rundeChf((basis * pct) / 100) });
  }
  const brutto = summeChf(positionen.map((p) => p.betrag));

  // --- 6. Sätze nach Auszahlungsdatum ---------------------------------------
  const firmensatz = firmensatzAm(e.firmensaetze, e.auszahlungsdatum);
  if (!firmensatz) {
    throw new KernFehler("firmensatz_fehlt", `Keine Firmensätze gültig am Auszahlungsdatum ${e.auszahlungsdatum}`);
  }
  // Eigene Sätze einer Lohnzeile gelten wie die Lohnzeile selbst nach
  // Arbeitstagen: massgebend ist die Zeile am letzten Tag des Monats, an dem
  // eine gilt (Eintritt/Austritt mitten im Monat). Die Firmensätze dagegen
  // nach Auszahlungsdatum.
  let satzZeile: Lohnzeile | null = null;
  for (let d = letzter; d >= erster && !satzZeile; d = plusTage(d, -1)) satzZeile = lohnzeileAm(e.lohnzeilen, d);
  pruefeSaetze(`Firmensätze ab ${firmensatz.gueltigAb}`, firmensatz.an, firmensatz.ag);
  if (!Number.isFinite(firmensatz.bvgSchwelleMonat) || firmensatz.bvgSchwelleMonat <= 0) {
    throw new KernFehler("satz_fehlt", `Firmensätze ab ${firmensatz.gueltigAb}: BVG-Schwelle fehlt`);
  }
  // «Kein Lohn»: es gibt nichts abzuziehen — eigene Sätze dieser Zeile sind ohne Belang.
  const eigene = satzZeile && !satzZeile.ohneLohn ? satzZeile.eigeneSaetze : null;
  if (eigene && satzZeile) pruefeSaetze(`Lohnzeile ab ${satzZeile.gueltigAb}`, eigene.an, eigene.ag);
  const an: AbzugsSaetze = eigene ? eigene.an : firmensatz.an;
  const ag: ArbeitgeberSaetze = eigene ? eigene.ag : firmensatz.ag;

  // --- 7. Löhne und Abzüge ----------------------------------------------------
  const bisher = e.bisher ?? { ahvLohn: 0, alvLohn: 0, uvgLohn: 0 };
  const ahvLohn = brutto;
  const alvLohn = Math.max(0, Math.min(brutto, ALV_HOECHSTLOHN_JAHR - bisher.alvLohn));
  const uvgLohn = Math.max(0, Math.min(brutto, UVG_HOECHSTLOHN_JAHR - bisher.uvgLohn));
  const nbu = nbuStatus(jahr, monat, v.wochen, anstellungen);

  const abzug = (art: AbzugArt, bezeichnung: string, prozent: number, basis: number): Abzug => ({
    art,
    bezeichnung,
    prozent,
    basis,
    betrag: rundeChf((basis * prozent) / 100),
  });
  const abzuege: Abzug[] = [
    abzug("ahv_iv_eo", "AHV/IV/EO", an.ahvIvEo, ahvLohn),
    abzug("alv", "ALV", an.alv, alvLohn),
    abzug("nbu", "NBU", nbu.versichert ? an.nbu : 0, uvgLohn),
    abzug("bvg", "BVG", an.bvg, brutto),
    abzug("ktg", "KTG", an.ktg, brutto),
    abzug("quellensteuer", "Quellensteuer", an.quellensteuer, brutto),
  ];
  const totalAbzuege = summeChf(abzuege.map((a) => a.betrag));
  const netto = summeChf([brutto, -totalAbzuege]);

  const beitrag = (art: ArbeitgeberArt, prozent: number, basis: number): ArbeitgeberBeitrag => ({ art, prozent, betrag: rundeChf((basis * prozent) / 100) });
  const arbeitgeber: ArbeitgeberBeitrag[] = [
    beitrag("ahv_iv_eo", ag.ahvIvEo, ahvLohn),
    beitrag("alv", ag.alv, alvLohn),
    beitrag("fak", ag.fak, ahvLohn),
    beitrag("bu", ag.bu, uvgLohn),
    beitrag("bvg", ag.bvg, brutto),
    beitrag("verwaltung", ag.verwaltung, ahvLohn),
  ];
  const totalArbeitgeber = summeChf(arbeitgeber.map((a) => a.betrag));

  // --- 2'500-Grenze (Art. 34d AHVV) nach Auszahlungsjahr ----------------------
  const auszahlungsjahr = Number(e.auszahlungsdatum.slice(0, 4));
  const verlangt = person.ahvVerlangtJahre.includes(auszahlungsjahr);
  const ahvInkl = summeChf([bisher.ahvLohn, ahvLohn]);
  const status = verlangt ? "verlangt" : ahvInkl > AHV_GERINGFUEGIG_GRENZE ? "ueberschritten" : "unter";
  if (status === "unter" && ahvLohn > 0) {
    hinweise.push({
      code: "ahv_2500",
      text: `AHV-Lohn ${auszahlungsjahr} bisher CHF ${fmtChf(ahvInkl)} — unter CHF 2'500: Beiträge nur auf Verlangen (Art. 34d AHVV). Laufend abgezogen, Rückerstattung mit der letzten Abrechnung des Jahres, wenn die Grenze nicht überschritten wird.`,
    });
  } else if (status === "ueberschritten" && bisher.ahvLohn <= AHV_GERINGFUEGIG_GRENZE) {
    hinweise.push({ code: "ahv_2500", text: `AHV-Lohn ${auszahlungsjahr} überschreitet in diesem Monat CHF 2'500 — Beiträge für das ganze Jahr geschuldet.` });
  }

  // --- Hinweise ---------------------------------------------------------------
  if (an.quellensteuer > 0) {
    hinweise.push({ code: "quellensteuer", text: `Quellensteuer: fester Satz ${fmtProzent(an.quellensteuer)} aus der Lohnzeile (Tarif ausserhalb geprüft)` });
  }
  if (brutto > firmensatz.bvgSchwelleMonat) {
    hinweise.push({ code: "bvg_schwelle", text: `Bruttolohn über der BVG-Eintrittsschwelle (CHF ${fmtChf(firmensatz.bvgSchwelleMonat)} je Monat) — Unterstellung prüfen` });
  }
  if (zeitzuschlagMinuten > 0) {
    hinweise.push({ code: "zeitzuschlag", text: `Ab der ${NACHT_MAX_JE_JAHR + 1}. Nacht im Jahr: Zeitzuschlag ${ZEITZUSCHLAG_PCT} % = ${fmtH(zeitzuschlagMinuten)} bezahlte Ausgleichsruhezeit` });
  }
  if (sonntagOhne > 0) {
    hinweise.push({ code: "sonntag_limit", text: `Ab dem ${SONNTAG_MAX_JE_JAHR + 1}. Sonn-/Feiertag im Jahr kein Lohnzuschlag (${fmtH(sonntagOhne)}) — Ersatzruhe nach Art. 20 ArG` });
  }
  const offenImMonat = v.offeneStempel.filter((s) => {
    const ms = zuMs(s.start);
    return Number.isFinite(ms) && lokalesDatum(ms).startsWith(prefix);
  });
  if (offenImMonat.length > 0) {
    hinweise.push({ code: "offener_stempel", text: `${offenImMonat.length} offene(r) Stempel ohne Ende — nicht gezählt` });
  }
  const roh = rohMinutenImMonat(e.stempel, prefix);
  const vereinigt = minuten + ohneLohnMinuten + ausserhalb;
  if (roh > vereinigt) {
    hinweise.push({ code: "ueberlappung", text: `Überlappende Stempel: ${fmtH(roh - vereinigt)} doppelt gestempelt, einmal gezählt` });
  }
  if (ausserhalb > 0) {
    hinweise.push({ code: "ausserhalb_anstellung", text: `${fmtH(ausserhalb)} ausserhalb der Anstellung gestempelt — nicht bezahlt` });
  }
  if (ohneLohnMinuten > 0) {
    hinweise.push({ code: "ohne_lohn", text: `${fmtH(ohneLohnMinuten)} an Tagen mit Lohnzeile «kein Lohn»` });
  }
  if (anstellungen) {
    for (const a of anstellungen) {
      if (a.ruhendVon && a.ruhendVon <= letzter && (a.ruhendBis == null || a.ruhendBis >= erster)) {
        hinweise.push({ code: "ruhend", text: `Anstellung ruhend ${a.ruhendVon} bis ${a.ruhendBis ?? "offen"}` });
      }
    }
  }
  if (ferienJugendLetzterMonat) {
    hinweise.push({ code: "ferien_alter", text: "Letzter Monat mit Ferienzuschlag 10,64 % (20. Altersjahr vollendet)" });
  }

  const einheiten = (imMonat: Map<string, number>, rang: Map<string, number>, max: number, mitName: boolean): Einsatzeinheit[] =>
    Array.from(imMonat.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([datum, min]) => {
        const r = rang.get(datum) ?? 0;
        const name = mitName ? sonntagOderFeiertag(datum, feiertage) ?? undefined : undefined;
        return { datum, rang: r, minutenImMonat: min, mitZuschlag: r <= max, ...(name ? { name } : {}) };
      });
  const vorMonat = (alle: Set<string>) => Array.from(alle).filter((k) => k.startsWith(`${jahr}-`) && k < erster).length;

  return {
    kernVersion: KERN_VERSION,
    jahr,
    monat,
    auszahlungsdatum: e.auszahlungsdatum,
    auszahlungsjahr,
    lohnperiode: lohnperiode(jahr, monat, anstellungen),
    mengen: {
      minuten,
      sonntagMinutenMitZuschlag: sonntagMit,
      sonntagMinutenOhneZuschlag: sonntagOhne,
      nachtMinutenMitZuschlag: nachtMit,
      nachtMinutenOhneZuschlag: nachtOhne,
      zeitzuschlagMinuten,
      sonntage: einheiten(sonntageImMonat, rangSonntag, SONNTAG_MAX_JE_JAHR, true),
      naechte: einheiten(naechteImMonat, rangNacht, NACHT_MAX_JE_JAHR, false),
      sonntageImJahrVorMonat: vorMonat(v.sonntage),
      naechteImJahrVorMonat: vorMonat(v.naechte),
    },
    tage,
    positionen,
    brutto,
    loehne: { ahv: ahvLohn, alv: alvLohn, uvg: uvgLohn, uvgArt: nbu.versichert ? "bu_nbu" : "bu", quellensteuer: brutto },
    abzuege,
    totalAbzuege,
    netto,
    arbeitgeber,
    totalArbeitgeber,
    vollkosten: summeChf([brutto, totalArbeitgeber]),
    saetze: {
      herkunft: eigene ? "lohnzeile" : "firma",
      firmensatzAb: firmensatz.gueltigAb,
      lohnzeileId: eigene ? satzZeile?.id ?? null : null,
      an,
      ag,
      bvgSchwelleMonat: firmensatz.bvgSchwelleMonat,
    },
    nbu,
    ahv2500: {
      auszahlungsjahr,
      grenze: AHV_GERINGFUEGIG_GRENZE,
      ahvLohnBisher: bisher.ahvLohn,
      ahvLohnInklMonat: ahvInkl,
      verlangt,
      status,
    },
    hinweise,
  };
}

/** Nächte und Sonn-/Feiertage eines Kalenderjahres mit Rang (Lohn-Details). */
export function jahresEinsaetze(
  stempel: Stempel[],
  anstellungen: Anstellung[] | null,
  feiertageListe: { datum: string; name: string }[],
  jahr: number,
): {
  minuten: number;
  naechte: { datum: string; rang: number; minuten: number; mitZuschlag: boolean }[];
  sonntage: { datum: string; rang: number; minuten: number; mitZuschlag: boolean; name: string }[];
} {
  const feiertage = feiertagsKarte(feiertageListe);
  const v = verteile(stempel, anstellungen, feiertage);
  const rangN = rangImJahr(v.naechte);
  const rangS = rangImJahr(v.sonntage);
  const minN = new Map<string, number>();
  const minS = new Map<string, number>();
  let minuten = 0;
  for (const b of v.tage.values()) {
    if (b.datum.startsWith(`${jahr}-`)) minuten += b.minuten;
    for (const [k, m] of b.nacht) minN.set(k, (minN.get(k) ?? 0) + m);
    for (const [k, m] of b.sonntag) minS.set(k, (minS.get(k) ?? 0) + m);
  }
  const imJahr = (k: string) => k.startsWith(`${jahr}-`);
  return {
    minuten,
    naechte: Array.from(v.naechte).filter(imJahr).sort().map((d) => ({ datum: d, rang: rangN.get(d) ?? 0, minuten: minN.get(d) ?? 0, mitZuschlag: (rangN.get(d) ?? 0) <= NACHT_MAX_JE_JAHR })),
    sonntage: Array.from(v.sonntage).filter(imJahr).sort().map((d) => ({ datum: d, rang: rangS.get(d) ?? 0, minuten: minS.get(d) ?? 0, mitZuschlag: (rangS.get(d) ?? 0) <= SONNTAG_MAX_JE_JAHR, name: sonntagOderFeiertag(d, feiertage) ?? "Sonntag" })),
  };
}
