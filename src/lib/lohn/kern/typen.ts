// Rechenkern Lohn — Ein- und Ausgabetypen.
//
// Beschreibung für das Backoffice: C:\Users\misch\projects\_backoffice-uebergabe\09_Rechenkern.md
//
// Konventionen:
//   - Datum (IsoDatum): "YYYY-MM-DD", Kalendertag in Europe/Zurich.
//   - Zeitpunkt: ISO 8601 mit Zone (z. B. aus Postgres timestamptz).
//   - Prozent als Zahl (5.3 = 5,30 %).
//   - Beträge in CHF; gerundet wird genau einmal je Betrag und Monat
//     (siehe runden.ts, 5 Rappen). Mengen bleiben exakte Minuten.

export type IsoDatum = string;
export type Zeitpunkt = string;

/** Eine Stempelzeit [start, ende). ende null = noch offen → zählt nicht. */
export interface Stempel {
  id?: string;
  start: Zeitpunkt;
  ende: Zeitpunkt | null;
}

/** Abzüge Arbeitnehmer in % vom jeweiligen Lohn. */
export interface AbzugsSaetze {
  ahvIvEo: number;
  alv: number;
  nbu: number;
  bvg: number;
  ktg: number;
  /** Quellensteuer: fester Satz aus der Lohnzeile (keine Tarif-Tabellen). */
  quellensteuer: number;
}

/** Beiträge Arbeitgeber in % vom Bruttolohn. */
export interface ArbeitgeberSaetze {
  ahvIvEo: number;
  alv: number;
  fak: number;
  bu: number;
  bvg: number;
  verwaltung: number;
}

/** Firmensätze, gültig ab einem Datum bis zur nächsten Zeile. */
export interface Firmensatz {
  gueltigAb: IsoDatum;
  an: AbzugsSaetze;
  ag: ArbeitgeberSaetze;
  /** BVG-Eintrittsschwelle in CHF je Monat (nur für Hinweise). */
  bvgSchwelleMonat: number;
}

/**
 * Lohnzeile (Stundenlohn) einer Person mit Gültigkeit [gueltigAb, gueltigBis].
 * Der Lohn gilt TAGEWEISE: jede Minute wird mit der Zeile ihres Kalendertags
 * bezahlt (Lohnerhöhung mitten im Monat).
 */
export interface Lohnzeile {
  id?: string;
  gueltigAb: IsoDatum;
  gueltigBis: IsoDatum | null;
  /** CHF je Stunde. */
  stundenlohn: number;
  /**
   * "inkl_ferien": Stundenlohn enthält den Ferienzuschlag (EVENTLINE-Verträge:
   *   «26.00 inkl. 8,33 % Ferien»). Basislohn = Stundenlohn / (1 + Ferien-%).
   * "basis": Stundenlohn ist der Basislohn, Ferienzuschlag kommt dazu.
   */
  stundenlohnArt: "inkl_ferien" | "basis";
  /** Fester Ferienzuschlag in % (Vertrag), sonst null = nach Alter. */
  ferienPctFix: number | null;
  /** true = kein Lohn (z. B. Inhaber), Minuten werden nicht bezahlt. */
  ohneLohn: boolean;
  /** Eigene Sätze dieser Zeile; null = Firmensätze. */
  eigeneSaetze: { an: AbzugsSaetze; ag: ArbeitgeberSaetze } | null;
}

/** Anstellung (Eintritt bis Austritt, inklusiv). */
export interface Anstellung {
  eintritt: IsoDatum;
  austritt: IsoDatum | null;
  ruhendVon?: IsoDatum | null;
  ruhendBis?: IsoDatum | null;
}

export interface Person {
  id?: string;
  /** Pflicht, ausser jede Lohnzeile hat einen festen Ferienzuschlag. */
  geburtsdatum: IsoDatum | null;
  /** null = Anstellung unbekannt (keine Einschränkung, Hinweis). */
  anstellungen: Anstellung[] | null;
  /** Jahre, in denen die Person AHV-Beiträge auch unter CHF 2'500 verlangt (Art. 34d Abs. 2 AHVV). */
  ahvVerlangtJahre: number[];
}

export interface Feiertag {
  datum: IsoDatum;
  name: string;
}

/** Summen früherer Monate mit Auszahlung im selben Jahr (Auszahlungsprinzip). */
export interface BisherImAuszahlungsjahr {
  ahvLohn: number;
  alvLohn: number;
  uvgLohn: number;
}

export interface MonatsEingabe {
  jahr: number;
  /** 1–12 */
  monat: number;
  person: Person;
  /**
   * Stempel der Person mindestens im Bereich stempelBereich(jahr, monat)
   * (Jahreszähler Sonntag/Nacht, NBU-Zeitraum 12 Monate). Mehr schadet nicht.
   */
  stempel: Stempel[];
  lohnzeilen: Lohnzeile[];
  firmensaetze: Firmensatz[];
  /** Feiertage aller Jahre, die der Stempel-Bereich berührt. */
  feiertage: Feiertag[];
  /** Tag der Auszahlung — bestimmt Sätze und Auszahlungsjahr. */
  auszahlungsdatum: IsoDatum;
  bisher?: BisherImAuszahlungsjahr;
}

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

export type Lohnart =
  | "normal"
  | "sonntag"
  | "nacht"
  | "feiertag_1aug"
  | "ferien";

export interface Position {
  lohnart: Lohnart;
  bezeichnung: string;
  /** Menge in Minuten (Stunden-Lohnarten), sonst null. */
  minuten: number | null;
  /** Ansatz CHF/h (ungerundet) bei Stunden-Lohnarten, sonst null. */
  ansatz: number | null;
  /** Prozent bei Prozent-Lohnarten (Zuschlag), sonst null. */
  prozent: number | null;
  /** Basis (CHF, ungerundet) bei Prozent-Lohnarten, sonst null. */
  basis: number | null;
  /** Betrag CHF, auf 5 Rappen gerundet. */
  betrag: number;
}

