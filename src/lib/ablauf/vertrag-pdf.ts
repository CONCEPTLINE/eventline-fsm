// Privatvermietung barakuba — Vertrag als PDF, im Namen von Basil Erny (Ich-Form, Du-Form an die Mieter:in).
//
// Text und Aufbau 1:1 nach Basils Vorlage «Du Vorlage Vertrag Freitag.doc» (Kopf mit barakuba-Logo, blaue
// Abschnittsbänder, zweispaltige Tabelle mit Trennlinien). Bewusst KEIN EVENTLINE-Branding: Vertragspartner
// ist Basil. Variabel sind nur die Kundendaten aus dem Ablauf (Felder der Vorbesprechung) und die gewählten
// Zusatzleistungen; Preise und Klauseln sind fix (Abweichungen zur Vorlage, mit Basil abgesprochen:
// Übergabe «ca. 1 Stunde» statt 40 Minuten, Poller-Person + Merkblatt, Bühne/Komplettservice als Kosten-Zeile).
// Komplettservice erscheint nur mit gesetztem Preis. Nichts kursiv. Zeilen werden nie über ein Seitenende
// gerissen; Abschnitts-Titel bleiben mit ihrer ersten Zeile zusammen, der Schluss (Unterschriften) als Block.
// Nur serverseitig (liest den Kopf aus src/lib/ablauf/unterlagen).
import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage, type PDFFont, type PDFPage } from "pdf-lib";
import { plusTage } from "@/lib/swiss-time";
import { UEBERGABE_STANDARD, type AblaufFelder } from "./typen";
import { KONDITIONEN } from "./eml";
import { ladeBarakubaKopf } from "./unterlagen";

const A4: [number, number] = [595.28, 841.89];
// Masse aus Basils Vorlage (Word → PDF ausgemessen): Tabelle 65.5–524.6 pt, Wertspalte ab 205.6 pt.
const LINKS = 65.5;
const RECHTS = 524.6;
const SPALTE = 205.6;
const PAD = 5.4; // Innenabstand der Zellen
const OBEN = 28;
const UNTEN = 54;
const GROESSE = 9.5;
const ZEILE = 12;
const INK = rgb(0, 0, 0);
const BAND = rgb(0.859, 0.898, 0.945); // Abschnittsband wie in der Vorlage
const KOPF_BREITE = 255.8; // Logo + Adresse (Vektor aus der Vorlage)

const TZ = "Europe/Zurich";

// ─── Format ────────────────────────────────────────────────────────────

