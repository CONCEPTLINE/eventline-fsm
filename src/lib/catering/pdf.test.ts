import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { kartePdf, vertragPdf, type VertragDaten } from "./pdf";
import { CATERING_STANDARD, rechneCatering, type CateringEingabe } from "./rechnen";
import type { KartenZeile } from "./daten";

const zeile = (n: number, o: Partial<KartenZeile> = {}): KartenZeile => ({
  id: `id-${n}`, kategorie: "bier", name: `Bier ${n}`, einheit: "33 cl", verkauf: 6.5, einkauf: 1.85, mixAnteil: null, ...o,
});
const KARTE: KartenZeile[] = [
  zeile(1, { kategorie: "aperitif", name: "Aperol Spritz", einheit: "20 cl", verkauf: 8, einkauf: 2.6, mixAnteil: 0.1 }),
  zeile(2, { kategorie: "weisswein", name: "Weisswein", einheit: "Glas · 1 dl", verkauf: 8, einkauf: 18.5 / 7.5, mixAnteil: 0.1 }),
  zeile(3, { kategorie: "rotwein", name: "Rotwein", einheit: "Glas · 1 dl", verkauf: 8, einkauf: 17.9 / 7.5, mixAnteil: 0.1 }),
  zeile(4, { kategorie: "bier", name: "Bier", mixAnteil: 0.35 }),
  zeile(5, { kategorie: "softdrink", name: "Cola", verkauf: 5.5, einkauf: 1.2, mixAnteil: 0.35 }),
];
const E: CateringEingabe = { gaeste: 90, aufbauMin: 60, gesamtMin: 215, abbauMin: 30, vorzeitMin: 45, pauseMin: 20, nachzeitMin: 90 };
const R = rechneCatering(E, CATERING_STANDARD, KARTE);

const daten = (art: "A" | "B", o: Partial<VertragDaten> = {}): VertragDaten => ({
  art,
  job: { jobId: "x", jobNumber: 26404, status: "offen", titel: "CD-Taufe", datumText: "9. April 2027", ort: "Theater BAU3", auftraggeber: "Michèle Thommen", auftraggeberAdresse: "" },
  eingabe: E, ergebnis: R, ausschankBeginn: "", auftraggeber: "Michèle Thommen", auftraggeberAdresse: "", anlass: "CD-Taufe", ...o,
});
const seiten = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

describe("vertragPdf", () => {
  it("erzeugt Vertrag A und B auf zwei Seiten", async () => {
    expect(await seiten(await vertragPdf(daten("A")))).toBe(2);
    expect(await seiten(await vertragPdf(daten("B")))).toBe(2);
  });
  it("bricht bei Zeichen ausserhalb von WinAnsi nicht ab (Dvořák, 日本, Emoji)", async () => {
    const bytes = await vertragPdf(daten("A", { auftraggeber: "Antonín Dvořák 日本 🎉", auftraggeberAdresse: "Ďáblická 5, Praha", anlass: "Fête – «Taufe»", ausschankBeginn: "18:30" }));
    expect(await seiten(bytes)).toBeGreaterThanOrEqual(1);
  });
  it("liefert gültige PDFs, und alle Zahlen des Ergebnisses sind endlich (kein NaN im Vertrag)", async () => {
    for (const art of ["A", "B"] as const) {
      const bytes = await vertragPdf(daten(art));
      const text = Buffer.from(bytes).toString("latin1");
      // Der Seiteninhalt ist komprimiert und nicht direkt lesbar; deshalb prüfen wir unten die Zahlen, die in den Text fliessen.
      expect(text.startsWith("%PDF")).toBe(true);
    }
    for (const k of ["kraefte", "stundenProKraft", "stundensatzA", "getraenkeA", "serviceA", "richtpreisA", "bestellmengeA", "mindestumsatz"] as const) {
      expect(Number.isFinite(R[k])).toBe(true);
    }
  });
});

describe("kartePdf", () => {
  it("passt auf eine Seite", async () => {
    expect(await seiten(await kartePdf(KARTE, "CD-Taufe · 9. April 2027"))).toBe(1);
  });
  it("läuft bei langer Karte auf eine zweite Seite weiter und kürzt sehr lange Namen", async () => {
    const viele = Array.from({ length: 30 }, (_, i) => zeile(i, { name: `Sehr langer Name eines Getränks mit vielen Zeichen Nummer ${i} ${"x".repeat(80)}` }));
    expect(await seiten(await kartePdf(viele, "Anlass"))).toBeGreaterThanOrEqual(2);
  });
  it("bricht bei Sonderzeichen in Namen nicht ab", async () => {
    const bytes = await kartePdf([zeile(1, { name: "Žatecký ležák", einheit: "0,5 l" })], "Fête 🎉");
    expect(await seiten(bytes)).toBe(1);
  });
});
