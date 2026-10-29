// Momentaufnahme einer Lohnabrechnung (Phase 2): Eingaben, Ergebnis des
// Rechenkerns und Druckangaben — die PDF wird AUSSCHLIESSLICH daraus gedruckt.
// Gleiche Momentaufnahme → byte-gleiche PDF (fester Erstellungszeitpunkt und
// Datei-ID), dadurch prüfbar: sha256(PDF) steht in der Momentaufnahme-Zeile.

import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { jsPDF } from "jspdf";
import type { Abzug, AbzugArt, MonatsEingabe, MonatsErgebnis } from "./kern";
import { ABZUG_KLARTEXT, fmtProzent, summeChf } from "./kern";
import { formatAddressLine, type CompanySettings } from "@/lib/company-settings";
import { formatDateTimeFull } from "@/lib/format";

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export interface DruckAngaben {
  firma: CompanySettings;
  /** email: seit Phase 4 null (steht nicht auf der Abrechnung, nicht speichern). */
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
  /** Phase 4 — für «bisher → neu» auf der Korrekturfassung. */
  brutto?: number;
  totalAbzuege?: number;
  /** Netto + Spesen der Vorfassung; null = Fassung vor Phase 4 (= Netto). */
  auszahlungsbetrag?: number | null;
  /** Erstellt am (Zeitpunkt). */
  erstelltAm?: string | null;
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
/** Zeitpunkt → Kalendertag in Zürich (TT.MM.JJJJ). */
const DATUM_ZEIT = (iso: string) =>
  new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));

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

/** Hinweise des Kerns, die die Person betreffen — interne (Anstellung nicht
 *  erfasst, BVG-Schwelle prüfen, Quellensteuer-Tarif, Zusatzposten-Quellensteuer,
 *  «kein Lohn») bleiben in der Lohnverwaltung. */
const HINWEISE_FUER_PERSON = new Set<string>([
  "ausserhalb_anstellung",
  "ruhend",
  "offener_stempel",
  "ueberlappung",
  "ahv_2500",
  "zeitzuschlag",
  "sonntag_limit",
  "ferien_alter",
]);

// jsPDF-Standardschrift (Helvetica, WinAnsi): Zeichen ausserhalb dieses
// Satzes würden als Zeichensalat gedruckt. Frei erfasste Texte (Bezeichnung,
// Begründung, Name) werden deshalb ehrlich ersetzt: Akzente abgelöst, sonst «?».
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function druckbar(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (ch === "\n" || ch === "\t") { out += " "; continue; }
    if (ch === "→") { out += "->"; continue; }
    const ohneAkzent = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += /^[\x20-\x7e]+$/.test(ohneAkzent) ? ohneAkzent : "?";
  }
  return out;
}

/** Abzug in Klartext — nie den Code-Namen («ahv_iv_eo») drucken. */
function abzugText(a: Abzug): string {
  return ABZUG_KLARTEXT[a.art] ?? "Abzug";
}

/** Betrag mit Vorzeichen für Differenzen («+ 12.30», «– 4.10», «0.00»). */
const DIFF = (n: number) => (n > 0.004 ? `+ ${CHF(n)}` : n < -0.004 ? `– ${CHF(-n)}` : CHF(0));

/** Lohnabrechnung aus der Momentaufnahme drucken (Art. 323b OR: Brutto,
 *  Zulagen, Abzüge, Netto; Ferienlohn und Feiertagsentschädigung separat).
 *  Für die Person: Abzüge in Klartext, keine internen Angaben (keine
 *  Arbeitgeberbeiträge/Vollkosten, keine Rolle, keine Mail), Auszahlungsdatum
 *  klar; Zusatzposten (Lohn im Brutto, Rückerstattungen bei den Abzügen,
 *  Spesen nach dem Netto); Korrekturfassung mit Vorfassung und Differenz. */
