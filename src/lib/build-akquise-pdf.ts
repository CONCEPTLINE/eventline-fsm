/**
 * PDF fuer die Location-Akquise — zwei Dokumente aus derselben Zeile:
 *
 *   teil "analyse" → INTERNE Bedarfsanalyse (bleibt im Haus, enthaelt
 *                    Risiken und die Rentabilitaetsschaetzung)
 *   teil "konzept" → Kooperationskonzept FUER DIE LOCATION (kein internes
 *                    Material, keine Schaetzzahlen)
 *
 * Die Trennung ist der Zweck dieser Datei: ein versehentlich mitgesendetes
 * Risiko-Kapitel waere im Akquisegespraech peinlich. Die interne Fassung
 * traegt deshalb sichtbar «Intern» im Kopf.
 *
 * Form folgt build-rapport-pdf.ts (jsPDF, Logo rechts, Absender darunter,
 * Trennlinie, Footer) damit Dokumente aus dem FSM gleich aussehen.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import LOGO_BASE64 from "@/lib/logo-base64";
import { loadCompanySettings, formatAddressLine, formatFullFooter } from "@/lib/company-settings";
import { KOOPERATIONS_MODELLE, chf } from "@/lib/akquise-faktoren";
import type { AkquiseLocation } from "@/types/akquise";

export type PdfTeil = "analyse" | "konzept";

/**
 * Dokumentdatum mit Jahr. `formatDate` aus @/lib/format laesst das Jahr weg
 * (fuer Listen gedacht) — auf einem Dokument, das beim Kunden liegt, ist das
 * zu wenig. timeZone explizit wie §4 verlangt.
 */
function dokumentDatum(): string {
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date());
}

const RAND = 14;

