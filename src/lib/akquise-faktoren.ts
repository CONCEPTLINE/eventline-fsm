/**
 * Location-Akquise — Fachlogik: welches Kooperationsmodell passt zu einer
 * fremden Location, und was traegt sie EVENTLINE pro Jahr ein?
 *
 * Diese Datei ist die EINZIGE Stelle mit Geschaeftsannahmen. Alle Zahlen
 * unten sind Schaetzparameter, keine Messwerte — sie sind absichtlich hier
 * gebuendelt und kommentiert, damit Leo sie anpassen kann, ohne Code zu
 * lesen. Jede abgeleitete Zahl im UI fuehrt ihre Annahmen mit (siehe
 * `Bewertung.annahmen`), damit niemand eine Schaetzung fuer eine Messung
 * haelt.
 *
 * Die vier Modelle entsprechen dem, was EVENTLINE tatsaechlich anbietet:
 *   vermietungsmanagement  — wir vermarkten und buchen die Raeume
 *   vermietung_betreuung   — dazu Betreuung vor Ort am Eventtag
 *   betreuung              — nur Betreuung (das Barakuba-Modell)
 *   technikpartner         — nur Technik (Licht/Ton/Aufbau)
 */

export const KOOPERATIONS_MODELLE = [
  {
    key: "vermietungsmanagement",
    label: "Vermietungsmanagement",
    kurz: "Wir vermarkten und buchen",
    beschreibung:
      "EVENTLINE übernimmt Vermarktung, Anfragen, Buchung und Abwicklung der Räume. " +
      "Der Eigentümer bleibt Vermieter, wir bringen Nachfrage und Abwicklung.",
  },
  {
    key: "vermietung_betreuung",
    label: "Vermietung + Betreuung",
    kurz: "Vermarktung und Betrieb am Eventtag",
    beschreibung:
      "Vermietungsmanagement plus Betreuung vor Ort: Auf- und Abbau, Ansprechperson " +
      "am Eventtag, Koordination der Gewerke. Für Eigentümer ohne eigenes Personal.",
  },
  {
    key: "betreuung",
    label: "Location-Betreuung",
    kurz: "Betrieb vor Ort (Barakuba-Modell)",
    beschreibung:
      "Die Location wird weiter selbst vermarktet, EVENTLINE betreut den Betrieb vor Ort — " +
      "wie im Barakuba. Für Eigentümer mit Nachfrage, aber ohne operatives Team.",
  },
  {
    key: "technikpartner",
    label: "Technikpartner",
    kurz: "Licht, Ton, Aufbau",
    beschreibung:
      "Nur Veranstaltungstechnik als fester Partner der Location. Einstiegsmodell, " +
      "wenn Vermarktung und Betreuung bereits abgedeckt sind.",
  },
  {
    key: "keins",
    label: "Kein Ansatz",
    kurz: "Aktuell kein Hebel",
    beschreibung:
      "Location deckt Vermarktung, Betreuung und Technik selbst ab oder ist zu klein — " +
      "kein sinnvoller Einstieg erkennbar.",
  },
] as const;

export type ModellKey = (typeof KOOPERATIONS_MODELLE)[number]["key"];

export const EIGENTUEMER_TYPEN = [
  { key: "corporate", label: "Firma / Corporate", hinweis: "Marketingbudget, entscheidet schnell" },
  { key: "immobilien", label: "Immobilienverwaltung", hinweis: "Rechnet in Auslastung und Ertrag" },
  { key: "kultur", label: "Kulturbetrieb", hinweis: "Knappes Budget, oft eigenes Team" },
  { key: "oeffentlich", label: "Öffentliche Hand", hinweis: "Läuft über Ausschreibung (SIMAP)" },
  { key: "gastro", label: "Gastronomie / Hotel", hinweis: "Eigenes Personal, Technik fehlt oft" },
  { key: "unbekannt", label: "Unbekannt", hinweis: "Noch nicht recherchiert" },
] as const;

export type EigentuemerTyp = (typeof EIGENTUEMER_TYPEN)[number]["key"];

/**
 * Wofuer ist die Flaeche da? Der wichtigste Faktor ueberhaupt — er
 * entscheidet, ob es einen Kunden gibt, nicht wie gross er ist.
 *
 * EVENTLINE uebernimmt den Betrieb fremder Raeume fuer Eigentuemer, die
 * vermieten (wollen), aber den Betrieb nicht selbst machen. Wer seine
 * Flaeche selbst bespielt — Tanzschule, Club, Kino, Restaurant ohne Saal —
 * braucht das nicht, egal wie viel ihm sonst "fehlt". Genau daran ist die
 * erste Fassung dieser Logik gescheitert: sie hat Tanzschulen und ein
 * Apartmenthotel ganz nach oben sortiert.
 */
