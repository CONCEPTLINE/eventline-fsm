// Getränke-Catering — Prüfung der Stammdaten (Einstellungen + Getränkekarte) vor dem Speichern.
// Reine Funktion (getestet in pruefen.test.ts); die API-Route nutzt sie, der Einstellungs-Tab zeigt dieselben Meldungen.
import { KATEGORIE_REIHENFOLGE } from "./kategorien";

export interface EinstellungenEingabe {
  lohnProStunde: number;
  gaesteProKraft: number;
  puffer: number;
  stundensatzA: number;
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
  /** Stück pro Gebinde (ganze Zahl ab 1) und Name; null = einzeln bestellbar. */
  gebindeStueck?: number | null;
  gebindeName?: string | null;
  aktiv: boolean;
}

const zahl = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Obergrenzen (Spalten sind numeric(8,2)/numeric(10,2); Werte darüber wären ein Tippfehler und würden in der DB überlaufen). */
const MAX_PREIS = 10000;
const MAX_STUNDENSATZ = 1000;
const MAX_NAME = 120;
const MAX_EINHEIT = 60;

export function pruefeStammdaten(e: EinstellungenEingabe, karte: KartenEingabe[]): string | null {
  const nichtNegativ: [string, number][] = [
    ["Personalkosten pro Stunde", e.lohnProStunde], ["Stundensatz Variante A", e.stundensatzA], ["Puffer", e.puffer],
    ["Getränke pro Person und Stunde (Vorzeit)", e.rateVor], ["Getränke pro Person und Stunde (Pause)", e.ratePause],
    ["Getränke pro Person und Stunde (Nachzeit)", e.rateNach],
  ];
  for (const [n, v] of nichtNegativ) if (!zahl(v) || v < 0) return `${n}: keine negative oder ungültige Zahl`;
  if (!zahl(e.gaesteProKraft) || !Number.isInteger(e.gaesteProKraft) || e.gaesteProKraft < 1) return "Gäste pro Servicekraft: ganze Zahl ab 1";
  for (const [n, v] of [["Vorzeit", e.anteilVor], ["Pause", e.anteilPause], ["Nachzeit", e.anteilNach]] as [string, number][]) {
    if (!zahl(v) || v < 0 || v > 1) return `Anteil der Trinkenden (${n}): zwischen 0 und 100 %`;
  }
  if (e.puffer > 1) return "Puffer: höchstens 100 %";
  if (e.lohnProStunde > MAX_STUNDENSATZ || e.stundensatzA > MAX_STUNDENSATZ) return `Stundensätze: höchstens CHF ${MAX_STUNDENSATZ}`;
  if (e.gaesteProKraft > 1000) return "Gäste pro Servicekraft: höchstens 1000";

  if (karte.length === 0) return "Die Getränkekarte darf nicht leer sein";
  for (const z of karte) {
    if (!(KATEGORIE_REIHENFOLGE as readonly string[]).includes(z.kategorie)) return `Unbekannte Kategorie: ${z.kategorie}`;
    if (typeof z.name !== "string" || typeof z.einheit !== "string") return "Name und Einheit müssen Text sein";
    if (!z.name.trim()) return "Jedes Getränk braucht einen Namen";
    if (z.name.length > MAX_NAME || z.einheit.length > MAX_EINHEIT) return `${z.name.slice(0, 30)}: Name höchstens ${MAX_NAME}, Einheit höchstens ${MAX_EINHEIT} Zeichen`;
    if (z.verkauf > MAX_PREIS || z.einkauf > MAX_PREIS) return `${z.name}: Preise höchstens CHF ${MAX_PREIS}`;
    if (!zahl(z.verkauf) || z.verkauf < 0 || !zahl(z.einkauf) || z.einkauf < 0) return `${z.name}: Preise müssen Zahlen ab 0 sein`;
    if (z.gebindeStueck != null && (!zahl(z.gebindeStueck) || !Number.isInteger(z.gebindeStueck) || z.gebindeStueck < 1 || z.gebindeStueck > 1000)) return `${z.name}: Stück pro Gebinde ist eine ganze Zahl zwischen 1 und 1000`;
    if (z.gebindeName != null && (typeof z.gebindeName !== "string" || z.gebindeName.trim().length > 20)) return `${z.name}: Gebindename höchstens 20 Zeichen`;
    if (z.mixAnteil != null && (!zahl(z.mixAnteil) || z.mixAnteil <= 0 || z.mixAnteil > 1)) return `${z.name}: Mix-Anteil zwischen 0 und 100 %`;
  }
  const imMix = karte.filter((z) => z.aktiv && z.mixAnteil != null);
  const summe = imMix.reduce((s, z) => s + (z.mixAnteil as number), 0);
  if (imMix.length === 0) return "Mindestens ein aktives Getränk muss im Mix sein";
  if (Math.abs(summe - 1) > 0.001) return `Der Mix ergibt ${Math.round(summe * 1000) / 10} %, er muss genau 100 % ergeben`;
  return null;
}
