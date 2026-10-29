// Lohnausweis (Formular 11) und Lohnbescheinigung AK 40 aus der Jahresliste
// (Lohn-Umbau Phase 4). Nur Server.
//
// VORLAGE: das OFFIZIELLE, ausfüllbare ESTV-Formular 11 (AcroForm, 44 Felder)
//   src/lib/lohn/vorlagen/estv-form11-lohnausweis-dfi-rechts.pdf
//   Herkunft: https://www.estv.admin.ch/estv/de/home/direkte-bundessteuer/lohnausweis.html
//             → «Adresse rechts, d/f/i» (dbst-form-11lohna-rechts-dfi-de.pdf, ESTV-Datum 09.10.2023)
//   Stand:    Fusszeile «Form. 11 dfi 605.040.18N 01.21»; gilt laut Wegleitung 2026
//             (ESTV/SSK, gültig ab 01.01.2026). Heruntergeladen am 29.10.2026,
//             sha256 683cd4f6…cbf0 (unten geprüft — eine andere Datei wird abgelehnt).
//   Neue Fassung der ESTV: Datei ersetzen, VORLAGE_SHA256 nachführen, Feldnamen
//   prüfen (lohnausweis.test.ts füllt die Vorlage).
//
// Regeln (Wegleitung zum Ausfüllen, ESTV 2026):
//   - Kalenderjahr D = Auszahlungsjahr (Zuflussprinzip): die Jahresliste auf
//     Basis Auszahlungsjahr, Korrektur-Differenzen im Jahr ihrer Auszahlung.
//   - Nur ganze Franken (Formular). Ziff. 1, 7, 9, 10.1, 12, 13 je
//     kaufmännisch gerundet; Ziff. 8 = 1 + 7, Ziff. 11 = 8 − 9 − 10.1
//     (Rz 47: Nettolohn = Bruttolohn − Abzüge) — so stimmen die Summen.
//   - Ziff. 1 Lohn = steuerbarer Lohn ohne steuerbare Zusatzposten; Ziff. 7
//     andere Leistungen = steuerbare Zusatzposten «Lohn» mit Bezeichnung
//     (Rz 39: «Quellensteuer vom Arbeitgeber bezahlt»). Nicht steuerbare
//     Zusatzposten stehen nicht im Lohnausweis.
//   - Ziff. 9 = AHV/IV/EO + ALV + NBU netto (nach Rückerstattungen, Rz 42:
//     der beim Arbeitnehmer abgezogene Anteil); Ziff. 10.1 = BVG; Ziff. 12 =
//     Quellensteuer netto; Ziff. 13.1.2 = effektive Spesen (Zusatzposten
//     «Spesen», Art = Bezeichnungen).
//   - Ziff. 15 Bemerkungen: Teilzeit/Stundenlohn (Rz 66a), Tage Militär-/
//     Zivildienst (Erwerbsausfall, Rz 64 — keine EO-Rechnung, nur Hinweis),
//     Krankentaggeld-Beiträge (Rz 42: nicht abziehbar, in Ziff. 15).
//   - E Lohnperiode = Anstellung im Kalenderjahr (Rz 8), sonst die Lohnperioden
//     der Abrechnungen.
//   - Personalien (AHV-Nr., Adresse) liegen NICHT im ERP (gehören ins
//     Backoffice «Trust flow»): sichtbar rote Platzhalter, oder eine
//     hochgeladene CSV, die nur im Speicher für diesen Druck gelesen wird.
//
// AK 40 (Lohnbescheinigung der Ausgleichskasse): je Person AHV-Lohn, davon
// beitragsfrei (2'500-Grenze), ALV-Lohn, Zeitraum, AHV-Nr. — CSV mit «;» und
// UTF-8-BOM (Excel), Beträge mit Punkt und zwei Stellen.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFTextField, StandardFonts, type PDFFont } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { plusTage, summeChf } from "./kern";
import { jahresliste, type JahreslistenZeile } from "./jahresliste";
import { druckbar } from "./momentaufnahme";
import { ladeAlleSeiten, ladeJahreslisteDaten } from "./daten";
import type { CompanySettings } from "@/lib/company-settings";