export const FLAECHEN_ARTEN = [
  { key: "vermietung", label: "Vermietungsfläche",
    hinweis: "Die Räume werden an Dritte vermietet — das ist der Zweck des Hauses" },
  { key: "nebenbei", label: "Vermietet nebenbei",
    hinweis: "Betrieb mit Saal/Raum, der zusätzlich vermietet wird (Hotel mit Bankettsaal)" },
  { key: "eigennutzung", label: "Eigennutzung",
    hinweis: "Nutzt die Fläche selbst, vermietet nicht — kein Kunde" },
  { key: "unklar", label: "Unklar", hinweis: "Noch nicht beurteilt" },
] as const;

export type FlaechenArt = (typeof FLAECHEN_ARTEN)[number]["key"];
/** Dreiwertig statt boolean: 'unklar' ist aus OSM-Daten der ehrliche Default. */
export type Dreiwertig = "ja" | "nein" | "unklar";

// ===========================================================================
// Schaetzparameter — HIER anpassen, nicht im Code weiter unten.
// ===========================================================================

export const ANNAHMEN = {
  /** Provision auf den vermittelten Mietumsatz (Vermietungsmanagement). */
  provision_pct: 15,
  /** Pauschale pro betreutem Event (Betreuung vor Ort). */
  betreuung_chf_pro_event: 450,
  /** Deckungsbeitrag pro Event als Technikpartner (Material + Crew). */
  technik_chf_pro_event: 800,
  /**
   * Tagesmiete nach Kapazitaet — Stufen, nicht Formel: der Markt preist
   * in Sprüngen (kleiner Raum / Saal / Halle), nicht linear pro Platz.
   */
  tagesmiete_chf: [
    { bis_kapazitaet: 50, chf: 600 },
    { bis_kapazitaet: 100, chf: 1100 },
    { bis_kapazitaet: 250, chf: 2200 },
    { bis_kapazitaet: 500, chf: 3800 },
    { bis_kapazitaet: Infinity, chf: 6000 },
  ],
  /**
   * Vermietbare Event-Tage pro Jahr. Konservativ: eine Location, die neu
   * vermarktet wird, faehrt im ersten Jahr keine Vollauslastung.
   */
  events_pro_jahr: {
    mit_eigener_vermarktung: 12,
    ohne_eigene_vermarktung: 20,
  },
  /** Ab dieser Kapazitaet lohnt der Aufwand ueberhaupt. */
  min_kapazitaet: 30,
} as const;

/** CHF-Betrag in Schweizer Schreibweise (1'234). */
const CHF_FORMAT = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 0 });
export function chf(betrag: number): string {
  return CHF_FORMAT.format(betrag);
}

export interface Faktoren {
  /** Wofuer ist die Flaeche da — das K.-o.-Kriterium. */
  flaeche: FlaechenArt;
  kapazitaet: number | null;
  eigene_vermarktung: Dreiwertig;
  personal_vor_ort: Dreiwertig;
  technik_vorhanden: Dreiwertig;
  eigentuemer_typ: EigentuemerTyp;
}

export interface Bewertung {
  modell: ModellKey;
  /** Geschaetzter EVENTLINE-Jahresbeitrag in CHF. */
  rentabilitaet_chf: number;
  /** 0..100 — Sortierachse der Trefferliste. */
  score: number;
  begruendung: string;
  teilscores: { hebel: number; groesse: number; zugang: number };
  annahmen: string[];
  /** Weitere denkbare Modelle, schwaecher als das empfohlene. */
  alternativen: ModellKey[];
}

/** Tagesmiete zur Kapazitaet aus der Stufen-Tabelle. */
export function tagesmiete(kapazitaet: number): number {
  for (const stufe of ANNAHMEN.tagesmiete_chf) {
    if (kapazitaet <= stufe.bis_kapazitaet) return stufe.chf;
  }
  return ANNAHMEN.tagesmiete_chf[ANNAHMEN.tagesmiete_chf.length - 1].chf;
}

/**
 * Modellwahl. Die Logik folgt dem, was fehlt — nicht dem, was da ist:
 * fehlende Vermarktung ist der groesste Hebel, fehlendes Personal der
 * zweite, fehlende Technik der kleinste. 'unklar' wird wie 'nein'
 * behandelt, aber in den Annahmen vermerkt: ein Gespraech klaert es,
 * und ein uebersehener Kandidat kostet mehr als ein geprueftes Nein.
 */
