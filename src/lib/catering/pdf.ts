// Getränke-Catering — PDF-Erzeugung (Vertrag A «Bestellung», Vertrag B «Mindestumsatz», Getränkekarte).
// Layout der Verträge nach Mischas Vorlage (EVENTLINE_Vertragsvorlage_v02): Logo oben links, fett-kursive
// Überschriften, aufrechter Fliesstext, Fusszeile mit Adresse und «Seite x | y».
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import LOGO_BASE64 from "@/lib/logo-base64";
import { KATEGORIE_REIHENFOLGE, KATEGORIE_TITEL, type JobKontext, type KartenZeile } from "./daten";
import type { CateringEingabe, CateringErgebnis } from "./rechnen";
import { formatStunden } from "./stunden";

const A4: [number, number] = [595.28, 841.89];
const MM = 72 / 25.4;
// Masse 1:1 aus Mischas Vorlage (EVENTLINE_Vertragsvorlage_v02.docx): Ränder oben 27.6 / sonst 25.4 mm,
// Kopf- und Fussabstand 12.5 mm, Logo 44.6 mm breit links im Kopf, Schrift 10 pt (Titel 14 fett, Fusszeile 9),
// Blocksatz, je 5 pt Abstand davor und danach. Kursiv ist in der Vorlage nur der Platzhalter → im Vertrag nirgends kursiv.
// Schrift: Helvetica (Tahoma lässt sich in pdf-lib ohne Schriftdatei nicht einbetten), Grössen wie in der Vorlage.
const RAND_X = 25.4 * MM;
const OBEN = 27.6 * MM;
const UNTEN = 25.4 * MM;
const KOPF_ABSTAND = 12.5 * MM;
const INK = rgb(0, 0, 0);
const GRAU = rgb(0.45, 0.44, 0.42);

/** Text für eine Standard-Schrift (WinAnsi) bereinigen: nicht darstellbare Zeichen (z. B. «ř» in «Dvořák») würden pdf-lib
 *  zum Abbruch bringen. Erst ohne Akzent versuchen (ř → r), sonst «?». */
function sicher(font: PDFFont, text: string): string {
  const erlaubt = new Set(font.getCharacterSet());
  let aus = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    const cp = ch.codePointAt(0) as number;
    if (erlaubt.has(cp)) { aus += ch; continue; }
    const basis = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    aus += [...basis].every((c) => erlaubt.has(c.codePointAt(0) as number)) && basis ? basis : "?";
  }
  return aus;
}

const chf = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
const preis = (n: number) => n.toFixed(2);

async function logo(doc: PDFDocument): Promise<PDFImage> {
  const b64 = LOGO_BASE64.replace(/^data:image\/\w+;base64,/, "");
  return doc.embedJpg(Buffer.from(b64, "base64"));
}

function umbrechen(text: string, font: PDFFont, size: number, breite: number): string[] {
  const zeilen: string[] = [];
  for (const absatz of text.split("\n")) {
    let aktuell = "";
    for (const wort of absatz.split(/\s+/).filter(Boolean)) {
      const probe = aktuell ? `${aktuell} ${wort}` : wort;
      if (font.widthOfTextAtSize(probe, size) <= breite) aktuell = probe;
      else {
        if (aktuell) zeilen.push(aktuell);
        aktuell = wort;
      }
    }
    zeilen.push(aktuell);
  }
  return zeilen;
}

export interface VertragDaten {
  art: "A" | "B";
  job: JobKontext;
  eingabe: CateringEingabe;
  ergebnis: Pick<CateringErgebnis, "kraefte" | "stundenProKraft" | "stundensatzA" | "getraenkeA" | "serviceA" | "richtpreisA" | "bestellmengeA" | "mindestumsatz">;
  ausschankBeginn: string;
  auftraggeber: string;
  auftraggeberAdresse: string;
  anlass: string;
}