export async function buildAkquisePdf(
  location: AkquiseLocation,
  teil: PdfTeil,
  client: SupabaseClient,
): Promise<Buffer> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const breite = doc.internal.pageSize.getWidth();
  const hoehe = doc.internal.pageSize.getHeight();
  const textBreite = breite - RAND * 2;
  // Firmen-Stammdaten sind Kopf- und Fusszeile, nicht der Inhalt: faellt der
  // Zugriff aus (Cache-Kontext, DB-Fehler), kommt das PDF ohne Absender und
  // Footer heraus statt gar nicht.
  let company: Awaited<ReturnType<typeof loadCompanySettings>> | null = null;
  try {
    company = await loadCompanySettings(client);
  } catch {
    company = null;
  }

  try {
    const logoBreite = 70;
    doc.addImage(LOGO_BASE64, "PNG", breite - RAND - logoBreite, 12, logoBreite, logoBreite / 4.32);
  } catch { /* Logo fehlt — nicht fatal */ }

  const absender = company ? formatAddressLine(company) : "";
  if (absender) {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(absender, breite - RAND, 33, { align: "right" });
    doc.setTextColor(0);
  }

  let y = 20;

  /** Seitenumbruch, bevor `braucht` mm nicht mehr passen. */
  function platz(braucht: number) {
    if (y + braucht < hoehe - 20) return;
    doc.addPage();
    y = 20;
  }

  function absatz(text: string, groesse = 10, fett = false, grau = false) {
    doc.setFontSize(groesse);
    doc.setFont("helvetica", fett ? "bold" : "normal");
    if (grau) doc.setTextColor(110);
    const zeilen = doc.splitTextToSize(text, textBreite) as string[];
    platz(zeilen.length * (groesse * 0.45) + 2);
    doc.text(zeilen, RAND, y);
    y += zeilen.length * (groesse * 0.45) + 2;
    if (grau) doc.setTextColor(0);
  }

  function ueberschrift(text: string) {
    platz(12);
    y += 4;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(text, RAND, y);
    y += 5;
  }

  function punkte(eintraege: string[]) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    for (const e of eintraege) {
      const zeilen = doc.splitTextToSize(e, textBreite - 5) as string[];
      platz(zeilen.length * 4.5 + 1);
      doc.text("•", RAND, y);
      doc.text(zeilen, RAND + 5, y);
      y += zeilen.length * 4.5 + 1;
    }
    y += 1;
  }

  // ── Titelblock ──────────────────────────────────────────────────────
  const konzept = location.kooperationskonzept;
  const titel = teil === "analyse"
    ? "Bedarfsanalyse"
    : konzept?.titel ?? "Kooperationskonzept";

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  const titelZeilen = doc.splitTextToSize(titel, textBreite - 75) as string[];
  doc.text(titelZeilen, RAND, y);
  y += titelZeilen.length * 7;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(150);
  const kopfZeile = teil === "analyse"
    ? `NR-${location.nr} · ${location.name} · Intern`
    : `NR-${location.nr} · ${location.name}`;
  doc.text(kopfZeile, RAND, y);
  doc.setTextColor(0);
  y += 6;

  if (absender) y = Math.max(y, 39);
  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(RAND, y, breite - RAND, y);
  y += 8;

  // ── Stammdaten ──────────────────────────────────────────────────────
  const adresse = [location.strasse, [location.plz, location.ort].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  const modellLabel = KOOPERATIONS_MODELLE.find((m) => m.key === location.empfohlenes_modell)?.label;
  const stammdaten = [
    adresse && `Adresse: ${adresse}`,
    location.typ && `Art: ${location.typ}`,
    location.kapazitaet !== null && `Kapazität: ca. ${location.kapazitaet} Personen`,
    location.website && `Website: ${location.website}`,
    modellLabel && `Modell: ${modellLabel}`,
  ].filter(Boolean) as string[];
  if (stammdaten.length > 0) {
    absatz(stammdaten.join("   ·   "), 9, false, true);
    y += 2;
  }

  // ── Inhalt ──────────────────────────────────────────────────────────
  if (teil === "analyse") {
    const a = location.bedarfsanalyse;
    if (!a) throw new Error("Keine Bedarfsanalyse vorhanden");

    absatz(a.ausgangslage);
    if (a.luecken.length) { ueberschrift("Lücken"); punkte(a.luecken); }
    if (a.unser_beitrag.length) { ueberschrift("Unser Beitrag"); punkte(a.unser_beitrag); }
    if (a.risiken.length) { ueberschrift("Risiken"); punkte(a.risiken); }
    if (a.offene_fragen.length) { ueberschrift("Fragen fürs Erstgespräch"); punkte(a.offene_fragen); }

    // Nur in der internen Fassung: Schaetzrechnung samt ihren Annahmen.
    if (location.rentabilitaet_chf !== null || location.bewertung) {
      ueberschrift("Einschätzung (intern)");
      const zeilen: string[] = [];
      if (location.score !== null) zeilen.push(`Score ${location.score} von 100`);
      if (location.rentabilitaet_chf !== null) {
        zeilen.push(`Geschätzter Jahresbeitrag ${chf(location.rentabilitaet_chf)} CHF`);
      }
      if (zeilen.length) absatz(zeilen.join("   ·   "), 10, true);
      if (location.bewertung?.begruendung) absatz(location.bewertung.begruendung);
      if (location.bewertung?.annahmen?.length) {
        absatz("Die Zahlen sind Schätzungen. Sie beruhen auf:", 9, false, true);
        punkte(location.bewertung.annahmen);
      }
    }
  } else {
    if (!konzept) throw new Error("Kein Kooperationskonzept vorhanden");
    for (const a of konzept.abschnitte) {
      ueberschrift(a.titel);
      absatz(a.text);
    }
    if (konzept.naechste_schritte.length) {
      ueberschrift("Nächste Schritte");
      punkte(konzept.naechste_schritte);
    }
  }

  // ── Footer auf jeder Seite ──────────────────────────────────────────
  const footer = company ? formatFullFooter(company) : "";
  const seiten = doc.getNumberOfPages();
  const datum = dokumentDatum();
  for (let s = 1; s <= seiten; s++) {
    doc.setPage(s);
    doc.setFontSize(7.5);
    doc.setTextColor(150);
    if (footer) doc.text(footer, breite / 2, hoehe - 12, { align: "center" });
    doc.text(
      `${teil === "analyse" ? "Intern · " : ""}${datum}${seiten > 1 ? `   ·   Seite ${s} von ${seiten}` : ""}`,
      breite / 2, hoehe - 8, { align: "center" },
    );
    doc.setTextColor(0);
  }

  return Buffer.from(doc.output("arraybuffer"));
}

/** Dateiname — Ortsangabe mit, damit Downloads unterscheidbar bleiben. */
export function akquisePdfName(location: AkquiseLocation, teil: PdfTeil): string {
  const sauber = `${location.name}_${location.ort}`
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return `${teil === "analyse" ? "Bedarfsanalyse" : "Kooperationskonzept"}_${sauber}.pdf`;
}
