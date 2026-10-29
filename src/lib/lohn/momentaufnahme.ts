// Momentaufnahme einer Lohnabrechnung (Phase 2): Eingaben, Ergebnis des
// Rechenkerns und Druckangaben — die PDF wird AUSSCHLIESSLICH daraus gedruckt.
// Gleiche Momentaufnahme → byte-gleiche PDF (fester Erstellungszeitpunkt und
// Datei-ID), dadurch prüfbar: sha256(PDF) steht in der Momentaufnahme-Zeile.

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { jsPDF } from "jspdf";
import type { MonatsEingabe, MonatsErgebnis } from "./kern";
import { fmtProzent, summeChf } from "./kern";
import { formatAddressLine, type CompanySettings } from "@/lib/company-settings";
import { formatDateTimeFull } from "@/lib/format";

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export interface DruckAngaben {
  firma: CompanySettings;
  person: { name: string; email: string | null };
  /** ISO-Zeitpunkt — steht auf der PDF und in den PDF-Metadaten. */
  erstelltAm: string;
}

/** Was in lohn_momentaufnahmen.eingaben steht. */
export interface MomentaufnahmeEingaben {
  kern: MonatsEingabe;
  druck: DruckAngaben;
}

export interface Vorfassung {
  fassung: number;
  netto: number;
  auszahlungsdatum: string;
  art: string;
}

export interface Druckdaten {
  art: "regulaer" | "korrektur";
  fassung: number;
  /** Tag, an dem «auszahlung» ausbezahlt wird. */
  auszahlungsdatum: string;
  auszahlung: number;
  begruendung: string | null;
  vorfassung: Vorfassung | null;
  eingaben: MomentaufnahmeEingaben;
  ergebnis: MonatsErgebnis;
  pruefsumme: string;
}

/** JSON mit sortierten Schlüsseln (stabil für Prüfsummen). */
export function kanonischesJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(kanonischesJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${kanonischesJson(o[k])}`).join(",")}}`;
}

export function sha256Hex(inhalt: string | Uint8Array): string {
  return createHash("sha256").update(inhalt).digest("hex");
}

/** Prüfsumme über alles, was die Abrechnung bestimmt. */
export function pruefsummeMomentaufnahme(m: {
  art: string;
  auszahlungsdatum: string;
  auszahlung: number;
  vorfassung: Vorfassung | null;
  eingaben: unknown;
  ergebnis: unknown;
}): string {
  return sha256Hex(kanonischesJson(m));
}

const CHF = (n: number) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const H = (min: number) => {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
};
/** Kalendertag YYYY-MM-DD → TT.MM.JJJJ (reiner Text, keine Zeitzone im Spiel). */
const DATUM = (tag: string) => {
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tag);
  return t ? `${t[3]}.${t[2]}.${t[1]}` : tag;
};

