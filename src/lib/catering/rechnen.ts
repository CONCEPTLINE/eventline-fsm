// Getränke-Catering — Kalkulation (reiner Rechenkern, kein DB-/UI-Bezug).
//
// Dieselbe Logik wie der Excel-Rechner (Stand 2026-11-02, INT-26404), damit
// Zahlen im Auftrag, im Vertrag und im Mail nie auseinanderlaufen:
//   1. Getränke je Phase = Gäste × Anteil der Trinkenden × Stunden × Getränke/Person/Std
//   2. Einkauf = Getränke × Ø Einkauf (gewichteter Mix der Karte)
//   3. Servicekräfte = 1 + ⌊Gäste ÷ Gäste-pro-Kraft⌋ (bis 49 Gäste 1, ab 50 zwei, ab 100 drei …)
//   4. Personal = Kräfte × (Aufbau + Veranstaltung + Abbau in Std) × Stundensatz
//   5. Kosten = Einkauf + Personal; Betrag X (Mindestumsatz) = Kosten + Puffer, auf CHF 10 aufgerundet
//   6. Variante A (Bestellung): die Kundschaft nennt, was bestellt wird; die Getränke gehören ihr und werden zu
//      Kartenpreisen verrechnet (Richtwert = erwartete Menge, auf 10 aufgerundet), dazu die Servicekräfte zu
//      dem Stundensatz A (Einstellung, Standard CHF 45) pro Kraft und Stunde für die ganze Einsatzzeit von Aufbau bis Abbau. Abgerechnet wird nach Bestellung und Stunden.

export interface CateringEingabe {
  gaeste: number;
  aufbauMin: number;
  /** Dauer der ganzen Veranstaltung (ohne Aufbau/Abbau). */
  gesamtMin: number;
  abbauMin: number;
  vorzeitMin: number;
  pauseMin: number;
  nachzeitMin: number;
}

export interface CateringParameter {
  lohnProStunde: number;
  gaesteProKraft: number;
  /** 0.10 = 10 %. */
  puffer: number;
  /** Variante A: Verkaufspreis je Servicekraft und Stunde in CHF (Einstellung, Standard 45). */
  stundensatzA: number;
  vor: { anteil: number; rate: number };
  pause: { anteil: number; rate: number };
  nach: { anteil: number; rate: number };
}

/** Eine Karten-Zeile, die im Mix gewichtet wird (mixAnteil != null). */
export interface MixZeile {
  einkauf: number;
  verkauf: number;
  mixAnteil: number | null;
}

export interface CateringErgebnis {
  getraenkeVor: number;
  getraenkePause: number;
  getraenkeNach: number;
  getraenke: number;
  getraenkeProGast: number;
  einkaufProGetraenk: number;
  verkaufProGetraenk: number;
  einkauf: number;
  kraefte: number;
  stundenProKraft: number;
  personal: number;
  kosten: number;
  puffer: number;
  /** Variante B: garantierter Mindestumsatz (Betrag X). */
  mindestumsatz: number;
  /** Variante A: Stundensatz je Servicekraft (CHF), mit dem serviceA gerechnet wurde (im Snapshot eingefroren). */
  stundensatzA: number;
  /** Variante A: Richtwert der bestellten Getränke zu Kartenpreisen (bestellmengeA × Ø Verkauf, auf CHF 10 aufgerundet). */
  getraenkeA: number;
  /** Variante A: Service = Kräfte × Stunden pro Kraft × CHF 45, auf CHF 10 aufgerundet. */
  serviceA: number;
  /** Variante A: Richtwert gesamt = Getränke + Service (abgerechnet wird nach tatsächlicher Bestellung und Stunden). */
  richtpreisA: number;
  /** Variante A: erwartete Bestellmenge (Getränke, auf 10 aufgerundet). */
  bestellmengeA: number;
  erwarteterUmsatz: number;
  /** Variante B: Differenz, die die Kundschaft bei halber Menge zahlt. */
  differenzBeiHalberMenge: number;
  /** Kosten inkl. Puffer (= Grundlage des Mindestumsatzes vor dem Aufrunden). */
  kostenInklPuffer: number;
  /**
   * Deckungsbeitrag = Erlös − Einkauf der Getränke − Personal. Er ist KEIN Reingewinn: Zahlungsgebühren, Transport, Material,
   * Schwund über den Puffer hinaus und Gemeinkosten sind nicht abgezogen.
   * Variante A: Richtwert − Kosten der erwarteten Bestellmenge.
   */
  deckungsbeitragA: number;
  /** Variante B, wenn kein Gast etwas kauft: Mindestumsatz − Kosten (die Kundschaft zahlt den ganzen Mindestumsatz). Das ist das Garantierte. */
  deckungsbeitragBMin: number;
  /** Variante B bei halber erwarteter Menge. */
  deckungsbeitragBHalb: number;
  /** Variante B bei normalem (erwartetem) Konsum. */
  deckungsbeitragBNormal: number;
  /** Getränke pro Servicekraft und Stunde in der Pause (0 ohne Pause); über ca. 100 wird es knapp. */
  pauseProKraftStunde: number;
}