/** «Freitag, 27. November 2026» — Tag ohne Uhrzeit, Mittag gegen Zeitzonen-Sprünge. */
export function datumVertrag(isoTag: string): string {
  const d = new Date(`${isoTag}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("de-CH", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
}

function folgetag(isoTag: string): string {
  return plusTage(isoTag, 1);
}

/** Heutiges Datum in Zürich als «6. November 2026». */
function heuteLang(jetzt: Date): string {
  return new Intl.DateTimeFormat("de-CH", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" }).format(jetzt);
}

/** «18:00» → «18h», «18:30» → «18.30h» (Schreibweise der Vorlage). */
function uhrzeit(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm.trim() || "—";
  return m[2] === "00" ? `${Number(m[1])}h` : `${Number(m[1])}.${m[2]}h`;
}

/** «CHF 1'200.00» wie in der Vorlage. */
export function chfVertrag(n: number): string {
  const [ganz, rappen] = n.toFixed(2).split(".");
  return `CHF ${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${rappen}`;
}

/** Freier Preis (Komplettservice) → Zahl; «1'200», «1’200.50», «450.-» werden verstanden. */
export function preisZahl(roh: string): number | null {
  const s = roh.trim().replace(/^chf\s*/i, "").replace(/['’\s]/g, "").replace(/\.-+$/, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/** Dateiname: «Vertrag_barakuba_2026-11-27_Muster.pdf» (nur ASCII, für Storage-Pfad und Anhang). */
export function vertragDateiname(f: Pick<AblaufFelder, "datum" | "mieter">): string {
  const name = (f.mieter.trim().split(/\s+/).pop() ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9-]+/g, "");
  const tag = /^\d{4}-\d{2}-\d{2}$/.test(f.datum) ? f.datum : "ohne-Datum";
  return `Vertrag_barakuba_${tag}${name ? `_${name}` : ""}.pdf`;
}

/** Pflichtfelder für einen sinnvollen Vertrag — die Route meldet fehlende (409), statt Striche zu drucken. */
export function fehlendeVertragsfelder(f: AblaufFelder): string[] {
  const fehlt: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.datum)) fehlt.push("Datum");
  if (!f.mieter.trim()) fehlt.push("Mieter:in");
  if (!f.adresse.trim()) fehlt.push("Adresse");
  if (!f.anlass.trim()) fehlt.push("Anlass");
  if (!f.beginn.trim()) fehlt.push("Beginn");
  if (!f.gaeste.trim()) fehlt.push("max. Gäste");
  return fehlt;
}

// ─── Text-Bausteine ────────────────────────────────────────────────────

/** Ein Absatz in einer Zelle. «barakuba» wird wie in der Vorlage fett gesetzt. */
type Absatz = { text: string; punkt?: boolean; fett?: boolean; abstand?: boolean };

type Zeile =
  | { art: "zwei"; label: string; inhalt: Absatz[] }
  | { art: "kosten"; label: string; inhalt: Absatz[]; rechts: string }
  | { art: "voll"; inhalt: Absatz[] }
  | { art: "leer" };

type Abschnitt = { titel: string; zeilen: Zeile[] };

export type VertragOptionen = {
  /** Tag des Vertrags (Schlusszeile «Basel, …»). Standard: jetzt. */
  jetzt?: Date;
  /** auftrag_ablauf.uebergabe_start (ISO); leer = 14:00 (UEBERGABE_STANDARD). */
  uebergabeStart?: string | null;
};

/** Übergabe-Uhrzeit in Zürich als «14h» / «14.30h». */
function uebergabeZeit(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {
    const { stunde, minute } = UEBERGABE_STANDARD;
    return uhrzeit(`${stunde}:${String(minute).padStart(2, "0")}`);
  }
  const hhmm = new Intl.DateTimeFormat("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return uhrzeit(hhmm);
}

/** Telefonnummern zusammenhalten (geschützte Leerzeichen). */
const nummer = (s: string) => s.trim().replace(/ /g, " ");

function abschnitte(f: AblaufFelder, opt: VertragOptionen): Abschnitt[] {
  const k = KONDITIONEN;
  const tag = /^\d{4}-\d{2}-\d{2}$/.test(f.datum) ? f.datum : "";
  const strich = (s: string) => s.trim() || "—";

  const allgemein: Zeile[] = [
    {
      art: "zwei",
      label: "Datum",
      inhalt: [
        { text: tag ? datumVertrag(tag) : "—" },
        { text: `Raumübergabe: ${uebergabeZeit(opt.uebergabeStart)}, Dauer ca. ${UEBERGABE_STANDARD.dauerMin === 60 ? "1 Stunde" : `${UEBERGABE_STANDARD.dauerMin} Minuten`}`, punkt: true },
        { text: `Raumrückgabe: Folgetag (${tag ? datumVertrag(folgetag(tag)) : "—"}) / 12h`, punkt: true },
      ],
    },
    {
      art: "zwei",
      label: "Zweck",
      inhalt: [{ text: `${strich(f.anlass)} im privaten Rahmen / Beginn ${uhrzeit(f.beginn)} / mit maximal ${strich(f.gaeste)} Gästen` }],
    },
    {
      art: "zwei",
      label: "Inbegriffen",
      inhalt: [
        { text: "Bar (Ausstattung siehe Infoblatt)", punkt: true },
        { text: "Mobiliar (siehe Infoblatt)", punkt: true },
        { text: "Stereoanlage (mit Minijack-Stecker für MP3-Player, Laptop, ...)", punkt: true },
        { text: "2 Toiletten (zur Mitbenutzung mit den Nachbarn)", punkt: true },
      ],
    },
    {
      art: "zwei",
      label: "Vorplatz",
      inhalt: [{ text: "Der Vorplatz kann mit Rücksicht auf die Nachbarn vom Gelände (insbesondere Kletterhalle) genutzt werden." }],
    },
    {
      art: "zwei",
      label: "Aufräumen / Reinigung",
      inhalt: [
        { text: "Grundsätzlich gilt: Du gibst mir das barakuba so zurück, wie Du es übernommen hast." },
        {
          text: "Die beiliegende Checkliste ist Bestandteil vom Vertrag und muss vor dem Verlassen vom barakuba unbedingt durchgegangen werden. Das Wichtigste in Kürze:",
          abstand: true,
        },
        { text: "Direkt im Anschluss ans Fest:", abstand: true },
        { text: "Vorplatz geräumt und sauber", punkt: true },
        { text: "Gang geräumt und sauber", punkt: true },
        { text: "Toiletten sauber", punkt: true },
        { text: "Vor der Rückgabe:", abstand: true },
        { text: "Bar (Gläser, Theke, Spültrog, Kühlschrank, ...) sauber", punkt: true },
        { text: "Mobiliar gemäss Abmachung zusammengestellt / verräumt", punkt: true },
        { text: "Raum besenrein", punkt: true },
      ],
    },
    {
      art: "zwei",
      label: "Zusatzaufwand",
      inhalt: [
        {
          text: `Wird das barakuba nicht wie vereinbart hinterlassen, verrechne ich meinen damit verbundenen zusätzlichen Aufwand mit ${chfVertrag(k.zusatzaufwandProStunde)}/Stunde.`,
        },
      ],
    },
    {
      art: "zwei",
      label: "Schäden",
      inhalt: [{ text: "Schäden an Mobiliar/Raum/Ausstattung und mein damit verbundener Aufwand zu Deinen Lasten" }],
    },
  ];

  const kosten: Zeile[] = [{ art: "kosten", label: "Raummiete", inhalt: [{ text: "pauschal" }], rechts: chfVertrag(k.raummiete) }];
  if (f.disco) {
    kosten.push({
      art: "kosten",
      label: "Disco-Equipment",
      inhalt: [{ text: "Tisch, PA, Mixer > alles verkabelt (2 x Minijack für DJ)" }, { text: "inkl. Auf- und Abbau" }],
      rechts: chfVertrag(k.disco),
    });
  }
  if (f.buehneLicht) {
    kosten.push({
      art: "kosten",
      label: "Bühne und Licht",
      inhalt: [{ text: "Konzertbühne mit Bühnenbeleuchtung" }, { text: "inkl. Auf- und Abbau" }],
      rechts: chfVertrag(k.buehneLicht),
    });
  }
  const preisKs = f.preisKomplettservice.trim();
  if (f.komplettservice && preisKs) {
    const zahl = preisZahl(preisKs);
    kosten.push({
      art: "kosten",
      label: "Komplettservice",
      inhalt: [{ text: "Einrichten, Barbetrieb und Begleitung Fest, Aufräumen" }],
      rechts: zahl != null ? chfVertrag(zahl) : `CHF ${preisKs.replace(/^chf\s*/i, "")}`,
    });
  }
  kosten.push(
    { art: "leer" },
    {
      art: "kosten",
      label: "Unser Bier, blond & Amber",
      inhalt: [{ text: `Flaschen 33cl, pro Flasche ${chfVertrag(k.bierProFlasche)}` }],
      rechts: "gemäss Konsumation",
    },
    {
      art: "kosten",
      label: "Kaffee La Semeuse",
      inhalt: [{ text: `Papiertabs, pro Tab (inkl. Zucker) ${chfVertrag(k.kaffeeProTab)}` }],
      rechts: "gemäss Konsumation",
    },
    { art: "kosten", label: "Gläser", inhalt: [{ text: chfVertrag(k.glas) }], rechts: "pro zerschlagenes Glas" },
    {
      art: "zwei",
      label: "Bezahlung",
      inhalt: [{ text: "Ich schicke Dir nach dem Anlass eine Rechnung, die Du bitte innerhalb von 10 Tagen begleichst." }],
    },
  );

  const poller = f.pollerName.trim()
    ? `Poller bei der Einfahrt! Zugangsbewilligung gemäss Vorbesprechung für ${f.pollerName.trim()}${f.pollerMobil.trim() ? ` (Mobil ${nummer(f.pollerMobil)})` : ""}, alle Infos im beiliegenden Poller-Merkblatt.`
    : "Poller bei der Einfahrt! Zugangsbewilligung gemäss Vorbesprechung, alle Infos im beiliegenden Poller-Merkblatt.";

  const einrichtung: string[] = [];
  if (f.buffettisch) einrichtung.push("Buffettisch neben Eingang");
  if (f.vorhang) einrichtung.push("Vorhang offen");
  if (f.tonanlage) einrichtung.push("Tonanlage");
  if (f.djMischpult) einrichtung.push("DJ-Mischpult");
  if (f.stellwand.trim()) einrichtung.push(`Stellwand mit «${f.stellwand.trim()}»`);

  const diverses: Zeile[] = [
    {
      art: "voll",
      inhalt: [{ text: "Bei Musik in Disco-Lautstärke muss die Tür zum Hof ab 23h geschlossen sein. Draussen ist direkte Musikbeschallung nicht erlaubt." }],
    },
    {
      art: "voll",
      inhalt: [
        { text: "Anlieferung:" },
        { text: "Vorfahren vors barakuba zum Ein- und Ausladen ist durch die Einfahrt Bruderholzstrasse möglich (Höhe max. 2.30m)", punkt: true },
        { text: poller, punkt: true },
        { text: "Autos dürfen nicht auf dem Areal parkiert werden!", punkt: true, fett: true },
      ],
    },
  ];
  if (einrichtung.length > 0) {
    diverses.push({ art: "voll", inhalt: [{ text: `Zusätzliche Einrichtung gemäss Vorbesprechung: ${einrichtung.join(", ")}` }] });
  }
  diverses.push(
    { art: "voll", inhalt: [{ text: "Im barakuba bitte nicht rauchen." }] },
    {
      art: "voll",
      inhalt: [
        {
          text: "Im Gundeldinger Feld sind Foodtrucks nicht erlaubt. Kleinere Verpflegungsmobile werden allenfalls von der Verwaltung erlaubt. Bitte unbedingt rechtzeitig mit mir absprechen und erst nach der Zusage der Verwaltung definitiv buchen! Bitte beachte: maximale Fahrzeughöhe 2.30m",
        },
      ],
    },
    { art: "voll", inhalt: [{ text: "Dekoration im Raum bitte nur nach Absprache mit mir." }] },
    { art: "voll", inhalt: [{ text: "Aufbau Partyzelte bitte nur nach Absprache mit mir und der Kletterhalle." }] },
    { art: "leer" },
    { art: "voll", inhalt: [{ text: "Gerichtsstand ist Basel." }] },
  );

  return [
    { titel: "1. Allgemein", zeilen: allgemein },
    { titel: "2. Kosten", zeilen: kosten },
    { titel: "3. Diverses", zeilen: diverses },
  ];
}

// ─── Satz ──────────────────────────────────────────────────────────────

/** Text für eine Standard-Schrift (WinAnsi) bereinigen — wie src/lib/catering/pdf.ts. */
function sicher(font: PDFFont, text: string): string {
  const erlaubt = new Set(font.getCharacterSet());
  let aus = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    const cp = ch.codePointAt(0) as number;
    if (erlaubt.has(cp)) {
      aus += ch;
      continue;
    }
    const basis = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    aus += [...basis].every((c) => erlaubt.has(c.codePointAt(0) as number)) && basis ? basis : "?";
  }
  return aus;
}

type Wort = { text: string; font: PDFFont; breite: number };
type Satzzeile = { woerter: Wort[]; x: number };

export async function vertragPdf(f: AblaufFelder, opt: VertragOptionen = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Vertrag für Dein Fest im barakuba – ${f.mieter.trim() || "Mieter:in"}`);
  doc.setAuthor("Basil Erny, barakuba");
  doc.setSubject("Vertrag Privatvermietung barakuba");
  doc.setCreator("barakuba");
  doc.setProducer("barakuba");

  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);
  const [kopf] = await doc.embedPdf(await ladeBarakubaKopf(), [0]);

  const leer = normal.widthOfTextAtSize(" ", GROESSE);
  const punktEinzug = 9;

  /** Absatz in Wörter (mit Schrift) zerlegen und auf `breite` umbrechen. */
  const setze = (a: Absatz, breite: number): Satzzeile[] => {
    const woerter: Wort[] = sicher(normal, a.text)
      .split(" ")
      .filter(Boolean)
      .map((w) => {
        const font = a.fett || /^barakuba\b/.test(w) ? fett : normal;
        return { text: w, font, breite: font.widthOfTextAtSize(w, GROESSE) };
      });
    const einzug = a.punkt ? punktEinzug : 0;
    const zeilen: Satzzeile[] = [];
    let aktuell: Wort[] = [];
    let belegt = 0;
    for (const w of woerter) {
      const neu = aktuell.length === 0 ? w.breite : belegt + leer + w.breite;
      if (neu > breite - einzug && aktuell.length > 0) {
        zeilen.push({ woerter: aktuell, x: einzug });
        aktuell = [w];
        belegt = w.breite;
      } else {
        aktuell.push(w);
        belegt = neu;
      }
    }
    zeilen.push({ woerter: aktuell, x: einzug });
    return zeilen;
  };

  const hoeheAbsaetze = (inhalt: Absatz[], breite: number) =>
    inhalt.reduce((h, a) => h + (a.abstand ? ZEILE * 0.6 : 0) + setze(a, breite).length * ZEILE, 0);

  const wertBreite = RECHTS - SPALTE - 2 * PAD;
  /** Beschreibung neben dem Betrag: Wertspalte minus Betrag minus 14 pt Luft. */
  const kostenBreite = (rechts: string) => wertBreite - normal.widthOfTextAtSize(sicher(normal, rechts), GROESSE) - 14;
  const vollBreite = RECHTS - LINKS - 2 * PAD;
  const labelBreite = SPALTE - LINKS - 2 * PAD;

  const zeilenHoehe = (z: Zeile): number => {
    if (z.art === "leer") return 8;
    if (z.art === "voll") return hoeheAbsaetze(z.inhalt, vollBreite) + 2 * PAD;
    const inhalt = hoeheAbsaetze(z.inhalt, z.art === "kosten" ? kostenBreite(z.rechts) : wertBreite);
    const label = setze({ text: z.label }, labelBreite).length * ZEILE;
    return Math.max(inhalt, label) + 2 * PAD;
  };

  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - OBEN;
  const neueSeite = () => {
    page = doc.addPage(A4);
    y = A4[1] - OBEN - 12;
  };
  const platz = (h: number) => {
    if (y - h < UNTEN) neueSeite();
  };

  const text = (t: string, x: number, yy: number, font: PDFFont = normal, size = GROESSE) =>
    page.drawText(sicher(font, t), { x, y: yy, size, font, color: INK });
  const linie = (yy: number, von = LINKS, bis = RECHTS, dicke = 0.48) =>
    page.drawLine({ start: { x: von, y: yy }, end: { x: bis, y: yy }, thickness: dicke, color: INK });

  const zeichneAbsaetze = (inhalt: Absatz[], x0: number, breite: number) => {
    for (const a of inhalt) {
      if (a.abstand) y -= ZEILE * 0.6;
      setze(a, breite).forEach((sz, i) => {
        y -= ZEILE;
        if (a.punkt && i === 0) text("•", x0 + 1, y + 2.5);
        let x = x0 + sz.x;
        for (const w of sz.woerter) {
          page.drawText(w.text, { x, y: y + 2.5, size: GROESSE, font: w.font, color: INK });
          x += w.breite + leer;
        }
      });
    }
  };

  // Kopf: Logo + Adresse (aus der Vorlage), bündig links wie im Original
  const kopfMass = (kopf as PDFEmbeddedPage).scale(KOPF_BREITE / kopf.width);
  page.drawPage(kopf, { x: 49.4, y: y - kopfMass.height, width: kopfMass.width, height: kopfMass.height });
  y -= kopfMass.height + 18;

  // Mieter:in
  const anschrift = [f.mieter.trim(), f.adresse.trim(), f.telefon.trim() ? `Mobil ${nummer(f.telefon)}` : "", f.email.trim()].filter(Boolean);
  anschrift.forEach((z, i) => {
    y -= ZEILE;
    text(z, LINKS + PAD, y, i === 0 ? fett : normal);
  });
  y -= 20;

  // Titel
  y -= 14;
  text("Vertrag für Dein Fest im ", LINKS + PAD, y, normal, 14);
  text("barakuba", LINKS + PAD + normal.widthOfTextAtSize("Vertrag für Dein Fest im ", 14), y, fett, 14);
  y -= ZEILE + 1;
  text("im Gundeldinger Feld in Basel", LINKS + PAD, y);
  y -= 18;
  text("Schön, dass Du bei mir feiern wirst! Hier die wichtigsten Informationen und Abmachungen:", LINKS + PAD, y);
  y -= 6;

  const BAND_H = 21;
  for (const ab of abschnitte(f, opt)) {
    // Band + erste Zeile bleiben zusammen
    platz(BAND_H + 14 + 6 + zeilenHoehe(ab.zeilen[0]));
    y -= 14;
    page.drawRectangle({ x: LINKS, y: y - BAND_H, width: RECHTS - LINKS, height: BAND_H, color: BAND });
    linie(y);
    linie(y - BAND_H);
    text(ab.titel, LINKS + PAD, y - BAND_H / 2 - 3.2);
    y -= BAND_H + 6;
    linie(y);

    for (const z of ab.zeilen) {
      const h = zeilenHoehe(z);
      platz(h);
      const oben = y;
      if (z.art === "leer") {
        y -= h;
      } else if (z.art === "voll") {
        y -= PAD;
        zeichneAbsaetze(z.inhalt, LINKS + PAD, vollBreite);
        y = oben - h;
      } else {
        // Label links, Inhalt in der Wertspalte (Label darf selbst umbrechen)
        let yl = oben - PAD;
        for (const sz of setze({ text: z.label }, labelBreite)) {
          yl -= ZEILE;
          text(sz.woerter.map((w) => w.text).join(" "), LINKS + PAD, yl + 2.5);
        }
        y -= PAD;
        zeichneAbsaetze(z.inhalt, SPALTE + PAD, z.art === "kosten" ? kostenBreite(z.rechts) : wertBreite);
        if (z.art === "kosten") {
          const r = sicher(normal, z.rechts);
          text(r, RECHTS - PAD - normal.widthOfTextAtSize(r, GROESSE), oben - PAD - ZEILE + 2.5);
        }
        y = Math.min(y, yl) - PAD;
        y = Math.min(y, oben - h);
      }
      linie(y);
    }
  }

  // Schluss: Gruss, Ort/Datum und Unterschriften als ein Block
  const SCHLUSS_H = 128;
  platz(SCHLUSS_H);
  y -= 28;
  text("Ich wünsche Dir gute Festvorbereitungen!", LINKS + PAD, y);
  y -= 26;
  const rechtsX = 310;
  const strichBreite = RECHTS - PAD - rechtsX;
  text(`Basel, ${heuteLang(opt.jetzt ?? new Date())}`, LINKS + PAD, y);
  linie(y - 2, rechtsX, rechtsX + strichBreite, 0.5);
  text("Ort, Datum", rechtsX, y - 13);
  y -= 50;
  linie(y - 2, LINKS + PAD, LINKS + PAD + strichBreite, 0.5);
  linie(y - 2, rechtsX, rechtsX + strichBreite, 0.5);
  text("Basil Erny, barakuba", LINKS + PAD, y - 13);
  text(f.mieter.trim() || "Mieter:in", rechtsX, y - 13);

  // Seitenzahl unten rechts wie in der Vorlage
  const seiten = doc.getPages();
  seiten.forEach((p, i) => {
    const nr = String(i + 1);
    p.drawText(nr, { x: RECHTS - normal.widthOfTextAtSize(nr, 10), y: 34, size: 10, font: normal, color: INK });
  });

  return doc.save();
}