export async function vertragPdf(d: VertragDaten): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await logo(doc);
  const breite = A4[0] - 2 * RAND_X;
  const GROESSE = 10;
  const ZEILE = 12.2; // einfacher Zeilenabstand wie in der Vorlage
  const ABSTAND = 5; // 5 pt davor und danach

  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - OBEN;
  const neueSeite = () => {
    page = doc.addPage(A4);
    y = A4[1] - OBEN;
  };
  const platz = (h: number) => {
    if (y - h < UNTEN) neueSeite();
  };

  // Titel: 14 pt fett, zentriert, darunter eine Linie (wie die Unterstrich-Zeile der Vorlage)
  const titel = `Vereinbarung Getränke-Catering · Variante ${d.art} (${d.art === "A" ? "Bestellung" : "Mindestumsatz"})`;
  for (const z of umbrechen(titel, fett, 14, breite)) {
    y -= 14;
    page.drawText(z, { x: RAND_X + (breite - fett.widthOfTextAtSize(z, 14)) / 2, y, size: 14, font: fett, color: INK });
    y -= 3;
  }
  y -= 2;
  page.drawLine({ start: { x: RAND_X, y }, end: { x: RAND_X + breite, y }, thickness: 0.7, color: INK });
  y -= 10;

  /** Eine Zeile im Blocksatz zeichnen (letzte Zeile eines Absatzes linksbündig). */
  const zeile = (text: string, x: number, w: number, font: PDFFont, blocksatz: boolean) => {
    const woerter = text.split(" ").filter(Boolean);
    if (!blocksatz || woerter.length < 2) {
      page.drawText(text, { x, y, size: GROESSE, font, color: INK });
      return;
    }
    const belegt = woerter.reduce((s, wort) => s + font.widthOfTextAtSize(wort, GROESSE), 0);
    const luecke = (w - belegt) / (woerter.length - 1);
    let cx = x;
    for (const wort of woerter) {
      page.drawText(wort, { x: cx, y, size: GROESSE, font, color: INK });
      cx += font.widthOfTextAtSize(wort, GROESSE) + luecke;
    }
  };

  const ueberschrift = (text: string) => {
    platz(ABSTAND * 2 + ZEILE * 2);
    y -= ABSTAND + ZEILE;
    page.drawText(text, { x: RAND_X, y, size: GROESSE, font: fett, color: INK });
    y -= ABSTAND;
  };
  const absatz = (text: string) => {
    const zeilen = umbrechen(text, normal, GROESSE, breite);
    y -= ABSTAND;
    zeilen.forEach((z, i) => {
      platz(ZEILE);
      y -= ZEILE;
      zeile(z, RAND_X, breite, normal, i < zeilen.length - 1);
    });
    y -= ABSTAND;
  };
  const punkt = (label: string, text: string) => {
    const einzug = 18; // Aufzählungseinzug
    const lab = `${label}: `;
    const labBreite = fett.widthOfTextAtSize(lab, GROESSE);
    // Erste Zeile neben dem Label (schmaler), Folgezeilen ab Einzug in voller Breite; alles im Blocksatz.
    const erste = umbrechen(text, normal, GROESSE, breite - einzug - labBreite)[0] ?? "";
    const rest = text.slice(erste.length).trim();
    const folge = rest ? umbrechen(rest, normal, GROESSE, breite - einzug) : [];
    platz(ABSTAND + ZEILE * Math.min(2, 1 + folge.length));
    y -= ABSTAND + ZEILE;
    page.drawCircle({ x: RAND_X + 6, y: y + 3.4, size: 1.4, color: INK });
    page.drawText(lab, { x: RAND_X + einzug, y, size: GROESSE, font: fett, color: INK });
    zeile(erste, RAND_X + einzug + labBreite, breite - einzug - labBreite, normal, folge.length > 0);
    folge.forEach((z, i) => {
      platz(ZEILE);
      y -= ZEILE;
      zeile(z, RAND_X + einzug, breite - einzug, normal, i < folge.length - 1);
    });
    y -= ABSTAND;
  };

  const kunde = sicher(normal, d.auftraggeber.trim()) || "—";
  const adresse = sicher(normal, d.auftraggeberAdresse.trim()) || "nicht angegeben";
  const e = d.eingabe;
  const r = d.ergebnis;
  const linie = "______________________";
  const nr = d.job.jobNumber != null ? `INT-${d.job.jobNumber}` : "";
  const anlass = sicher(normal, d.anlass.trim() || d.job.titel);
  const ort = sicher(normal, d.job.ort);
  const beginn = sicher(normal, d.ausschankBeginn);

  // Einfache, direkte Sprache («wir» = EVENTLINE GmbH, «Sie» = Auftraggeber/in), damit die Kundschaft den Vertrag auf einen Blick versteht.
  ueberschrift("1. Wer macht mit?");
  punkt("Auftragnehmerin", "EVENTLINE GmbH, St. Jakobs-Strasse 200, 4052 Basel (im Vertrag «wir»)");
  punkt("Auftraggeber/in", `${kunde} (im Vertrag «Sie»)`);
  punkt("Adresse", adresse);

  ueberschrift("2. Ihr Anlass");
  punkt("Anlass", `${anlass}${d.job.datumText ? `, ${d.job.datumText}` : ""}`);
  if (nr) punkt("Auftrag", nr);
  punkt("Ort", ort || linie);
  punkt("Gäste", `${e.gaeste} Gäste erwartet`);
  punkt("Ausschank", `vor dem Programm ca. ${formatStunden(e.vorzeitMin)}, in der Pause ca. ${formatStunden(e.pauseMin)}, danach ca. ${formatStunden(e.nachzeitMin)}. Beginn: ${beginn ? `${beginn} Uhr` : "________ Uhr"}`);
  punkt("Auf- und Abbau", `Wir bauen ca. ${formatStunden(e.aufbauMin)} vor Beginn auf und ca. ${formatStunden(e.abbauMin)} nach Ende ab. Der Anlass dauert ca. ${formatStunden(e.gesamtMin)}.`);
  punkt("Personal", `${r.kraefte} Servicekräfte`);

  ueberschrift("3. Das machen wir für Sie");
  absatz("Wir kaufen die Getränke ein, liefern und kühlen sie, schenken sie aus und bauen die Bar wieder ab. Es gilt die beiliegende Getränkekarte der EVENTLINE GmbH mit ihren Preisen.");

  if (d.art === "A") {
    ueberschrift("4. So funktioniert Variante A (Bestellung)");
    punkt("Bestellung", "Sie sagen uns, welche Getränke wir bestellen sollen. Wir bringen sie mit. Die Getränke gehören Ihnen, nicht getrunkene Getränke bleiben bei Ihnen.");
    punkt("Das bezahlen Sie", `Die bestellten Getränke zu den Preisen der Getränkekarte, dazu unsere Servicekräfte zu CHF ${r.stundensatzA} pro Kraft und Stunde, von Aufbau bis Abbau.`);
    punkt("Richtwert", `${r.bestellmengeA} Getränke: CHF ${chf(r.getraenkeA)}. Service (${r.kraefte} Kräfte, ca. ${r.stundenProKraft.toFixed(1)} Stunden): CHF ${chf(r.serviceA)}. Zusammen: CHF ${chf(r.richtpreisA)}.`);
    punkt("Abrechnung", "Abgerechnet wird, was wirklich bestellt wurde und wie viele Stunden wirklich gearbeitet wurden.");
    punkt("Ihre Gäste", "Ihre Gäste bezahlen nichts.");
    punkt("Anpassung", "Ändern sich Gästezahl oder Dauer deutlich, passen wir Bestellung und Personal an und bestätigen Ihnen das schriftlich.");
  } else {
    const x = chf(r.mindestumsatz);
    ueberschrift("4. So funktioniert Variante B (Mindestumsatz)");
    punkt("Ihre Gäste zahlen", "Ihre Gäste bezahlen ihre Getränke selbst, zu den Preisen der Getränkekarte. Der Umsatz geht an uns.");
    punkt("Mindestumsatz", `Wir brauchen einen Umsatz von mindestens CHF ${x}.`);
    punkt("Wenn es reicht", `Erreichen die Gäste zusammen CHF ${x} oder mehr, zahlen Sie nichts.`);
    punkt("Wenn es nicht reicht", `Bleibt der Umsatz darunter, zahlen Sie die Differenz bis CHF ${x}. Kauft kein Gast etwas, zahlen Sie die ganzen CHF ${x}. Mehr als CHF ${x} zahlen Sie nie.`);
    punkt("Nachweis", "Wir legen der Abrechnung den Kassenabschluss bei.");
    punkt("Anpassung", "Der Mindestumsatz gilt für die oben genannte Dauer und Gästezahl. Ändert sich eines davon deutlich, vereinbaren wir mit Ihnen schriftlich einen neuen Betrag.");
  }

  ueberschrift("5. Das ist wichtig");
  punkt("Absage", "Bei einer Absage gelten die Allgemeinen Geschäftsbedingungen (AGB) der EVENTLINE GmbH.");
  // Variante A (Bestellung): ohne Alkohol-/Bewilligungs- und Schadenszeile (Leo 02.11.2026); nur Variante B enthält sie.
  if (d.art === "B") {
    punkt("Alkohol und Bewilligung", "Sie klären mit dem Veranstaltungsort, ob Alkohol ausgeschenkt werden darf und ob eine Bewilligung nötig ist. Wir halten den Jugendschutz ein und dürfen Alkohol verweigern, wenn Jugendschutz oder Sicherheit es verlangen.");
    punkt("Schäden", "Schäden, die Gäste an Einrichtung und Material verursachen, gehen zu Ihren Lasten.");
  }
  punkt("Bezahlung", "Alle Preise sind in Schweizer Franken. Es wird keine Mehrwertsteuer berechnet, die Preise sind Endpreise (die EVENTLINE GmbH ist nicht mehrwertsteuerpflichtig). Die Rechnung ist innert 30 Tagen ab Rechnungsdatum zahlbar.");
  punkt("Gültigkeit", "Änderungen nur schriftlich. Es gilt Schweizer Recht. Gerichtsstand ist Basel, soweit das Gesetz nichts anderes vorschreibt. Der Vertrag gilt mit der Unterschrift beider Seiten, jede Seite erhält ein Exemplar.");

  // Unterschriften (zusammenhängend auf einer Seite)
  platz(200);
  ueberschrift("6. Unterschriften");
  y -= ZEILE;
  page.drawText("Basel, den ______________", { x: RAND_X, y, size: GROESSE, font: normal, color: INK });
  page.drawText("Ort, Datum: ______________", { x: RAND_X + breite / 2 + 6, y, size: GROESSE, font: normal, color: INK });
  y -= 46;
  const spalte = breite / 2 - 14;
  const sig = (x: number, yy: number, z1: string, z2?: string, z1fett = false) => {
    page.drawLine({ start: { x, y: yy }, end: { x: x + spalte, y: yy }, thickness: 0.7, color: INK });
    page.drawText(z1, { x, y: yy - 12, size: GROESSE, font: z1fett ? fett : normal, color: INK });
    if (z2) page.drawText(z2, { x, y: yy - 24, size: GROESSE, font: z1fett ? normal : fett, color: INK });
  };
  sig(RAND_X, y, "Auftragnehmerin", "EVENTLINE GmbH");
  sig(RAND_X + breite / 2 + 6, y, "Auftraggeber/in", kunde);
  y -= 60;
  page.drawLine({ start: { x: RAND_X, y }, end: { x: RAND_X + spalte, y }, thickness: 0.7, color: INK });
  page.drawText("Leo Balaszeskul", { x: RAND_X, y: y - 12, size: GROESSE, font: normal, color: INK });
  y -= 52;
  page.drawLine({ start: { x: RAND_X, y }, end: { x: RAND_X + spalte, y }, thickness: 0.7, color: INK });
  page.drawText("Mischa Dittus", { x: RAND_X, y: y - 12, size: GROESSE, font: normal, color: INK });

  // Kopf (Logo, 44.6 mm breit, links bündig mit dem Text) und Fusszeile (9 pt) auf jeder Seite; Seitenzahl «x | y»
  const seiten = doc.getPages();
  const lw = 44.6 * MM;
  const lh = (img.height / img.width) * lw;
  seiten.forEach((p, i) => {
    p.drawImage(img, { x: RAND_X, y: A4[1] - KOPF_ABSTAND - lh, width: lw, height: lh });
    p.drawText("EVENTLINE GmbH", { x: RAND_X, y: KOPF_ABSTAND + 11, size: 9, font: normal, color: INK });
    p.drawText("St. Jakobs-Strasse 200, 4052 Basel", { x: RAND_X, y: KOPF_ABSTAND, size: 9, font: normal, color: INK });
    const t = `Seite ${i + 1} | ${seiten.length}`;
    p.drawText(t, { x: RAND_X + breite - normal.widthOfTextAtSize(t, 9), y: KOPF_ABSTAND, size: 9, font: normal, color: INK });
  });
  return doc.save();
}