let logoCache: string | null | undefined;
function logo(): string | null {
  if (logoCache !== undefined) return logoCache;
  try {
    const buf = fs.readFileSync(nodePath.join(process.cwd(), "public", "logo-gmbh-black.png"));
    logoCache = `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    logoCache = null;
  }
  return logoCache;
}

/** Lohnabrechnung aus der Momentaufnahme drucken (Art. 323b OR: Brutto,
 *  Zulagen, Abzüge, Netto; Ferienlohn und Feiertagsentschädigung separat). */
export function druckeLohnabrechnung(d: Druckdaten): Uint8Array {
  const e = d.ergebnis;
  const { firma, person, erstelltAm } = d.eingaben.druck;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setCreationDate(new Date(erstelltAm));
  doc.setFileId(d.pruefsumme.slice(0, 32).toUpperCase());
  const left = 20;
  const right = 190;
  const breite = right - left;
  let y = 18;

  const l = logo();
  if (l) doc.addImage(l, "PNG", left, y - 6, 11 * (800 / 185), 11);
  const adresse = formatAddressLine(firma);
  if (adresse) {
    doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(115);
    doc.text([firma.name, adresse].filter(Boolean).join(" · "), right, y + 8, { align: "right" });
  }
  y += 18;

  doc.setTextColor(20); doc.setFontSize(15); doc.setFont("helvetica", "bold");
  doc.text(d.art === "korrektur" ? "Korrektur-Lohnabrechnung" : "Lohnabrechnung", left, y);
  doc.setFontSize(11); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
  doc.text(`${MONATE[e.monat - 1]} ${e.jahr}`, right, y, { align: "right" });
  y += 7;
  doc.setDrawColor(210); doc.line(left, y, right, y); y += 8;

  doc.setFontSize(10);
  const info = (k: string, v: string) => {
    doc.setFont("helvetica", "bold"); doc.setTextColor(60); doc.text(k, left, y);
    doc.setFont("helvetica", "normal"); doc.setTextColor(40); doc.text(v, left + 38, y, { maxWidth: breite - 38 });
    y += 5.5;
  };
  info("Mitarbeiter/in", person.name);
  if (person.email) info("E-Mail", person.email);
  info("Lohnperiode", e.lohnperiode ? `${DATUM(e.lohnperiode.von)} – ${DATUM(e.lohnperiode.bis)}` : "keine Anstellung im Monat");
  info("Auszahlung am", DATUM(d.auszahlungsdatum));
  if (d.art === "korrektur" && d.vorfassung) {
    info("Ersetzt", `Fassung ${d.vorfassung.fassung} (Auszahlung ${DATUM(d.vorfassung.auszahlungsdatum)})`);
  }
  y += 2;
  doc.setDrawColor(210); doc.line(left, y, right, y); y += 7;
  doc.setTextColor(0);

  // Lohnarten
  const sp = { menge: right - 70, ansatz: right - 38 };
  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.text("Lohnart", left, y); doc.text("Menge", sp.menge, y, { align: "right" }); doc.text("Ansatz", sp.ansatz, y, { align: "right" }); doc.text("CHF", right, y, { align: "right" });
  y += 5;
  doc.setFont("helvetica", "normal");
  if (e.positionen.length === 0) {
    doc.text("Keine Stunden in diesem Monat", left, y); doc.text(CHF(0), right, y, { align: "right" }); y += 5;
  }
  for (const p of e.positionen) {
    const zeilen: string[] = doc.splitTextToSize(p.bezeichnung, sp.menge - left - 22);
    doc.text(zeilen, left, y);
    if (p.minuten != null) doc.text(H(p.minuten), sp.menge, y, { align: "right" });
    else if (p.basis != null) doc.text(`von ${CHF(p.basis)}`, sp.menge, y, { align: "right" });
    if (p.ansatz != null) doc.text(CHF(p.ansatz), sp.ansatz, y, { align: "right" });
    else if (p.prozent != null) doc.text(fmtProzent(p.prozent), sp.ansatz, y, { align: "right" });
    doc.text(CHF(p.betrag), right, y, { align: "right" });
    y += 5 + (zeilen.length - 1) * 4.5;
  }
  y += 1;
  doc.setDrawColor(200); doc.line(left, y, right, y); y += 5;
  doc.setFont("helvetica", "bold");
  doc.text("Bruttolohn", left, y); doc.text(CHF(e.brutto), right, y, { align: "right" });
  y += 8;

  // Abzüge
  doc.text("Abzüge", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  for (const a of e.abzuege) {
    const hinterlegt = e.saetze.an[a.art === "ahv_iv_eo" ? "ahvIvEo" : a.art];
    if (a.art === "nbu" && !e.nbu.versichert && hinterlegt > 0) {
      const z: string[] = doc.splitTextToSize(`NBU: ${e.nbu.begruendung}`, breite - 30);
      doc.text(z, left, y); doc.text(CHF(0), right, y, { align: "right" });
      y += 5 + (z.length - 1) * 4.5;
      continue;
    }
    if (a.prozent === 0) continue;
    doc.text(`${a.bezeichnung} ${fmtProzent(a.prozent)}`, left, y);
    doc.text(`von ${CHF(a.basis)}`, sp.ansatz, y, { align: "right" });
    doc.text(`– ${CHF(a.betrag)}`, right, y, { align: "right" });
    y += 5;
  }
  y += 1;
  doc.setFont("helvetica", "bold");
  doc.text("Total Abzüge", left, y); doc.text(`– ${CHF(e.totalAbzuege)}`, right, y, { align: "right" });
  y += 7;
  doc.setDrawColor(80); doc.line(left, y, right, y); y += 7;
  doc.setFontSize(12);
  doc.text("Nettolohn", left, y); doc.text(`CHF ${CHF(e.netto)}`, right, y, { align: "right" });
  y += 7;
  if (d.art === "korrektur" && d.vorfassung) {
    doc.setFontSize(10); doc.setFont("helvetica", "normal");
    doc.text(`Bereits ausbezahlt (Fassung ${d.vorfassung.fassung})`, left, y); doc.text(`– ${CHF(d.vorfassung.netto)}`, right, y, { align: "right" });
    y += 6;
    doc.setFontSize(12); doc.setFont("helvetica", "bold");
    doc.text(d.auszahlung >= 0 ? "Nachzahlung" : "Rückforderung", left, y);
    doc.text(`CHF ${CHF(Math.abs(d.auszahlung))}`, right, y, { align: "right" });
    y += 7;
  } else {
    doc.setFontSize(12);
    doc.text("Auszahlung", left, y); doc.text(`CHF ${CHF(d.auszahlung)}`, right, y, { align: "right" });
    y += 7;
  }

  // Hinweise und Fuss
  doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
  y += 3;
  const fuss: string[] = [];
  if (d.begruendung) fuss.push(`Begründung: ${d.begruendung}`);
  for (const h of e.hinweise) fuss.push(h.text);
  if (e.mengen.sonntagMinutenMitZuschlag + e.mengen.sonntagMinutenOhneZuschlag > 0) {
    fuss.push(`Sonntag = Samstag 23 Uhr bis Sonntag 23 Uhr (Feiertage gleich). Sonn-/Feiertage im Jahr vor diesem Monat: ${e.mengen.sonntageImJahrVorMonat}.`);
  }
  if (e.mengen.nachtMinutenMitZuschlag + e.mengen.nachtMinutenOhneZuschlag > 0) {
    fuss.push(`Nacht = 23 bis 6 Uhr, eine Nacht zählt im Jahr ihres Beginns. Nächte im Jahr vor diesem Monat: ${e.mengen.naechteImJahrVorMonat}.`);
  }
  fuss.push(`Arbeitgeberbeiträge (AHV/IV/EO, ALV, FAK, BU, BVG, VK): CHF ${CHF(e.totalArbeitgeber)}.`);
  fuss.push("Der Lohnausweis wird jährlich separat erstellt.");
  for (const t of fuss) {
    const z: string[] = doc.splitTextToSize(t, breite);
    if (y + z.length * 3.6 > 285) break;
    doc.text(z, left, y);
    y += z.length * 3.5 + 0.8;
  }
  doc.setTextColor(140);
  const erstellt = formatDateTimeFull(erstelltAm);
  doc.text(`Fassung ${d.fassung} · erstellt ${erstellt} · Kern ${e.kernVersion} · Prüfsumme ${d.pruefsumme.slice(0, 16)}`, left, 290);

  return new Uint8Array(doc.output("arraybuffer"));
}

/** Werte der Momentaufnahme-Zeile aus dem Ergebnis. */
export function zeilenWerte(e: MonatsErgebnis) {
  return {
    brutto: e.brutto,
    total_abzuege: e.totalAbzuege,
    netto: e.netto,
    ahv_lohn: e.loehne.ahv,
    alv_lohn: e.loehne.alv,
    uvg_lohn: e.loehne.uvg,
    uvg_art: e.loehne.uvgArt,
    quellensteuer: e.abzuege.find((a) => a.art === "quellensteuer")?.betrag ?? 0,
  };
}

/** Auszahlung einer Fassung (regulär = Netto, Korrektur = Differenz). */
export function auszahlungBetrag(e: MonatsErgebnis, vorfassung: Vorfassung | null): number {
  return vorfassung ? summeChf([e.netto, -vorfassung.netto]) : e.netto;
}