// ─── Ablage im Auftrag ─────────────────────────────────────────────────

export const VERTRAG_ORDNER = "Vertrag";
export const vertragPfad = (jobId: string, dateiname: string) => `jobs/${jobId}/vertrag/${dateiname}`;

/**
 * Vertrags-PDF als Dokument im Auftrag ablegen (bucket documents, jobs/{id}/vertrag/…, Ordner «Vertrag»).
 * Reihenfolge wie beim Catering: Datei hochladen (upsert) → neue documents-Zeile → `setzeVerweis` (setzt
 * auftrag_ablauf.vertrag_dokument_id) → ERST DANN frühere erzeugte Verträge (Zeile + Datei) entfernen.
 * So geht bei einem Fehler nie der bestehende Vertrag verloren. Andere Dokumente im Ordner «Vertrag»
 * (z. B. der unterschriebene Vertrag aus der Mail) liegen nicht unter jobs/{id}/vertrag/ und bleiben unberührt.
 */
export async function legeVertragAb(
  admin: SupabaseClient,
  p: {
    jobId: string;
    userId: string;
    dateiname: string;
    bytes: Uint8Array;
    setzeVerweis: (dokumentId: string) => Promise<void>;
  },
): Promise<{ dokumentId: string; pfad: string }> {
  const prefix = `jobs/${p.jobId}/vertrag/`;
  const { data: alt, error: aErr } = await admin
    .from("documents")
    .select("id, storage_path")
    .eq("job_id", p.jobId)
    .like("storage_path", `${prefix}%`);
  if (aErr) throw aErr;

  const pfad = vertragPfad(p.jobId, p.dateiname);
  const { error: upErr } = await admin.storage
    .from("documents")
    .upload(pfad, p.bytes, { contentType: "application/pdf", upsert: true });
  if (upErr) throw upErr;

  const { data: neu, error: iErr } = await admin
    .from("documents")
    .insert({
      name: p.dateiname,
      storage_path: pfad,
      file_size: p.bytes.length,
      mime_type: "application/pdf",
      job_id: p.jobId,
      uploaded_by: p.userId,
      folder: VERTRAG_ORDNER,
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  const dokumentId = neu.id as string;

  await p.setzeVerweis(dokumentId);

  const altZeilen = (alt ?? []) as { id: string; storage_path: string }[];
  if (altZeilen.length > 0) {
    const { error: dErr } = await admin.from("documents").delete().in("id", altZeilen.map((z) => z.id));
    if (dErr) throw dErr;
    const altePfade = altZeilen.map((z) => z.storage_path).filter((s) => s !== pfad);
    if (altePfade.length > 0) {
      const { error: rErr } = await admin.storage.from("documents").remove(altePfade);
      if (rErr) throw rErr;
    }
  }
  return { dokumentId, pfad };
}