export const VORLAGE_PFAD = nodePath.join("src", "lib", "lohn", "vorlagen", "estv-form11-lohnausweis-dfi-rechts.pdf");
export const VORLAGE_SHA256 = "683cd4f6331aedddff6fd7dc8f713d8a2703a8eb4cf21a18d98bc3102604cbf0";

/** Offizielle Vorlage laden und prüfen (nie eine fremde Datei befüllen). */
export async function ladeVorlage(): Promise<Uint8Array> {
  const buf = await readFile(nodePath.join(process.cwd(), VORLAGE_PFAD));
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== VORLAGE_SHA256) throw new Error(`Lohnausweis-Vorlage verändert (sha256 ${sha.slice(0, 12)}…) — Datei prüfen`);
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Personalien (optionale CSV, nur im Speicher)
// ---------------------------------------------------------------------------

export const PERSONALIEN_SPALTEN = ["profile_id", "name", "ahv_nr", "geburtsdatum", "strasse", "adresszusatz", "plz", "ort"] as const;
export type Personalien = Partial<Record<(typeof PERSONALIEN_SPALTEN)[number], string>> & { profile_id: string };

const BOM = "﻿";
function csvFeld(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function csvZeilen(zeilen: (string | number | null | undefined)[][]): string {
  return BOM + zeilen.map((z) => z.map(csvFeld).join(";")).join("\r\n") + "\r\n";
}

/** CSV-Vorlage: je Person eine Zeile mit profile_id, Name (und Geburtsdatum aus dem ERP), Rest leer. */
export function personalienVorlage(personen: { profile_id: string; name: string; geburtsdatum: string | null }[]): string {
  return csvZeilen([
    [...PERSONALIEN_SPALTEN],
    ...personen.map((p) => [p.profile_id, p.name, "", p.geburtsdatum ? datumCh(p.geburtsdatum) : "", "", "", "", ""]),
  ]);
}

/** CSV lesen (Trenner «;» oder «,», Anführungszeichen, BOM). */
export function leseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const ersteZeile = t.split(/\r?\n/, 1)[0] ?? "";
  const trenner = (ersteZeile.match(/;/g)?.length ?? 0) >= (ersteZeile.match(/,/g)?.length ?? 0) ? ";" : ",";
  const zeilen: string[][] = [];
  let feld = "";
  let zeile: string[] = [];
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"' && t[i + 1] === '"') { feld += '"'; i++; } else if (c === '"') inQ = false; else feld += c;
    } else if (c === '"') inQ = true;
    else if (c === trenner) { zeile.push(feld); feld = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      zeile.push(feld); feld = "";
      if (zeile.some((x) => x.trim() !== "")) zeilen.push(zeile);
      zeile = [];
    } else feld += c;
  }
  zeile.push(feld);
  if (zeile.some((x) => x.trim() !== "")) zeilen.push(zeile);
  return zeilen;
}

/** AHV-Nummer (756.XXXX.XXXX.XX, EAN-13-Prüfziffer) → formatiert, sonst null. */
export function ahvNummer(roh: string): string | null {
  const z = roh.replace(/\D/g, "");
  if (z.length !== 13 || !z.startsWith("756")) return null;
  let summe = 0;
  for (let i = 0; i < 12; i++) summe += Number(z[i]) * (i % 2 === 0 ? 1 : 3);
  if ((10 - (summe % 10)) % 10 !== Number(z[12])) return null;
  return `${z.slice(0, 3)}.${z.slice(3, 7)}.${z.slice(7, 11)}.${z.slice(11)}`;
}