export function waehleModell(f: Faktoren): { modell: ModellKey; alternativen: ModellKey[] } {
  // Wer die Flaeche selbst bespielt, hat keinen Bedarf an Betrieb oder
  // Vermarktung durch Dritte — unabhaengig davon, was ihm sonst fehlt.
  if (f.flaeche === "eigennutzung") return { modell: "keins", alternativen: [] };

  const vermarktungFehlt = f.eigene_vermarktung !== "ja";
  const personalFehlt = f.personal_vor_ort !== "ja";
  const technikFehlt = f.technik_vorhanden !== "ja";

  if (vermarktungFehlt && personalFehlt) {
    return {
      modell: "vermietung_betreuung",
      alternativen: technikFehlt ? ["vermietungsmanagement", "technikpartner"] : ["vermietungsmanagement"],
    };
  }
  if (vermarktungFehlt) {
    return { modell: "vermietungsmanagement", alternativen: technikFehlt ? ["technikpartner"] : [] };
  }
  if (personalFehlt) {
    return { modell: "betreuung", alternativen: technikFehlt ? ["technikpartner"] : [] };
  }
  if (technikFehlt) {
    return { modell: "technikpartner", alternativen: [] };
  }
  return { modell: "keins", alternativen: [] };
}

/** Jahresbeitrag fuer EVENTLINE unter dem gewaehlten Modell. */
export function rentabilitaet(modell: ModellKey, f: Faktoren): number {
  const kap = f.kapazitaet ?? 0;
  if (modell === "keins" || f.flaeche === "eigennutzung") return 0;
  if (kap < ANNAHMEN.min_kapazitaet) return 0;

  const events = f.eigene_vermarktung === "ja"
    ? ANNAHMEN.events_pro_jahr.mit_eigener_vermarktung
    : ANNAHMEN.events_pro_jahr.ohne_eigene_vermarktung;
  const mietumsatz = tagesmiete(kap) * events;
  const provision = Math.round((mietumsatz * ANNAHMEN.provision_pct) / 100);
  const betreuung = ANNAHMEN.betreuung_chf_pro_event * events;
  const technik = ANNAHMEN.technik_chf_pro_event * events;

  switch (modell) {
    case "vermietungsmanagement": return provision;
    case "vermietung_betreuung":  return provision + betreuung;
    case "betreuung":             return betreuung;
    case "technikpartner":        return technik;
    default:                      return 0;
  }
}

/**
 * Wer tritt als Vertragspartner auf — der Verein KULTURLINE oder die
 * EVENTLINE GmbH?
 *
 * Leos Regel: Bei kleineren kulturellen Haeusern passt KULTURLINE. Ein
 * Verein gilt als agiler, und die Gegenseite fuehlt sich weniger
 * eingeengt — vor einer GmbH haben kulturelle Traeger oft Respekt, weil
 * sie Kommerzialisierung und Bindung fuerchten.
 *
 * Dazu kommt ein Argument, das eine GmbH gar nicht bieten kann: KULTURLINE
 * hat einen **Fonds, der Veranstaltungen refinanziert**. Fuer ein Haus
 * ohne eigenes Budget ist das oft der Punkt, an dem eine Kooperation
 * ueberhaupt denkbar wird — nicht die Betriebsentlastung.
 *
 * Unveraenderlich in beiden Faellen: **Betrieb und Administration macht
 * immer die EVENTLINE GmbH.** KULTURLINE ist das Vertragsgesicht, nicht
 * der ausfuehrende Betrieb — was KULTURLINE aushandelt, setzt EVENTLINE
 * um. Das steht so auch in Leos Vorlage («exklusiver operativer Partner»).
 */
export type Traeger = "kulturline" | "eventline";

/** Ab dieser Kapazitaet ist ein Haus kein "kleineres" mehr. */
const KULTURLINE_MAX_KAPAZITAET = 400;

