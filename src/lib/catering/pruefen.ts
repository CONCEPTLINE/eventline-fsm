// Getränke-Catering — Prüfung der Stammdaten (Einstellungen + Getränkekarte) vor dem Speichern.
// Reine Funktion (getestet in pruefen.test.ts); die API-Route nutzt sie, der Einstellungs-Tab zeigt dieselben Meldungen.
import { KATEGORIE_REIHENFOLGE } from "./kategorien";

export interface EinstellungenEingabe {
  lohnProStunde: number;
  gaesteProKraft: number;
  puffer: number;
  aufschlagA: number;
  anteilVor: number;
  rateVor: number;
  anteilPause: number;
  ratePause: number;
  anteilNach: number;
  rateNach: number;
}

export interface KartenEingabe {
  id?: string;
  kategorie: string;
  name: string;
  einheit: string;
  verkauf: number;
  einkauf: number;
  /** 0.35 = 35 %; null = Zeile zählt nicht im Mix. */
  mixAnteil: number | null;
  aktiv: boolean;
}

const zahl = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function pruefeStammdaten(e: EinstellungenEingabe, karte: KartenEingabe[]): string | null {
  const nichtNegativ: [string, number][] = [
    ["Personalkosten pro Stunde", e.lohnProStunde], ["Puffer", e.puffer], ["Aufschlag Variante A", e.aufschlagA],
    ["Getränke pro Person und Stunde (Vorzeit)", e.rateVor], ["Getränke pro Person und Stunde (Pause)", e.ratePause],
    ["Getränke pro Person und Stunde (Nachzeit)", e.rateNach],
  ];
  for (const [n, v] of nichtNegativ) if (!zahl(v) || v < 0) return `${n}: keine negative oder ungültige Zahl`;
  if (!zahl(e.gaesteProKraft) || !Number.isInteger(e.gaesteProKraft) || e.gaesteProKraft < 1) return "Gäste pro Servicekraft: ganze Zahl ab 1";
  for (const [n, v] of [["Vorzeit", e.anteilVor], ["Pause", e.anteilPause], ["Nachzeit", e.anteilNach]] as [string, number][]) {
    if (!zahl(v) || v < 0 || v > 1) return `Anteil der Trinkenden (${n}): zwischen 0 und 100 %`;
  }
  if (e.puffer > 1 || e.aufschlagA > 1) return "Puffer und Aufschlag: höchstens 100 %";

  if (karte.length === 0) return "Die Getränkekarte darf nicht leer sein";
  for (const z of karte) {
    if (!(KATEGORIE_REIHENFOLGE as readonly string[]).includes(z.kategorie)) return `Unbekannte Kategorie: ${z.kategorie}`;
    if (!z.name.trim()) return "Jedes Getränk braucht einen Namen";
    if (!zahl(z.verkauf) || z.verkauf < 0 || !zahl(z.einkauf) || z.einkauf < 0) return `${z.name}: Preise müssen Zahlen ab 0 sein`;
    if (z.mixAnteil != null && (!zahl(z.mixAnteil) || z.mixAnteil <= 0 || z.mixAnteil > 1)) return `${z.name}: Mix-Anteil zwischen 0 und 100 %`;
  }
  const imMix = karte.filter((z) => z.aktiv && z.mixAnteil != null);
  const summe = imMix.reduce((s, z) => s + (z.mixAnteil as number), 0);
  if (imMix.length === 0) return "Mindestens ein aktives Getränk muss im Mix sein";
  if (Math.abs(summe - 1) > 0.001) return `Der Mix ergibt ${Math.round(summe * 1000) / 10} %, er muss genau 100 % ergeben`;
  return null;
}