/** Personalien-CSV lesen (Kopfzeile mit den Spaltennamen der Vorlage). Fehler je Zeile, nie stilles Raten. */
export function lesePersonalien(text: string): { daten: Map<string, Personalien>; fehler: string[] } {
  const zeilen = leseCsv(text);
  const daten = new Map<string, Personalien>();
  const fehler: string[] = [];
  if (zeilen.length === 0) return { daten, fehler: ["Personalien-CSV ist leer"] };
  const kopf = zeilen[0].map((k) => k.trim().toLowerCase());
  const idx = Object.fromEntries(PERSONALIEN_SPALTEN.map((k) => [k, kopf.indexOf(k)])) as Record<(typeof PERSONALIEN_SPALTEN)[number], number>;
  if (idx.profile_id < 0) return { daten, fehler: ["Personalien-CSV: Spalte «profile_id» fehlt (Vorlage verwenden)"] };
  for (let i = 1; i < zeilen.length; i++) {
    const z = zeilen[i];
    const wert = (k: (typeof PERSONALIEN_SPALTEN)[number]) => (idx[k] >= 0 ? (z[idx[k]] ?? "").trim() : "");
    const id = wert("profile_id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) { fehler.push(`Zeile ${i + 1}: profile_id fehlt oder ungültig`); continue; }
    const p: Personalien = { profile_id: id };
    for (const k of PERSONALIEN_SPALTEN) if (k !== "profile_id" && wert(k)) p[k] = wert(k);
    if (p.ahv_nr) {
      const f = ahvNummer(p.ahv_nr);
      if (!f) fehler.push(`Zeile ${i + 1} (${p.name ?? id}): AHV-Nr. «${p.ahv_nr}» ungültig (756.XXXX.XXXX.XX, Prüfziffer)`);
      else p.ahv_nr = f;
    }
    if (p.geburtsdatum && !isoAusCh(p.geburtsdatum)) fehler.push(`Zeile ${i + 1} (${p.name ?? id}): Geburtsdatum «${p.geburtsdatum}» ungültig (TT.MM.JJJJ)`);
    daten.set(id, p);
  }
  return { daten, fehler };
}

// ---------------------------------------------------------------------------
// Werte des Lohnausweises
// ---------------------------------------------------------------------------

/** Kaufmännisch auf ganze Franken (halbe weg von null). */
export function franken(x: number): number {
  const v = Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
  return v === 0 ? 0 : v;
}

const datumCh = (iso: string) => {
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return t ? `${t[3]}.${t[2]}.${t[1]}` : iso;
};
function isoAusCh(s: string): string | null {
  const t = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim()) ?? null;
  if (t) return `${t[3]}-${t[2].padStart(2, "0")}-${t[1].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null;
}

export interface AnstellungFuerAusweis {
  eintritt: string;
  austritt: string | null;
  vertragsart: string | null;
  pensum_pct: number | null;
}

export interface LohnausweisWerte {
  profileId: string;
  name: string;
  jahr: number;
  /** E: Lohnperiode im Kalenderjahr (ISO). */
  von: string | null;
  bis: string | null;
  geburtsdatum: string | null;
  ziffer1: number;
  ziffer7: number;
  ziffer7Art: string;
  ziffer8: number;
  ziffer9: number;
  ziffer10_1: number;
  ziffer11: number;
  ziffer12: number;
  ziffer13_1_2: number;
  ziffer13Art: string;
  bemerkungen: string[];
  /** Ungerundete Summen (CHF) — für Prüfungen und die Vorschau. */
  chf: { steuerbar: number; zusatzSteuerbar: number; beitraege: number; bvg: number; quellensteuer: number; spesen: number; ktg: number };
}

/**
 * Werte aus den Jahreslisten-Zeilen EINER Person (Basis Auszahlungsjahr =
 * jahr). anstellungen: lohn_anstellungen der Person; eoTage: Tage mit
 * Militär-/Zivildienst im Kalenderjahr.
 */
export function lohnausweisWerte(a: {
  profileId: string;
  name: string;
  jahr: number;
  geburtsdatum: string | null;
  zeilen: JahreslistenZeile[];
  anstellungen: AnstellungFuerAusweis[];
  eoTage: number;
}): LohnausweisWerte {
  const z = a.zeilen.filter((x) => x.profile_id === a.profileId && x.auszahlungsjahr === a.jahr);
  const s = (k: keyof JahreslistenZeile) => summeChf(z.map((x) => Number(x[k])));
  const steuerbar = s("steuerbar");
  const zusatzSteuerbar = s("zusatz_steuerbar");
  const beitraege = summeChf([s("abzug_ahv_iv_eo"), s("abzug_alv"), s("abzug_nbu")]);
  const bvg = s("abzug_bvg");
  const ktg = s("abzug_ktg");
  const quellensteuer = s("quellensteuer");
  const spesen = s("spesen");

  const ziffer1 = franken(summeChf([steuerbar, -zusatzSteuerbar]));
  const ziffer7 = franken(zusatzSteuerbar);
  const ziffer8 = ziffer1 + ziffer7;
  const ziffer9 = franken(beitraege);
  const ziffer10_1 = franken(bvg);
  const ziffer11 = ziffer8 - ziffer9 - ziffer10_1;
  const texte7 = Array.from(new Set(z.flatMap((x) => x.zusatz_texte)));
  const texte13 = Array.from(new Set(z.flatMap((x) => x.spesen_texte)));

  const { von, bis } = lohnperiodeImJahr(a.jahr, a.anstellungen, z);
  const jA = `${a.jahr}-01-01`;
  const jE = `${a.jahr}-12-31`;

  const bemerkungen: string[] = [];
  const imJahr = a.anstellungen.filter((an) => an.eintritt <= jE && (an.austritt ?? jE) >= jA);
  if (imJahr.some((an) => (an.vertragsart != null && an.vertragsart !== "fest") || (an.pensum_pct != null && Number(an.pensum_pct) < 100))) {
    bemerkungen.push("Teilzeitbeschäftigung im Stundenlohn");
  }
  if (a.eoTage > 0) bemerkungen.push(`Lohnfortzahlung/EO: ${a.eoTage} ${a.eoTage === 1 ? "Tag" : "Tage"} Militär-/Zivildienst`);
  if (franken(ktg) !== 0) bemerkungen.push(`Beiträge Krankentaggeldversicherung CHF ${zahlCh(franken(ktg))}`);

  return {
    profileId: a.profileId,
    name: a.name,
    jahr: a.jahr,
    von,
    bis,
    geburtsdatum: a.geburtsdatum,
    ziffer1,
    ziffer7,
    ziffer7Art: texte7.join("; "),
    ziffer8,
    ziffer9,
    ziffer10_1,
    ziffer11,
    ziffer12: franken(quellensteuer),
    ziffer13_1_2: franken(spesen),
    ziffer13Art: texte13.length > 0 ? `Effektive Spesen: ${texte13.join("; ")}` : "",
    bemerkungen,
    chf: { steuerbar, zusatzSteuerbar, beitraege, bvg, quellensteuer, spesen, ktg },
  };
}

/** Lohnperiode im Kalenderjahr (Feld E, AK 40): Anstellungen ∩ Jahr, sonst
 *  die Lohnperioden der Abrechnungen (Rz 8: Beginn erster, Ende letzter Einsatz). */
export function lohnperiodeImJahr(
  jahr: number,
  anstellungen: AnstellungFuerAusweis[],
  zeilen: Pick<JahreslistenZeile, "lohnperiode_von" | "lohnperiode_bis">[],
): { von: string | null; bis: string | null } {
  const jA = `${jahr}-01-01`;
  const jE = `${jahr}-12-31`;
  let von: string | null = null;
  let bis: string | null = null;
  for (const an of anstellungen) {
    const aBis = an.austritt ?? jE;
    if (an.eintritt > jE || aBis < jA) continue;
    const v = an.eintritt > jA ? an.eintritt : jA;
    const b = aBis < jE ? aBis : jE;
    if (!von || v < von) von = v;
    if (!bis || b > bis) bis = b;
  }
  if (!von) {
    for (const x of zeilen) {
      if (x.lohnperiode_von && (!von || x.lohnperiode_von < von)) von = x.lohnperiode_von;
      if (x.lohnperiode_bis && (!bis || x.lohnperiode_bis > bis)) bis = x.lohnperiode_bis;
    }
  }
  return { von, bis };
}

/** 2532 → «2'532» (wie das Formular, AFNumber_Format Stil 4). */
export function zahlCh(n: number): string {
  const s = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return n < 0 ? `-${s}` : s;
}

/** Tage mit Militär-/Zivildienst im Kalenderjahr (Abwesenheiten, Kalendertage). */
export function eoTageImJahr(abwesenheiten: { start_date: string; end_date: string }[], jahr: number): number {
  const tage = new Set<string>();
  for (const a of abwesenheiten) {
    const von = a.start_date > `${jahr}-01-01` ? a.start_date : `${jahr}-01-01`;
    const bis = a.end_date < `${jahr}-12-31` ? a.end_date : `${jahr}-12-31`;
    // Kalendertage als reine Datums-Texte (keine Zeitzone im Spiel).
    for (let d = von; d <= bis; d = plusTage(d, 1)) tage.add(d);
  }
  return tage.size;
}

// ---------------------------------------------------------------------------
// Formular 11 befüllen
// ---------------------------------------------------------------------------

const ROT = "0.8 0 0 rg";

export interface Aussteller {
  firma: CompanySettings;
  /** Für das Ausfüllen zuständige Person (Wegleitung «Unterschrift»). */
  zustaendig: string | null;
  /** Ausstellungstag (ISO, Europe/Zurich). */
  datum: string;
}

/**
 * Formular 11 für eine Person befüllen und flach machen (Werte als Text in
 * der Seite — druckfertig, nicht mehr änderbar). Fehlende Personalien als
 * rote Platzhalter. Gibt zusätzlich Hinweise zurück (gekürzte Felder, Platzhalter).
 */
export async function fuelleLohnausweis(
  vorlage: Uint8Array,
  w: LohnausweisWerte,
  p: Personalien | null,
  aussteller: Aussteller,
): Promise<{ pdf: Uint8Array; hinweise: string[] }> {
  const doc = await PDFDocument.load(vorlage.slice(0));
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const hinweise: string[] = [];

  const text = (name: string, wert: string, opts: { platzhalter?: boolean; min?: number } = {}) => {
    const f = form.getTextField(name);
    // Zeilenweise (mehrzeilige Felder: Adresse, Bestätigung).
    const t = wert.split("\n").map(druckbar).join("\n");
    passe(f, font, t, opts.min ?? 6);
    f.setText(t);
    if (opts.platzhalter) f.acroField.setDefaultAppearance(`/Helv ${groesse(f)} Tf ${ROT}`);
  };
  const betrag = (name: string, n: number, auchNull = false) => {
    if (n === 0 && !auchNull) return;
    text(name, zahlCh(n));
  };

  form.getCheckBox("OptionKreuzOhneRahmen_A").check();
  // C AHV-Nr. / Geburtsdatum
  if (p?.ahv_nr) text("AHVLinks_C", p.ahv_nr);
  else { text("AHVLinks_C", "AHV-Nr. fehlt", { platzhalter: true }); hinweise.push("AHV-Nr. fehlt"); }
  const geb = (p?.geburtsdatum ? isoAusCh(p.geburtsdatum) : null) ?? w.geburtsdatum;
  if (geb) text("TextLinks_C-GebDatum", datumCh(geb));
  else { text("TextLinks_C-GebDatum", "fehlt", { platzhalter: true }); hinweise.push("Geburtsdatum fehlt"); }
  // D Jahr, E Lohnperiode
  text("TextLinks_D", String(w.jahr));
  if (w.von) text("TextLinks_E-von", datumCh(w.von));
  if (w.bis) text("TextLinks_E-bis", datumCh(w.bis));
  // H Name und Adresse
  const name = p?.name?.trim() || w.name;
  const adresse = [p?.strasse, p?.adresszusatz, [p?.plz, p?.ort].filter(Boolean).join(" ")].map((x) => (x ?? "").trim()).filter(Boolean);
  if (adresse.length > 0 && p?.plz && p?.ort) {
    text("TextMehrzeiligLinks_Empfaenger", [name, ...adresse].join("\n"));
  } else {
    text("TextMehrzeiligLinks_Empfaenger", `${name}\nAdresse fehlt (Personalien-CSV)`, { platzhalter: true });
    hinweise.push("Adresse fehlt");
  }
  // Ziffern
  betrag("DezZahlNull_1", w.ziffer1, true);
  if (w.ziffer7 !== 0) {
    const art7 = w.ziffer7Art || "Andere Leistungen";
    if (font.widthOfTextAtSize(druckbar(art7), 6) > feldBreite(form.getTextField("TextLinks_7-Art"))) {
      text("TextLinks_7-Art", "siehe Ziffer 15");
      w = { ...w, bemerkungen: [...w.bemerkungen, `Ziff. 7: ${art7}`] };
    } else text("TextLinks_7-Art", art7);
    betrag("DezZahlNull_7", w.ziffer7);
  }
  betrag("DezZahlNull_8", w.ziffer8, true);
  betrag("DezZahlNull_9", w.ziffer9, true);
  betrag("DezZahlNull_10_1", w.ziffer10_1);
  betrag("DezZahlNull_11", w.ziffer11, true);
  betrag("DezZahlNull_12", w.ziffer12);
  if (w.ziffer13_1_2 !== 0) {
    const art13 = w.ziffer13Art || "Effektive Spesen";
    if (font.widthOfTextAtSize(druckbar(art13), 6) > feldBreite(form.getTextField("TextLinks_13_1_2-Art"))) {
      text("TextLinks_13_1_2-Art", "Effektive Spesen (siehe Ziffer 15)");
      w = { ...w, bemerkungen: [...w.bemerkungen, art13] };
    } else text("TextLinks_13_1_2-Art", art13);
    betrag("DezZahlNull_13_1_2", w.ziffer13_1_2);
  }
  // 15 Bemerkungen: zwei Zeilen, nötigenfalls kleinere Schrift, sonst gekürzt.
  const [z1, z2, gekuerzt] = zweiZeilen(w.bemerkungen.join("; "), font, feldBreite(form.getTextField("TextLinks_15_1")));
  if (z1) text("TextLinks_15_1", z1.text, { min: z1.groesse });
  if (z2) text("TextLinks_15_2", z2.text, { min: z2.groesse });
  if (gekuerzt) hinweise.push("Bemerkungen gekürzt");
  // I Ort und Datum, Bestätigung (Arbeitgeber mit Anschrift und Telefon, zuständige Person)
  const f = aussteller.firma;
  text("TextLinks_I", [f.city, datumCh(aussteller.datum)].filter(Boolean).join(", "));
  text(
    "TextMehrzeiligLinks_Bestaetigung",
    [f.name, f.street, [f.zip, f.city].filter(Boolean).join(" "), f.phone ? `Tel. ${f.phone}` : "", aussteller.zustaendig ? `Zuständig: ${aussteller.zustaendig}` : ""]
      .filter((x) => x && x.trim())
      .join("\n"),
    { min: 6 },
  );

  // «BC []» heisst laut PDF-Norm «kein Rahmen» (wie im leeren Formular); pdf-lib
  // zeichnet bei Hintergrund + Rahmenbreite sonst einen schwarzen Rahmen.
  for (const feld of form.getFields()) {
    for (const wg of feld.acroField.getWidgets()) {
      const mk = wg.getAppearanceCharacteristics();
      const bc = mk?.dict.lookup(PDFName.of("BC"));
      const bs = wg.dict.lookup(PDFName.of("BS"));
      if (bc instanceof PDFArray && bc.size() === 0 && bs instanceof PDFDict) bs.set(PDFName.of("W"), PDFNumber.of(0));
    }
  }
  doc.setTitle(`Lohnausweis ${w.jahr} – ${druckbar(name)}`);
  doc.setProducer("EVENTLINE FSM (ESTV Formular 11)");
  form.updateFieldAppearances(font);
  form.flatten();
  return { pdf: await doc.save(), hinweise };
}

function feldBreite(f: PDFTextField): number {
  const w = f.acroField.getWidgets()[0];
  return w.getRectangle().width - 4;
}
function groesse(f: PDFTextField): number {
  const da = f.acroField.getDefaultAppearance() ?? "";
  const m = /([\d.]+)\s+Tf/.exec(da);
  return m ? Number(m[1]) : 9;
}
/** Schrift verkleinern, bis der Text ins Feld passt (mehrzeilig: längste Zeile). */
function passe(f: PDFTextField, font: PDFFont, t: string, min: number) {
  const breite = feldBreite(f);
  let g = groesse(f) || 9;
  const laengste = Math.max(...t.split("\n").map((z) => font.widthOfTextAtSize(z, 1)));
  while (g > min && laengste * g > breite) g -= 0.5;
  if (g !== groesse(f)) f.setFontSize(g);
}
function zweiZeilen(t: string, font: PDFFont, breite: number): [{ text: string; groesse: number } | null, { text: string; groesse: number } | null, boolean] {
  if (!t) return [null, null, false];
  for (let g = 9; g >= 6; g -= 0.5) {
    const woerter = t.split(" ");
    const zeilen: string[] = [""];
    for (const w of woerter) {
      const k = zeilen[zeilen.length - 1] ? `${zeilen[zeilen.length - 1]} ${w}` : w;
      if (font.widthOfTextAtSize(druckbar(k), g) <= breite) zeilen[zeilen.length - 1] = k;
      else zeilen.push(w);
    }
    if (zeilen.length <= 2) return [{ text: zeilen[0], groesse: g }, zeilen[1] ? { text: zeilen[1], groesse: g } : null, false];
  }
  // Passt auch klein nicht: zweite Zeile kürzen.
  const g = 6;
  let z1 = "";
  let rest = t;
  for (const w of t.split(" ")) {
    const k = z1 ? `${z1} ${w}` : w;
    if (font.widthOfTextAtSize(druckbar(k), g) > breite) break;
    z1 = k;
  }
  rest = t.slice(z1.length).trim();
  let z2 = rest;
  while (z2 && font.widthOfTextAtSize(druckbar(`${z2} …`), g) > breite) z2 = z2.slice(0, -1);
  return [{ text: z1, groesse: g }, { text: `${z2.trim()} …`, groesse: g }, true];
}

/** Mehrere Lohnausweise zu einer PDF (Druck aller Personen). */
export async function verbindePdfs(pdfs: Uint8Array[]): Promise<Uint8Array> {
  const ziel = await PDFDocument.create();
  for (const b of pdfs) {
    const quelle = await PDFDocument.load(b);
    const seiten = await ziel.copyPages(quelle, quelle.getPageIndices());
    for (const s of seiten) ziel.addPage(s);
  }
  ziel.setTitle("Lohnausweise");
  return ziel.save();
}

// ---------------------------------------------------------------------------
// Lohnbescheinigung AK 40 (CSV)
// ---------------------------------------------------------------------------

export interface Ak40Zeile {
  profile_id: string;
  name: string;
  ahv_nr: string | null;
  geburtsdatum: string | null;
  von: string | null;
  bis: string | null;
  ahv_lohn: number;
  ahv_beitragsfrei: number;
  alv_lohn: number;
}

const chf2 = (n: number) => n.toFixed(2);

export function ak40Csv(jahr: number, zeilen: Ak40Zeile[]): string {
  return csvZeilen([
    ["AHV-Nr.", "Name", "Geburtsdatum", "Beschäftigt von", "bis", `AHV-Lohn ${jahr}`, "davon beitragsfrei (2'500-Grenze)", "AHV-pflichtig", `ALV-Lohn ${jahr}`, "profile_id"],
    ...zeilen.map((z) => [
      z.ahv_nr ?? "",
      z.name,
      z.geburtsdatum ? datumCh(z.geburtsdatum) : "",
      z.von ? datumCh(z.von) : "",
      z.bis ? datumCh(z.bis) : "",
      chf2(z.ahv_lohn),
      chf2(z.ahv_beitragsfrei),
      chf2(summeChf([z.ahv_lohn, -z.ahv_beitragsfrei])),
      chf2(z.alv_lohn),
      z.profile_id,
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Laden (Server): Jahresliste nach Auszahlungsjahr + was Feld E / Ziff. 15 brauchen
// ---------------------------------------------------------------------------

export interface AusweisDaten {
  jahr: number;
  /** Jahresliste Basis Auszahlungsjahr. */
  zeilen: JahreslistenZeile[];
  personen: { profile_id: string; name: string; geburtsdatum: string | null }[];
  anstellungen: Map<string, AnstellungFuerAusweis[]>;
  eoTage: Map<string, number>;
}

export async function ladeAusweisDaten(admin: SupabaseClient, jahr: number): Promise<AusweisDaten> {
  const { fassungen, namen, ahvVerlangt } = await ladeJahreslisteDaten(admin, jahr);
  const zeilen = jahresliste(fassungen, { jahr, basis: "auszahlung", ahvVerlangt });
  const ids = Array.from(new Set(zeilen.map((z) => z.profile_id)));
  const geb = new Map<string, string | null>();
  const anstellungen = new Map<string, AnstellungFuerAusweis[]>();
  const abw = new Map<string, { start_date: string; end_date: string }[]>();
  for (let i = 0; i < ids.length; i += 150) {
    const teil = ids.slice(i, i + 150);
    const [p, an, to] = await Promise.all([
      ladeAlleSeiten<{ id: string; birthdate: string | null }>((a, b) => admin.from("profiles").select("id, birthdate").in("id", teil).order("id").range(a, b), "Profile"),
      ladeAlleSeiten<AnstellungFuerAusweis & { id: string; profile_id: string }>(
        (a, b) => admin.from("lohn_anstellungen").select("id, profile_id, eintritt, austritt, vertragsart, pensum_pct").in("profile_id", teil).order("id").range(a, b),
        "Anstellungen",
      ),
      // Militär-/Zivildienst (Erwerbsausfall): genehmigte Abwesenheiten, die das Jahr berühren.
      ladeAlleSeiten<{ id: string; user_id: string; start_date: string; end_date: string }>(
        (a, b) => admin.from("time_off").select("id, user_id, start_date, end_date").in("user_id", teil).eq("type", "militaer").eq("status", "genehmigt")
          .lte("start_date", `${jahr}-12-31`).gte("end_date", `${jahr}-01-01`).order("id").range(a, b),
        "Abwesenheiten",
      ),
    ]);
    for (const x of p) geb.set(x.id, x.birthdate);
    for (const x of an) anstellungen.set(x.profile_id, [...(anstellungen.get(x.profile_id) ?? []), { eintritt: x.eintritt, austritt: x.austritt, vertragsart: x.vertragsart, pensum_pct: x.pensum_pct == null ? null : Number(x.pensum_pct) }]);
    for (const x of to) abw.set(x.user_id, [...(abw.get(x.user_id) ?? []), x]);
  }
  const eoTage = new Map(ids.map((id) => [id, eoTageImJahr(abw.get(id) ?? [], jahr)]));
  const personen = ids
    .map((id) => ({ profile_id: id, name: namen.get(id) ?? "?", geburtsdatum: geb.get(id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, "de-CH"));
  return { jahr, zeilen, personen, anstellungen, eoTage };
}

/** Lohnausweis-Werte je Person aus den geladenen Daten. */
export function ausweisWerteFuer(d: AusweisDaten, profileId: string): LohnausweisWerte | null {
  const p = d.personen.find((x) => x.profile_id === profileId);
  if (!p) return null;
  return lohnausweisWerte({
    profileId,
    name: p.name,
    jahr: d.jahr,
    geburtsdatum: p.geburtsdatum,
    zeilen: d.zeilen,
    anstellungen: d.anstellungen.get(profileId) ?? [],
    eoTage: d.eoTage.get(profileId) ?? 0,
  });
}

/** AK-40-Zeilen (Summen je Person im Auszahlungsjahr). */
export function ak40Zeilen(d: AusweisDaten, personalien: Map<string, Personalien> | null): Ak40Zeile[] {
  return d.personen.map((p) => {
    const z = d.zeilen.filter((x) => x.profile_id === p.profile_id);
    const s = (k: "ahv_lohn" | "ahv_beitragsfrei" | "alv_lohn") => summeChf(z.map((x) => x[k]));
    const { von, bis } = lohnperiodeImJahr(d.jahr, d.anstellungen.get(p.profile_id) ?? [], z);
    const pers = personalien?.get(p.profile_id);
    const geb = pers?.geburtsdatum ? isoAusCh(pers.geburtsdatum) : null;
    return {
      profile_id: p.profile_id,
      name: pers?.name?.trim() || p.name,
      ahv_nr: pers?.ahv_nr ?? null,
      geburtsdatum: geb ?? p.geburtsdatum,
      von,
      bis,
      ahv_lohn: s("ahv_lohn"),
      ahv_beitragsfrei: s("ahv_beitragsfrei"),
      alv_lohn: s("alv_lohn"),
    };
  });
}
