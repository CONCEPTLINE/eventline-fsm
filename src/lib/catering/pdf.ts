// Getränke-Catering — PDF-Erzeugung (Vertrag A «Fixpreis», Vertrag B «Mindestumsatz», Getränkekarte).
// Layout der Verträge nach Mischas Vorlage (EVENTLINE_Vertragsvorlage_v02): Logo oben links, fett-kursive
// Überschriften, aufrechter Fliesstext, Fusszeile mit Adresse und «Seite x | y».
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import LOGO_BASE64 from "@/lib/logo-base64";
import { KATEGORIE_REIHENFOLGE, KATEGORIE_TITEL, type JobKontext, type KartenZeile } from "./daten";
import { STUNDENSATZ_LAENGER_A, type CateringEingabe, type CateringErgebnis } from "./rechnen";

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
  ergebnis: Pick<CateringErgebnis, "kraefte" | "fixpreis" | "mindestumsatz" | "inbegriffen">;
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
  const titel = `Vereinbarung Getränke-Catering · Variante ${d.art} (${d.art === "A" ? "Fixpreis" : "Mindestumsatz"})`;
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

  const kunde = d.auftraggeber.trim() || "—";
  const kundeAdr = d.auftraggeberAdresse.trim() ? `${kunde}, ${d.auftraggeberAdresse.trim()}` : kunde;
  const e = d.eingabe;
  const linie = "______________________";
  const nr = d.job.jobNumber != null ? `INT-${d.job.jobNumber}` : "";

  ueberschrift("1. Vertragsparteien");
  punkt("Auftragnehmerin", "EVENTLINE GmbH, St. Jakobs-Strasse 200, 4052 Basel, UID CHE-251.311.931");
  punkt("Auftraggeber/in", kundeAdr);

  ueberschrift("2. Veranstaltung");
  if (nr) punkt("Auftrag", `${nr} (Beilage: Getränkekarte der EVENTLINE GmbH)`);
  punkt("Anlass", d.anlass.trim() || d.job.titel);
  punkt("Datum", d.job.datumText ?? linie);
  punkt("Ort", d.job.ort || linie);
  punkt("Ausschank", `Vorzeit ca. ${e.vorzeitMin} Minuten, Pause ca. ${e.pauseMin} Minuten, Nachzeit ca. ${e.nachzeitMin} Minuten. Beginn: ${d.ausschankBeginn ? `${d.ausschankBeginn} Uhr` : "________ Uhr"}`);
  punkt("Dauer", `ca. ${e.gesamtMin} Minuten. Aufbau ca. ${e.aufbauMin} Minuten vor Beginn, Abbau ca. ${e.abbauMin} Minuten nach Ende.`);
  punkt("Erwartete Gästezahl", `${e.gaeste} Gäste`);
  punkt("Servicekräfte", String(d.ergebnis.kraefte));

  ueberschrift("3. Leistung");
  absatz("Die EVENTLINE GmbH übernimmt den Einkauf der Getränke, die Anlieferung und Kühlung, den Ausschank durch Servicekräfte sowie den Abbau der Bar. Das Angebot richtet sich nach der beiliegenden Getränkekarte der EVENTLINE GmbH. Die Preise der Karte gelten für diese Veranstaltung unverändert.");
  // Variante A: längerer Ausschank kostet CHF 45 pro Servicekraft und Stunde plus alle bestellten Getränke.
  // Variante B kennt keinen Stundensatz (der Mindestumsatz ist der einzige Preis).
  absatz(
    d.art === "A"
      ? `Die Kalkulation geht vom oben genannten Ablauf aus. Längere Ausschankzeiten werden mit CHF ${STUNDENSATZ_LAENGER_A} pro Servicekraft und Stunde verrechnet, zuzüglich aller bestellten Getränke zu den Preisen der Getränkekarte.`
      : "Die Kalkulation geht vom oben genannten Ablauf aus.",
  );

  if (d.art === "A") {
    ueberschrift("4. Fixpreis");
    punkt("Fixpreis", `CHF ${chf(d.ergebnis.fixpreis)} für Getränke, Service und Ausschank von bis zu ${d.ergebnis.inbegriffen} Getränken, das heisst rund drei Getränke pro Gast bei ${e.gaeste} Gästen.`);
    punkt("Kostentragung", "Die Gäste bezahlen nichts. Der/die Auftraggeber/in übernimmt den Fixpreis allein.");
    punkt("Zählweise", "Als ein Getränk zählt ein Glas, eine Flasche Bier, Mineral oder Softdrink sowie ein Aperol Spritz. Eine Flasche Wein zählt als sieben Getränke.");
    punkt("Mehrverbrauch", `Wird die Menge von ${d.ergebnis.inbegriffen} Getränken überschritten, rechnet die EVENTLINE GmbH jedes weitere Getränk zu den Preisen der Getränkekarte ab.`);
    punkt("Gästezahl", "Wesentliche Abweichungen von der genannten Gästezahl berechtigen zur Anpassung des Fixpreises.");
  } else {
    ueberschrift("4. Mindestumsatz");
    punkt("Betrieb", "Die EVENTLINE GmbH betreibt das Getränke-Catering auf eigene Rechnung. Die Gäste bezahlen ihre Getränke vor Ort zu den Preisen der Getränkekarte. Der Umsatz wird der EVENTLINE GmbH gutgeschrieben.");
    punkt("Mindestumsatz", `Die EVENTLINE GmbH garantiert sich einen Mindestumsatz von CHF ${chf(d.ergebnis.mindestumsatz)} (Betrag X).`);
    punkt("Betrag X erreicht", "Erreicht der Getränkeumsatz Betrag X oder mehr, zahlt der/die Auftraggeber/in CHF 0.");
    punkt("Betrag X nicht erreicht", "Bleibt der Umsatz unter Betrag X, vergütet der/die Auftraggeber/in die Differenz zwischen dem tatsächlichen Umsatz und Betrag X.");
    punkt("Höchstbetrag", `Kauft kein Gast ein Getränk, beträgt die Differenz den ganzen Mindestumsatz: Der/die Auftraggeber/in zahlt dann CHF ${chf(d.ergebnis.mindestumsatz)}. Mehr als Betrag X ist nie zu zahlen.`);
    punkt("Nachweis", "Der Abrechnung liegt der Kassenabschluss der Veranstaltung bei.");
    punkt("Gästezahl", "Wesentliche Abweichungen von der genannten Gästezahl berechtigen zur Anpassung von Betrag X.");
  }

  ueberschrift("5. Absage");
  absatz("Bei einer Absage gelten die Allgemeinen Geschäftsbedingungen (AGB) der EVENTLINE GmbH.");
  ueberschrift("6. Bewilligungen und Haftung");
  absatz(`Der/die Auftraggeber/in klärt mit dem Veranstaltungsort, ob der Ausschank von Alkohol erlaubt ist und ob eine Bewilligung nötig ist. Die EVENTLINE GmbH hält den Jugendschutz ein und darf die Abgabe von Alkohol verweigern, wenn Jugendschutz oder Sicherheit es verlangen. Beschädigungen an Einrichtung und Material, die Gäste verursachen, gehen zulasten von ${kunde}.`);
  ueberschrift("7. Preise und Zahlung");
  absatz("Alle Preise verstehen sich in Schweizer Franken. Die EVENTLINE GmbH ist nicht mehrwertsteuerpflichtig, deshalb wird keine Mehrwertsteuer verrechnet. Rechnungen sind innert 30 Tagen zahlbar.");
  ueberschrift("8. Schlussbestimmungen");
  absatz("Änderungen und Ergänzungen bedürfen der Schriftform. Es gilt schweizerisches Recht, Gerichtsstand ist Basel. Die Vereinbarung wird mit der Unterschrift beider Parteien gültig, jede Partei erhält ein unterzeichnetes Exemplar.");

  // Unterschriften (zusammenhängend auf einer Seite)
  platz(200);
  ueberschrift("9. Unterschriften");
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
  sig(RAND_X, y, "Die Auftragnehmerin", "EVENTLINE GmbH");
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
  const page = doc.addPage(A4);
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
    mittig(untertitel, 9.6, serif, GRAU);
    y -= 12;
  }
  mittig("Alle Preise in CHF, Service inbegriffen", 9.6, serif, GRAU);
  y -= 22;

  for (const kat of KATEGORIE_REIHENFOLGE) {
    const zeilen = karte.filter((z) => z.kategorie === kat);
    if (zeilen.length === 0) continue;
    y -= 22;
    const titel = KATEGORIE_TITEL[kat].toUpperCase().split("").join(" ");
    mittig(titel, 8, serif, rgb(0.88, 0.19, 0.18));
    y -= 8;
    for (const z of zeilen) {
      y -= 19;
      page.drawText(z.name, { x: links, y, size: 12, font: serif, color: INK });
      const nameBreite = serif.widthOfTextAtSize(z.name, 12);
      let ende = links + nameBreite + 6;
      if (z.einheit) {
        page.drawText(z.einheit, { x: ende, y, size: 7.6, font: serifKursiv, color: GRAU });
        ende += serifKursiv.widthOfTextAtSize(z.einheit, 7.6) + 6;
      }
      const p = preis(z.verkauf);
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