export function druckeLohnabrechnung(d: Druckdaten): Uint8Array {
  const e = d.ergebnis;
  const { firma, person, erstelltAm } = d.eingaben.druck;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.setCreationDate(new Date(erstelltAm));
  doc.setFileId(d.pruefsumme.slice(0, 32).toUpperCase());
  const left = 20;
  const right = 190;
  const breite = right - left;
  const UNTEN = 278;
  let y = 18;
  /** Platz für h mm, sonst neue Seite. */
  const platz = (h: number) => {
    if (y + h <= UNTEN) return;
    doc.addPage();
    y = 20;
  };

  const l = logo();
  if (l) doc.addImage(l, "PNG", left, y - 6, 11 * (800 / 185), 11);
  const adresse = formatAddressLine(firma);
  if (adresse) {
    doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(115);
    doc.text(druckbar([firma.name, adresse].filter(Boolean).join(" · ")), right, y + 8, { align: "right" });
  }
  y += 18;

  const korrektur = d.art === "korrektur" && d.vorfassung != null;
  doc.setTextColor(20); doc.setFontSize(15); doc.setFont("helvetica", "bold");
  doc.text(korrektur ? "Korrektur-Lohnabrechnung" : "Lohnabrechnung", left, y);
  doc.setFontSize(11); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
  doc.text(`${MONATE[e.monat - 1]} ${e.jahr}`, right, y, { align: "right" });
  y += 7;
  doc.setDrawColor(210); doc.line(left, y, right, y); y += 8;

  doc.setFontSize(10);
  const info = (k: string, v: string) => {
    doc.setFont("helvetica", "bold"); doc.setTextColor(60); doc.text(k, left, y);
    doc.setFont("helvetica", "normal"); doc.setTextColor(40); doc.text(druckbar(v), left + 38, y, { maxWidth: breite - 38 });
    y += 5.5;
  };
  info("Mitarbeiter/in", person.name);
  info("Lohnperiode", e.lohnperiode ? `${DATUM(e.lohnperiode.von)} – ${DATUM(e.lohnperiode.bis)}` : "keine Anstellung im Monat");
  info("Auszahlung am", DATUM(d.auszahlungsdatum));
  if (korrektur && d.vorfassung) {
    const vom = d.vorfassung.erstelltAm ? ` vom ${DATUM_ZEIT(d.vorfassung.erstelltAm)}` : "";
    info("Ersetzt", `Fassung ${d.vorfassung.fassung}${vom} (Auszahlung ${DATUM(d.vorfassung.auszahlungsdatum)})`);
  }
  y += 2;
  doc.setDrawColor(210); doc.line(left, y, right, y); y += 7;
  doc.setTextColor(0);

  // Lohnarten (inkl. Zusatzposten «Lohn»)
  const sp = { menge: right - 70, ansatz: right - 38 };
  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.text("Lohnart", left, y); doc.text("Menge", sp.menge, y, { align: "right" }); doc.text("Ansatz", sp.ansatz, y, { align: "right" }); doc.text("CHF", right, y, { align: "right" });
  y += 5;
  doc.setFont("helvetica", "normal");
  if (e.positionen.length === 0) {
    doc.text("Keine Stunden in diesem Monat", left, y); doc.text(CHF(0), right, y, { align: "right" }); y += 5;
  }
  for (const p of e.positionen) {
    const zeilen: string[] = doc.splitTextToSize(druckbar(p.bezeichnung), sp.menge - left - 22);
    platz(5 + (zeilen.length - 1) * 4.5);
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

  // Abzüge in Klartext; Rückerstattungen als eigene Zeile («+»)
  platz(12);
  doc.text("Abzüge", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  for (const a of e.abzuege) {
    if (a.rueckerstattung) {
      const z: string[] = doc.splitTextToSize(druckbar(`Rückerstattung ${abzugText(a)}: ${a.bezeichnung}`), breite - 30);
      platz(5 + (z.length - 1) * 4.5);
      doc.text(z, left, y); doc.text(DIFF(-a.betrag), right, y, { align: "right" });
      y += 5 + (z.length - 1) * 4.5;
      continue;
    }
    const hinterlegt = e.saetze.an[a.art === "ahv_iv_eo" ? "ahvIvEo" : a.art];
    if (a.art === "nbu" && !e.nbu.versichert && hinterlegt > 0) {
      const z: string[] = doc.splitTextToSize(druckbar(`${abzugText(a)}: ${e.nbu.begruendung}`), breite - 30);
      platz(5 + (z.length - 1) * 4.5);
      doc.text(z, left, y); doc.text(CHF(0), right, y, { align: "right" });
      y += 5 + (z.length - 1) * 4.5;
      continue;
    }
    if (a.prozent === 0) continue;
    platz(5);
    doc.text(`${abzugText(a)} ${fmtProzent(a.prozent)}`, left, y);
    doc.text(`von ${CHF(a.basis)}`, sp.ansatz, y, { align: "right" });
    doc.text(DIFF(-a.betrag), right, y, { align: "right" });
    y += 5;
  }
  y += 1;
  doc.setFont("helvetica", "bold");
  platz(14);
  doc.text("Total Abzüge", left, y); doc.text(DIFF(-e.totalAbzuege), right, y, { align: "right" });
  y += 7;
  doc.setDrawColor(80); doc.line(left, y, right, y); y += 7;
  doc.setFontSize(12);
  doc.text("Nettolohn", left, y); doc.text(`CHF ${CHF(e.netto)}`, right, y, { align: "right" });
  y += 7;

  // Spesen nach dem Netto
  const spesen = (e.zusatzposten ?? []).filter((z) => z.art === "spesen");
  const spesenTotal = e.spesen ?? 0;
  if (spesen.length > 0) {
    doc.setFontSize(10); doc.setFont("helvetica", "bold");
    platz(10);
    doc.text("Spesen (nicht im Bruttolohn)", left, y); y += 5;
    doc.setFont("helvetica", "normal");
    for (const z of spesen) {
      const t: string[] = doc.splitTextToSize(druckbar(z.bezeichnung), breite - 30);
      platz(5 + (t.length - 1) * 4.5);
      doc.text(t, left, y); doc.text(DIFF(z.betrag), right, y, { align: "right" });
      y += 5 + (t.length - 1) * 4.5;
    }
    y += 2;
  }
  const betragMonat = e.auszahlungsbetrag ?? e.netto;

  doc.setFontSize(12); doc.setFont("helvetica", "bold");
  if (korrektur && d.vorfassung) {
    const v = d.vorfassung;
    if (spesen.length > 0) {
      platz(7);
      doc.text("Total Monat (Netto + Spesen)", left, y); doc.text(`CHF ${CHF(betragMonat)}`, right, y, { align: "right" });
      y += 7;
    }
    // Vorfassung und Differenz als Tabelle (kein Pfeil-Zeichen nötig).
    y += 2;
    platz(42);
    doc.setDrawColor(210); doc.line(left, y, right, y); y += 6;
    doc.setFontSize(10);
    const vom = v.erstelltAm ? ` vom ${DATUM_ZEIT(v.erstelltAm)}` : "";
    doc.text(`Korrektur gegenüber Fassung ${v.fassung}${vom}`, left, y); y += 6;
    const col = { alt: right - 70, neu: right - 35 };
    doc.setFontSize(9);
    doc.text(`Fassung ${v.fassung} (bisher)`, col.alt, y, { align: "right" });
    doc.text(`Fassung ${d.fassung} (neu)`, col.neu, y, { align: "right" });
    doc.text("Differenz", right, y, { align: "right" });
    y += 5;
    doc.setFont("helvetica", "normal");
    const vergleich = (k: string, alt: number | null | undefined, neu: number) => {
      platz(5);
      doc.text(k, left, y);
      doc.text(alt == null ? "–" : CHF(alt), col.alt, y, { align: "right" });
      doc.text(CHF(neu), col.neu, y, { align: "right" });
      doc.text(alt == null ? "–" : DIFF(summeChf([neu, -alt])), right, y, { align: "right" });
      y += 5;
    };
    vergleich("Bruttolohn", v.brutto, e.brutto);
    vergleich("Total Abzüge", v.totalAbzuege, e.totalAbzuege);
    vergleich("Nettolohn", v.netto, e.netto);
    const vorBetrag = v.auszahlungsbetrag ?? v.netto;
    if (spesen.length > 0 || Math.abs(vorBetrag - v.netto) > 0.004) vergleich("Auszahlung (Netto + Spesen)", vorBetrag, betragMonat);
    y += 2;
    doc.setFontSize(12); doc.setFont("helvetica", "bold");
    platz(7);
    if (Math.abs(d.auszahlung) < 0.005) {
      doc.text("Keine Nachzahlung (Betrag unverändert)", left, y);
    } else {
      doc.text(`${d.auszahlung > 0 ? "Nachzahlung" : "Rückforderung"} am ${DATUM(d.auszahlungsdatum)}`, left, y);
      doc.text(`CHF ${CHF(Math.abs(d.auszahlung))}`, right, y, { align: "right" });
    }
    y += 7;
  } else {
    platz(7);
    doc.text(`Auszahlung am ${DATUM(d.auszahlungsdatum)}`, left, y); doc.text(`CHF ${CHF(d.auszahlung)}`, right, y, { align: "right" });
    y += 7;
  }

  // Hinweise und Fuss (nur was die Person betrifft)
  doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
  y += 3;
  const fuss: string[] = [];
  if (d.begruendung) fuss.push(`Begründung der Korrektur: ${d.begruendung}`);
  for (const h of e.hinweise) if (HINWEISE_FUER_PERSON.has(h.code)) fuss.push(h.text);
  if (e.mengen.sonntagMinutenMitZuschlag + e.mengen.sonntagMinutenOhneZuschlag > 0) {
    fuss.push(`Sonntag = Samstag 23 Uhr bis Sonntag 23 Uhr (Feiertage gleich). Sonn-/Feiertage im Jahr vor diesem Monat: ${e.mengen.sonntageImJahrVorMonat}.`);
  }
  if (e.mengen.nachtMinutenMitZuschlag + e.mengen.nachtMinutenOhneZuschlag > 0) {
    fuss.push(`Nacht = 23 bis 6 Uhr, eine Nacht zählt im Jahr ihres Beginns. Nächte im Jahr vor diesem Monat: ${e.mengen.naechteImJahrVorMonat}.`);
  }
  if (spesenTotal !== 0) fuss.push("Spesen sind Auslagenersatz: nicht im Bruttolohn, keine Sozialabzüge.");
  fuss.push("Der Lohnausweis wird jährlich separat erstellt.");
  for (const t of fuss) {
    const z: string[] = doc.splitTextToSize(druckbar(t), breite);
    platz(z.length * 3.6);
    doc.text(z, left, y);
    y += z.length * 3.5 + 0.8;
  }
  const seiten = doc.getNumberOfPages();
  const erstellt = formatDateTimeFull(erstelltAm);
  for (let i = 1; i <= seiten; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(140);
    doc.text(`Fassung ${d.fassung} · erstellt ${erstellt} · Kern ${e.kernVersion} · Prüfsumme ${d.pruefsumme.slice(0, 16)}${seiten > 1 ? ` · Seite ${i}/${seiten}` : ""}`, left, 290);
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

/** Summe der Abzüge einer Art (Rückerstattungen eingerechnet). */
export function abzugNetto(e: Pick<MonatsErgebnis, "abzuege">, art: AbzugArt): number {
  return summeChf(e.abzuege.filter((a) => a.art === art).map((a) => a.betrag));
}

/** Werte der Momentaufnahme-Zeile aus dem Ergebnis. */
export function zeilenWerte(e: MonatsErgebnis) {
  return {
    brutto: e.brutto,
    total_abzuege: e.totalAbzuege,
    netto: e.netto,
    // Phase 4: ausbezahlt wird Netto + Spesen (RPC rechnet die Auszahlung damit).
    auszahlungsbetrag: e.auszahlungsbetrag,
    ahv_lohn: e.loehne.ahv,
    alv_lohn: e.loehne.alv,
    uvg_lohn: e.loehne.uvg,
    uvg_art: e.loehne.uvgArt,
    // netto nach Rückerstattungen (Jahresliste, Lohnausweis Ziff. 12)
    quellensteuer: abzugNetto(e, "quellensteuer"),
  };
}

/** Auszahlung einer Fassung (regulär = Netto + Spesen, Korrektur = Differenz
 *  zum Auszahlungsbetrag der Vorfassung; vor Phase 4 = deren Netto). Gleiche
 *  Regel wie die DB (lohn_momentaufnahme_speichern, Migration 367). */
export function auszahlungBetrag(e: MonatsErgebnis, vorfassung: Vorfassung | null): number {
  const jetzt = e.auszahlungsbetrag ?? e.netto;
  return vorfassung ? summeChf([jetzt, -(vorfassung.auszahlungsbetrag ?? vorfassung.netto)]) : jetzt;
}