export function waehleTraeger(f: Faktoren): { traeger: Traeger; begruendung: string } {
  const kulturnah = f.eigentuemer_typ === "kultur" || f.eigentuemer_typ === "oeffentlich";
  const klein = f.kapazitaet === null || f.kapazitaet <= KULTURLINE_MAX_KAPAZITAET;

  if (kulturnah && klein) {
    return {
      traeger: "kulturline",
      begruendung:
        "Kleineres Haus in kultureller bzw. öffentlicher Trägerschaft — als Verein wirkt " +
        "KULTURLINE agiler und weniger einengend als eine GmbH, und der KULTURLINE-Fonds " +
        "kann Veranstaltungen mitfinanzieren. Betrieb und Administration laufen trotzdem " +
        "über die EVENTLINE GmbH.",
    };
  }
  if (kulturnah && !klein) {
    return {
      traeger: "eventline",
      begruendung:
        "Kulturelle Trägerschaft, aber ein grosses Haus — dort zählt die Verbindlichkeit " +
        "einer GmbH mehr als die Beweglichkeit eines Vereins.",
    };
  }
  return {
    traeger: "eventline",
    begruendung:
      "Gewerblicher bzw. kommerzieller Gegenüber — hier ist die EVENTLINE GmbH der " +
      "natürliche Vertragspartner; ein Verein würde eher Fragen aufwerfen als Nähe schaffen.",
  };
}

/**
 * Die Zahlen, auf denen ein Kooperationskonzept steht.
 *
 * Leos Vorlage (Querfeld-Halle) fuehrt drei Groessen auf der Titelseite:
 * Veranstaltungstage pro Jahr, was davon beim Partner bleibt, und der
 * Anteil pro Tag. Genau diese drei werden hier gerechnet — sie duerfen
 * NICHT aus dem Sprachmodell kommen, sonst stehen erfundene Betraege in
 * einem Dokument, das beim Kunden auf dem Tisch liegt.
 *
 * Alles beruht auf ANNAHMEN oben; `grundlage` schreibt mit, womit
 * gerechnet wurde, damit die Zahlen im Gespraech erklaerbar sind.
 */
export interface KonzeptKennzahlen {
  /** Veranstaltungstage pro Jahr, auf die sich die Rechnung stuetzt. */
  tage_pro_jahr: number;
  /** Was die Location pro Jahr einnimmt (Mietumsatz abzueglich unseres Anteils). */
  partner_chf_pro_jahr: number;
  /** Unser Anteil pro Veranstaltungstag — untere und obere Schaetzung. */
  anteil_pro_tag_von: number;
  anteil_pro_tag_bis: number;
  /** Womit gerechnet wurde, in einem Satz. */
  grundlage: string;
}

export function konzeptKennzahlen(f: Faktoren, modell: ModellKey): KonzeptKennzahlen | null {
  const kap = f.kapazitaet;
  if (kap === null || kap < ANNAHMEN.min_kapazitaet || modell === "keins") return null;

  const tage = f.eigene_vermarktung === "ja"
    ? ANNAHMEN.events_pro_jahr.mit_eigener_vermarktung
    : ANNAHMEN.events_pro_jahr.ohne_eigene_vermarktung;
  const miete = tagesmiete(kap);
  const unserJahr = rentabilitaet(modell, f);
  const unserTag = Math.round(unserJahr / tage);

  // Spanne statt Punktwert: der Tagesanteil schwankt mit Anlassgroesse
  // und Leistungsumfang. +/- 40 % bildet das ehrlicher ab als eine
  // Scheingenauigkeit auf den Franken.
  const von = Math.max(50, Math.round((unserTag * 0.6) / 10) * 10);
  const bis = Math.round((unserTag * 1.4) / 10) * 10;

  return {
    tage_pro_jahr: tage,
    partner_chf_pro_jahr: Math.max(0, miete * tage - unserJahr),
    anteil_pro_tag_von: von,
    anteil_pro_tag_bis: bis,
    grundlage:
      `${tage} Veranstaltungstage pro Jahr, Tagesmiete rund ${chf(miete)} CHF ` +
      `bei ${kap} Plätzen, EVENTLINE-Anteil nach Modell «${
        KOOPERATIONS_MODELLE.find((m) => m.key === modell)?.label ?? modell}».`,
  };
}

/**
 * Gesamtbewertung aus drei Teilscores:
 *   hebel   — wie viel koennen wir uebernehmen (was fehlt der Location)
 *   groesse — Kapazitaet, auf 500 Plaetze normiert
 *   zugang  — wie gut kommen wir an den Eigentuemer heran
 * Gewichtung 50/30/20: der Hebel entscheidet, ob es ueberhaupt ein
 * Geschaeft gibt; Groesse skaliert es; Zugang bestimmt nur, wie teuer
 * die Akquise wird.
 */