export function karteTitel(job: JobKontext | null, anlass?: string): string {
  const name = anlass?.trim() || job?.titel || "";
  return job?.datumText ? `${name} · ${job.datumText}` : name;
}

export async function kartePdf(karte: KartenZeile[], untertitel: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifKursiv = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const img = await logo(doc);
  let page = doc.addPage(A4);
  const mitte = A4[0] / 2;
  const links = 80;
  const rechts = A4[0] - 80;
  page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: rgb(0.98, 0.98, 0.965) });

  const lw = 150;
  const lh = (img.height / img.width) * lw;
  let y = A4[1] - 60;
  page.drawImage(img, { x: mitte - lw / 2, y: y - lh, width: lw, height: lh });
  y -= lh + 20;
  const mittig = (t: string, size: number, font: PDFFont, farbe = INK) =>
    page.drawText(t, { x: mitte - font.widthOfTextAtSize(t, size) / 2, y, size, font, color: farbe });
  mittig("GETRÄNKE-CATERING", 8, serif, GRAU);
  y -= 46;
  mittig("Getränkekarte", 38, serifKursiv);
  y -= 22;
  if (untertitel) {
    mittig(sicher(serif, untertitel), 9.6, serif, GRAU);
    y -= 12;
  }
  mittig("Alle Preise in CHF pro Getränk, keine Mehrwertsteuer", 9.6, serif, GRAU);
  y -= 12;
  mittig("Der Service ist im Vertrag geregelt", 9.6, serif, GRAU);
  y -= 22;

  for (const kat of KATEGORIE_REIHENFOLGE) {
    const zeilen = karte.filter((z) => z.kategorie === kat);
    if (zeilen.length === 0) continue;
    y -= 22;
    const titel = KATEGORIE_TITEL[kat].toUpperCase().split("").join(" ");
    mittig(titel, 8, serif, rgb(0.88, 0.19, 0.18));
    y -= 8;
    for (const z of zeilen) {
      // Reicht der Platz nicht mehr (Fusszeile bei y ≈ 100), geht die Karte auf einer zweiten Seite weiter.
      if (y < 130) {
        page = doc.addPage(A4);
        page.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: rgb(0.98, 0.98, 0.965) });
        y = A4[1] - 70;
      }
      y -= 19;
      const name = sicher(serif, z.name);
      const einheit = sicher(serifKursiv, z.einheit);
      const p = preis(z.verkauf);
      // Lange Namen verkleinern (bis 8 pt) und notfalls kürzen, damit sie nie in den Preis laufen.
      const platz = rechts - links - serif.widthOfTextAtSize(p, 12) - 14 - (einheit ? serifKursiv.widthOfTextAtSize(einheit, 7.6) + 6 : 0);
      let groesse = 12;
      while (groesse > 8 && serif.widthOfTextAtSize(name, groesse) > platz) groesse -= 0.5;
      let angezeigt = name;
      while (angezeigt.length > 4 && serif.widthOfTextAtSize(angezeigt, groesse) > platz) angezeigt = angezeigt.slice(0, -2).trimEnd() + "…";
      page.drawText(angezeigt, { x: links, y, size: groesse, font: serif, color: INK });
      let ende = links + serif.widthOfTextAtSize(angezeigt, groesse) + 6;
      if (einheit) {
        page.drawText(einheit, { x: ende, y, size: 7.6, font: serifKursiv, color: GRAU });
        ende += serifKursiv.widthOfTextAtSize(einheit, 7.6) + 6;
      }
      const pb = serif.widthOfTextAtSize(p, 12);
      page.drawText(p, { x: rechts - pb, y, size: 12, font: serif, color: INK });
      page.drawLine({ start: { x: ende, y: y + 3 }, end: { x: rechts - pb - 6, y: y + 3 }, thickness: 0.4, color: rgb(0.8, 0.78, 0.74), dashArray: [1, 2] });
    }
  }
  y = 70;
  page.drawLine({ start: { x: links, y: y + 30 }, end: { x: rechts, y: y + 30 }, thickness: 0.5, color: rgb(0.89, 0.87, 0.84) });
  const hinweis = "Alkohol wird nur an Personen ab dem gesetzlichen Mindestalter abgegeben.";
  page.drawText(hinweis, { x: mitte - serif.widthOfTextAtSize(hinweis, 8) / 2, y: y + 14, size: 8, font: serif, color: GRAU });
  const f1 = "EVENTLINE GMBH";
  page.drawText(f1, { x: mitte - serif.widthOfTextAtSize(f1, 8) / 2, y: y, size: 8, font: serif, color: INK });
  const f2 = "St. Jakobs-Strasse 200 · CH-4052 Basel · leo@eventline-basel.com";
  page.drawText(f2, { x: mitte - serif.widthOfTextAtSize(f2, 7.4) / 2, y: y - 11, size: 7.4, font: serif, color: GRAU });
  return doc.save();
}