export type AbzugArt = "ahv_iv_eo" | "alv" | "nbu" | "bvg" | "ktg" | "quellensteuer";

export interface Abzug {
  art: AbzugArt;
  bezeichnung: string;
  prozent: number;
  basis: number;
  /** Betrag CHF (positiv = Abzug), auf 5 Rappen gerundet. */
  betrag: number;
}

export type ArbeitgeberArt = "ahv_iv_eo" | "alv" | "fak" | "bu" | "bvg" | "verwaltung";

export interface ArbeitgeberBeitrag {
  art: ArbeitgeberArt;
  prozent: number;
  betrag: number;
}

export interface NbuVariante {
  monate: 3 | 12;
  von: IsoDatum;
  bis: IsoDatum;
  /** Ganze Wochen im Zeitraum (innerhalb der Anstellung). */
  wochen: number;
  /** Davon Wochen mit Arbeit. */
  arbeitswochen: number;
  /** Überwiegen die Arbeitswochen, zählen nur sie, sonst alle Wochen. */
  nurArbeitswochen: boolean;
  minuten: number;
  durchschnittStunden: number;
  erreicht: boolean;
}

export interface NbuStatus {
  versichert: boolean;
  /** Variante, die den Ausschlag gibt (die für die Person günstigere). */
  massgebend: 3 | 12 | null;
  varianten: [NbuVariante, NbuVariante];
  begruendung: string;
}

export interface Ahv2500 {
  auszahlungsjahr: number;
  grenze: number;
  ahvLohnBisher: number;
  ahvLohnInklMonat: number;
  verlangt: boolean;
  /** "unter": bisher unter der Grenze, Beiträge nur auf Verlangen (Bereinigung Jahresende). */
  status: "unter" | "ueberschritten" | "verlangt";
}

export interface TagesZeile {
  datum: IsoDatum;
  minuten: number;
  nachtMinuten: number;
  sonntagMinuten: number;
  /** Schlüssel des Sonn-/Feiertags (Sa 23 – So 23), dem Sonntagsminuten dieses Tages angehören. */
  feiertagName: string | null;
  lohnzeileId: string | null;
  /** Basislohn CHF/h an diesem Tag (ohne Ferien), null = ohne Lohn. */
  basislohn: number | null;
  ferienPct: number | null;
  /** Minuten ausserhalb der Anstellung (nicht bezahlt). */
  ausserhalbAnstellung: number;
}

export interface Einsatzeinheit {
  /** Schlüssel-Datum: Sonntag/Feiertag bzw. Abend (Beginn 23 Uhr) der Nacht. */
  datum: IsoDatum;
  /** Rang im Kalenderjahr des Schlüssel-Datums (1 = erster). */
  rang: number;
  minutenImMonat: number;
  mitZuschlag: boolean;
  name?: string;
}

export interface Mengen {
  /** Bezahlte Minuten im Monat (ohne Minuten ausserhalb der Anstellung / ohne Lohn). */
  minuten: number;
  sonntagMinutenMitZuschlag: number;
  sonntagMinutenOhneZuschlag: number;
  nachtMinutenMitZuschlag: number;
  nachtMinutenOhneZuschlag: number;
  /** Zeitzuschlag 10 % der Nachtminuten ab der 25. Nacht (bezahlte Ausgleichsruhezeit). */
  zeitzuschlagMinuten: number;
  sonntage: Einsatzeinheit[];
  naechte: Einsatzeinheit[];
  sonntageImJahrVorMonat: number;
  naechteImJahrVorMonat: number;
}

export interface Hinweis {
  code:
    | "anstellung_unbekannt"
    | "ausserhalb_anstellung"
    | "ruhend"
    | "offener_stempel"
    | "ueberlappung"
    | "ohne_lohn"
    | "ahv_2500"
    | "quellensteuer"
    | "bvg_schwelle"
    | "zeitzuschlag"
    | "sonntag_limit"
    | "ferien_alter";
  text: string;
}

export interface MonatsErgebnis {
  kernVersion: string;
  jahr: number;
  monat: number;
  auszahlungsdatum: IsoDatum;
  auszahlungsjahr: number;
  /** Lohnperiode (Tage der Anstellung im Monat), null = keine Anstellung im Monat. */
  lohnperiode: { von: IsoDatum; bis: IsoDatum } | null;
  mengen: Mengen;
  tage: TagesZeile[];
  positionen: Position[];
  brutto: number;
  /** Massgebende Löhne (CHF) für Sozialversicherungen und Jahresliste. */
  loehne: {
    ahv: number;
    alv: number;
    uvg: number;
    /** UVG-Lohn mit NBU (versichert) bzw. nur BU. */
    uvgArt: "bu_nbu" | "bu";
    quellensteuer: number;
  };
  abzuege: Abzug[];
  totalAbzuege: number;
  netto: number;
  arbeitgeber: ArbeitgeberBeitrag[];
  totalArbeitgeber: number;
  vollkosten: number;
  /** Angewandte Sätze (Herkunft). */
  saetze: {
    herkunft: "firma" | "lohnzeile";
    firmensatzAb: IsoDatum | null;
    lohnzeileId: string | null;
    an: AbzugsSaetze;
    ag: ArbeitgeberSaetze;
    bvgSchwelleMonat: number;
  };
  nbu: NbuStatus;
  ahv2500: Ahv2500;
  hinweise: Hinweis[];
}