/** Auf CHF 10 aufrunden; vorher auf Rappen runden, damit 870.0000001 nicht 880 wird. */
export function aufrunden10(v: number): number {
  return Math.ceil(Math.round(v * 100) / 100 / 10) * 10;
}

export function mixDurchschnitt(zeilen: MixZeile[]): { einkauf: number; verkauf: number } {
  const mix = zeilen.filter((z) => z.mixAnteil != null && z.mixAnteil > 0);
  const summe = mix.reduce((s, z) => s + (z.mixAnteil as number), 0);
  if (mix.length === 0 || Math.abs(summe - 1) > 0.001) {
    throw new Error("Der Getränke-Mix muss zusammen 100 % ergeben");
  }
  return {
    einkauf: mix.reduce((s, z) => s + z.einkauf * (z.mixAnteil as number), 0),
    verkauf: mix.reduce((s, z) => s + z.verkauf * (z.mixAnteil as number), 0),
  };
}

export function rechneCatering(e: CateringEingabe, p: CateringParameter, karte: MixZeile[]): CateringErgebnis {
  const gaeste = Math.max(0, e.gaeste);
  const phase = (minuten: number, ph: { anteil: number; rate: number }) =>
    gaeste * ph.anteil * (Math.max(0, minuten) / 60) * ph.rate;
  const getraenkeVor = phase(e.vorzeitMin, p.vor);
  const getraenkePause = phase(e.pauseMin, p.pause);
  const getraenkeNach = phase(e.nachzeitMin, p.nach);
  const getraenke = getraenkeVor + getraenkePause + getraenkeNach;

  const mix = mixDurchschnitt(karte);
  const einkauf = getraenke * mix.einkauf;

  const kraefte = 1 + Math.floor(gaeste / Math.max(1, p.gaesteProKraft));
  const stundenProKraft = (Math.max(0, e.aufbauMin) + Math.max(0, e.gesamtMin) + Math.max(0, e.abbauMin)) / 60;
  const personal = kraefte * stundenProKraft * p.lohnProStunde;

  const kosten = einkauf + personal;
  const puffer = kosten * p.puffer;
  const mindestumsatz = aufrunden10(kosten + puffer);
  const bestellmengeA = aufrunden10(getraenke);
  const getraenkeA = aufrunden10(bestellmengeA * mix.verkauf);
  const serviceA = aufrunden10(kraefte * stundenProKraft * p.stundensatzA);
  const richtpreisA = getraenkeA + serviceA;
  const kostenA = bestellmengeA * mix.einkauf + personal;
  const erwarteterUmsatz = getraenke * mix.verkauf;

  return {
    getraenkeVor,
    getraenkePause,
    getraenkeNach,
    getraenke,
    getraenkeProGast: gaeste > 0 ? getraenke / gaeste : 0,
    einkaufProGetraenk: mix.einkauf,
    verkaufProGetraenk: mix.verkauf,
    einkauf,
    kraefte,
    stundenProKraft,
    personal,
    kosten,
    puffer,
    mindestumsatz,
    stundensatzA: p.stundensatzA,
    getraenkeA,
    serviceA,
    richtpreisA,
    bestellmengeA,
    erwarteterUmsatz,
    differenzBeiHalberMenge: Math.max(0, mindestumsatz - erwarteterUmsatz * 0.5),
    kostenInklPuffer: kosten + puffer,
    deckungsbeitragA: richtpreisA - kostenA,
    deckungsbeitragBMin: mindestumsatz - kosten,
    deckungsbeitragBHalb: Math.max(erwarteterUmsatz * 0.5, mindestumsatz) - kosten,
    deckungsbeitragBNormal: Math.max(erwarteterUmsatz, mindestumsatz) - kosten,
    pauseProKraftStunde: e.pauseMin > 0 ? getraenkePause / (e.pauseMin / 60) / kraefte : 0,
  };
}

/** Standardwerte, wenn noch nichts in den Einstellungen steht (= Excel-Stand 02.11.2026). */
export const CATERING_STANDARD: CateringParameter = {
  lohnProStunde: 32,
  gaesteProKraft: 50,
  puffer: 0.1,
  stundensatzA: 45,
  vor: { anteil: 0.85, rate: 1.2 },
  pause: { anteil: 0.9, rate: 3 },
  nach: { anteil: 0.65, rate: 1.2 },
};

/** Felder, die ein gespeichertes Ergebnis (job_catering.ergebnis) für Vertrag, Karte und Mailtext braucht. */
const SNAPSHOT_FELDER = [
  "kraefte", "stundenProKraft", "stundensatzA", "getraenkeA", "serviceA", "richtpreisA", "bestellmengeA",
  "mindestumsatz", "getraenkeProGast", "erwarteterUmsatz",
] as const;

/** false = vor einer Umstellung gespeichert (fehlende oder ungültige Felder) → neu speichern, sonst «NaN» in Vertrag und Mail. */
export function snapshotVollstaendig(e: Record<string, unknown> | null | undefined): boolean {
  return !!e && SNAPSHOT_FELDER.every((k) => typeof e[k] === "number" && Number.isFinite(e[k] as number));
}

/** Ab so vielen Getränken pro Servicekraft und Stunde in der Pause weist der Reiter auf eine knappe Besetzung hin (Annahme). */
export const PAUSE_WARNUNG_AB = 100;