export function bewerte(f: Faktoren): Bewertung {
  const { modell, alternativen } = waehleModell(f);
  const kap = f.kapazitaet;

  // Was fehlt der Location (0..100) — aber nur relevant, wenn sie ihre
  // Flaeche ueberhaupt vermietet.
  const fehlt = [
    f.eigene_vermarktung !== "ja",
    f.personal_vor_ort !== "ja",
    f.technik_vorhanden !== "ja",
  ].filter(Boolean).length;
  const luecke = Math.round((fehlt / 3) * 100);

  /**
   * Bedarf = Flaechenart × Luecke. Eine Vermietungsflaeche ohne eigenes
   * Personal ist der Kernfall; ein Betrieb, der nebenbei vermietet, ist
   * der halbe Fall; Eigennutzung ist kein Fall. Das ist die Achse, auf
   * die es ankommt — nicht Groesse, nicht Erreichbarkeit.
   */
  const flaechenGewicht: Record<FlaechenArt, number> = {
    vermietung: 1,
    nebenbei: 0.55,
    eigennutzung: 0,
    unklar: 0.4, // nicht ausschliessen, aber auch nicht nach oben spuelen
  };
  const bedarf = Math.round(luecke * flaechenGewicht[f.flaeche]);

  const groesse = kap === null
    ? 30 // unbekannte Kapazitaet: nicht ausschliessen, aber nicht belohnen
    : Math.min(100, Math.round((kap / 500) * 100));

  const zugangTabelle: Record<EigentuemerTyp, number> = {
    immobilien: 95,   // Eigentuemer mit Flaeche, rechnet in Auslastung — Kernkunde
    corporate: 85,    // Budget da, kurze Entscheidungswege
    gastro: 60,       // Personal da, Technik fehlt oft
    kultur: 35,       // knappes Budget, meist eigenes Team
    oeffentlich: 10,  // laeuft ueber Ausschreibung (SIMAP), nicht ueber Akquise
    unbekannt: 45,
  };
  const zugang = zugangTabelle[f.eigentuemer_typ];

  // Bedarf dominiert mit 60 % — ein grosses Haus ohne Bedarf bleibt unten.
  const score = modell === "keins"
    ? 0
    : Math.round(bedarf * 0.6 + groesse * 0.2 + zugang * 0.2);

  const annahmen: string[] = [];
  if (f.flaeche === "unklar") {
    annahmen.push("Unklar, ob die Fläche überhaupt vermietet wird — Bedarf nur zu 40 % gewertet.");
  }
  if (kap === null) annahmen.push("Kapazität unbekannt — Grösse pauschal mit 30/100 gewertet.");
  if (f.eigene_vermarktung === "unklar") annahmen.push("Eigene Vermarktung unklar — als «fehlt» gewertet.");
  if (f.personal_vor_ort === "unklar") annahmen.push("Personal vor Ort unklar — als «fehlt» gewertet.");
  if (f.technik_vorhanden === "unklar") annahmen.push("Technik unklar — als «fehlt» gewertet.");
  if (f.eigentuemer_typ === "unbekannt") annahmen.push("Eigentümer-Typ unbekannt — Zugang neutral mit 45/100.");
  if (f.eigentuemer_typ === "oeffentlich") {
    annahmen.push("Öffentliche Hand — läuft über Ausschreibung (SIMAP), nicht über Akquise.");
  }
  if (kap !== null && kap < ANNAHMEN.min_kapazitaet) {
    annahmen.push(`Unter ${ANNAHMEN.min_kapazitaet} Plätzen — Rentabilität auf 0 gesetzt.`);
  }
  annahmen.push(
    `Rechnung: ${ANNAHMEN.provision_pct}% Provision, ` +
    `${ANNAHMEN.betreuung_chf_pro_event} CHF Betreuung/Event, ` +
    `${ANNAHMEN.technik_chf_pro_event} CHF Technik/Event.`,
  );

  const modellLabel = KOOPERATIONS_MODELLE.find((m) => m.key === modell)?.label ?? modell;
  const flaecheLabel = FLAECHEN_ARTEN.find((a) => a.key === f.flaeche)?.label ?? f.flaeche;
  const begruendung = f.flaeche === "eigennutzung"
    ? "Nutzt die Fläche selbst und vermietet sie nicht — kein Ansatz für EVENTLINE."
    : modell === "keins"
      ? "Vermarktung, Betreuung und Technik sind abgedeckt — kein Einstieg erkennbar."
      : `${modellLabel}. ${flaecheLabel}, ${fehlt} von 3 Leistungen fehlen.` +
        (kap !== null ? ` Kapazität ${kap} Plätze.` : " Kapazität unbekannt.");

  return {
    modell,
    rentabilitaet_chf: rentabilitaet(modell, f),
    score,
    begruendung,
    teilscores: { hebel: bedarf, groesse, zugang },
    annahmen,
    alternativen,
  };
}
