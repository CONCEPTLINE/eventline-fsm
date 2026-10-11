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

/**
 * Die drei Modelle aus Leos Akquise-Auftrag. Welches passt, haengt nicht
 * davon ab, was ein Haus alles nicht hat, sondern davon, ob seine
 * Zeitfenster real leer stehen und die Vermietung den Betrieb belastet.
 *
 * Wichtig: A ist nur dort richtig, wo beides zutrifft. Ein gut
 * ausgelastetes Haus bekommt B oder C — und die Begruendung dafuer
 * gehoert offen ins Dokument, nicht weggelassen.
 */
export const KOOPERATIONS_MODELLE = [
  {
    key: "betriebspartner",
    label: "A · Betriebspartner",
    kurz: "Verein übernimmt Zeitfenster",
    traeger: "kulturline" as const,
    beschreibung:
      "Der Verein KULTURLINE übernimmt definierte Zeitfenster, bespielt und vermietet sie. " +
      "Der Ort erhält pro Veranstaltungstag einen fixen Anteil — ohne Aufwand und ohne Risiko.",
  },
  {
    key: "servicepartner",
    label: "B · Service-Partner",
    kurz: "Technik und Personal für die Mieter",
    traeger: "eventline" as const,
    beschreibung:
      "Der Ort vermietet weiterhin selbst. EVENTLINE liefert Technikpakete, Personal und " +
      "Betreuung für die Mieter — der Betrieb am Anlass liegt bei uns.",
  },
  {
    key: "kulturfenster",
    label: "C · Kulturfenster",
    kurz: "Einzelne Abende oder eine Reihe",
    traeger: "kulturline" as const,
    beschreibung:
      "Der Verein KULTURLINE bespielt einzelne Abende oder eine Reihe. Der Ort bleibt " +
      "Hausherr und behält sein Programm.",
  },
  {
    key: "keins",
    label: "Kein Ansatz",
    kurz: "Aktuell kein Hebel",
    traeger: "eventline" as const,
    beschreibung:
      "Das Haus vermietet nicht an Dritte oder deckt Vermarktung, Betrieb und Technik " +
      "vollständig selbst ab — kein sinnvoller Einstieg erkennbar.",
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

/**
 * Tarifgrundlage aus dem Akquise-Auftrag. **Intern** — die Formel wird
 * nie nach aussen kommuniziert, nur ihr Ergebnis als Tagesansatz.
 *
 * Tagesmietwert = Monatsmiete ÷ 28, dann mal dem Faktor der Kategorie,
 * aufgerundet auf CHF 10. Newcomer zahlen damit den reinen Tageswert,
 * kommerzielle Mieter das Dreifache — das ist der Spielraum, aus dem
 * der Foerderfonds die guenstigen Kategorien mittraegt.
 */
export const ANNAHMEN = {
  /** Tage, auf die eine Monatsmiete umgelegt wird. */
  tage_pro_monat: 28,
  /** Faktor je Mieterkategorie auf den Tagesmietwert. */
  tarif_faktoren: {
    newcomer: 1.0,
    verein: 1.35,
    kultur: 1.5,
    nonprofit: 1.7,
    standard: 3.0,
  },
  /** Tarife werden auf diesen Betrag aufgerundet. */
  rundung_chf: 10,
  /** Kostenlose Eventberatung pro Jahr fuer die eigenen Produktionen. */
  beratung_stunden_pro_jahr: 10,
  /**
   * Veranstaltungstage pro Jahr, auf die eine Zusammenarbeit anlaeuft.
   * Konservativ: ein neu vermarktetes Haus faehrt im ersten Jahr keine
   * Vollauslastung.
   */
  tage_pro_jahr: {
    betriebspartner: 20,
    servicepartner: 12,
    kulturfenster: 6,
  },
  /** Ab dieser Kapazitaet lohnt der Aufwand ueberhaupt. */
  min_kapazitaet: 30,
} as const;

export type Mieterkategorie = keyof typeof ANNAHMEN.tarif_faktoren;

/**
 * Tagesansatz fuer eine Mieterkategorie. Gibt null, wenn die Monatsmiete
 * unbekannt ist — eine Tarifzahl ohne Grundlage waere im Gespraech
 * schlimmer als keine.
 */
export function tagesansatz(monatsmiete: number | null, kategorie: Mieterkategorie): number | null {
  if (monatsmiete === null || monatsmiete <= 0) return null;
  const tageswert = monatsmiete / ANNAHMEN.tage_pro_monat;
  const roh = tageswert * ANNAHMEN.tarif_faktoren[kategorie];
  return Math.ceil(roh / ANNAHMEN.rundung_chf) * ANNAHMEN.rundung_chf;
}

/** CHF-Betrag in Schweizer Schreibweise (1'234). */
const CHF_FORMAT = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 0 });
export function chf(betrag: number): string {
  return CHF_FORMAT.format(betrag);
}

export interface Faktoren {
  /** Wofuer ist die Flaeche da — das K.-o.-Kriterium. */
  flaeche: FlaechenArt;
  kapazitaet: number | null;
  /**
   * Stehen Zeitfenster real leer? Entscheidet zusammen mit der
   * Betriebsbelastung ueber Modell A — und zaehlt im Scoring mit 20 %.
   */
  zeitfenster_frei: Dreiwertig;
  /**
   * Monatsmiete der Liegenschaft in CHF, Grundlage der Tarifrechnung
   * (Tagesmietwert = Monatsmiete ÷ 28). Selten oeffentlich — null heisst:
   * keine Tarife rechenbar, dann steht im Dokument auch keine Zahl.
   */
  monatsmiete_chf: number | null;
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
  /** Die fuenf Kriterien des Auftrags, je 1–5. */
  teilscores: {
    raumpotenzial: number;
    zeitfenster: number;
    entlastungsbedarf: number;
    modellpassung: number;
    erreichbarkeit: number;
  };
  /** Gewichteter Gesamtwert 1–5 (eine Dezimale). */
  gesamt: number;
  /** A ab 3.8, B ab 3.0, sonst C. */
  prioritaet: "A" | "B" | "C";
  annahmen: string[];
  /** Weitere denkbare Modelle, schwaecher als das empfohlene. */
  alternativen: ModellKey[];
}

/**
 * Modellwahl nach der Entscheidungslogik des Auftrags.
 *
 * A (Betriebspartner) verlangt ZWEI Dinge gleichzeitig: leer stehende
 * Zeitfenster und eine Vermietung, die den Betrieb belastet. Fehlt eines
 * davon, waere A ein Uebergriff auf ein Haus, das seinen Betrieb im Griff
 * hat — dann ist B oder C richtig.
 *
 * B passt, wo das Haus selbst vermietet, aber die Technik fehlt.
 * C passt, wo das Haus ausgelastet und besetzt ist: dort bleibt nur, mit
 * eigenem Programm einzelne Abende zu bespielen.
 */
export function waehleModell(f: Faktoren): { modell: ModellKey; alternativen: ModellKey[] } {
  // Wer die Flaeche selbst bespielt, vermietet nicht — kein Ansatz.
  if (f.flaeche === "eigennutzung") return { modell: "keins", alternativen: [] };

  const zeitfensterFrei = f.zeitfenster_frei !== "nein";
  const betriebBelastet = f.personal_vor_ort !== "ja";
  const technikFehlt = f.technik_vorhanden !== "ja";
  const vermarktungFehlt = f.eigene_vermarktung !== "ja";

  // A: leere Zeitfenster UND belasteter Betrieb — beides muss stimmen.
  if (zeitfensterFrei && betriebBelastet) {
    return {
      modell: "betriebspartner",
      alternativen: technikFehlt ? ["servicepartner", "kulturfenster"] : ["kulturfenster"],
    };
  }

  // B: Haus vermietet selbst, aber ohne eigene Technik oder Betreuung.
  if (technikFehlt || betriebBelastet) {
    return {
      modell: "servicepartner",
      alternativen: zeitfensterFrei ? ["kulturfenster"] : [],
    };
  }

  // C: alles besetzt — bleibt die eigene Bespielung einzelner Abende.
  if (zeitfensterFrei || vermarktungFehlt) {
    return { modell: "kulturfenster", alternativen: [] };
  }

  return { modell: "keins", alternativen: [] };
}

/**
 * Was der Ort pro Jahr aus der Zusammenarbeit erhaelt.
 *
 * Grundlage ist der Tagesansatz der Standard-Kategorie: daraus bekommt
 * der Ort pro Veranstaltungstag einen fixen Anteil. Ohne Monatsmiete
 * gibt es keine Zahl — geschaetzte Tarife in einem Dokument, das beim
 * Partner liegt, waeren nicht mehr einzufangen.
 */
export function ortAnteilProJahr(modell: ModellKey, f: Faktoren): number | null {
  if (modell === "keins") return null;
  const satz = tagesansatz(f.monatsmiete_chf, "standard");
  if (satz === null) return null;
  const tage = ANNAHMEN.tage_pro_jahr[modell];
  // Der Ort traegt kein Risiko und keinen Aufwand — sein Anteil ist der
  // Tageswert der Liegenschaft, der Aufschlag bleibt beim Betrieb.
  const proTag = Math.ceil(
    (f.monatsmiete_chf! / ANNAHMEN.tage_pro_monat) / ANNAHMEN.rundung_chf,
  ) * ANNAHMEN.rundung_chf;
  return proTag * tage;
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
  /** Was der Ort pro Jahr erhaelt, ohne Aufwand und ohne Risiko. */
  ort_chf_pro_jahr: number;
  /** Fixer Anteil des Ortes pro Veranstaltungstag. */
  ort_chf_pro_tag: number;
  /** Tagesansaetze je Mieterkategorie — Grundlage fuer Kapitel 07. */
  tarife: { kategorie: Mieterkategorie; label: string; chf: number }[];
  /** Womit gerechnet wurde, in einem Satz (intern). */
  grundlage: string;
}

const KATEGORIE_LABEL: Record<Mieterkategorie, string> = {
  newcomer: "Newcomer",
  verein: "Verein",
  kultur: "Kultur",
  nonprofit: "Nonprofit und Feste",
  standard: "Standard",
};

export function konzeptKennzahlen(f: Faktoren, modell: ModellKey): KonzeptKennzahlen | null {
  if (modell === "keins") return null;
  const jahr = ortAnteilProJahr(modell, f);
  if (jahr === null) return null;

  const tage = ANNAHMEN.tage_pro_jahr[modell];
  const tarife = (Object.keys(ANNAHMEN.tarif_faktoren) as Mieterkategorie[])
    .map((k) => ({ kategorie: k, label: KATEGORIE_LABEL[k], chf: tagesansatz(f.monatsmiete_chf, k)! }))
    .filter((t) => t.chf > 0);

  return {
    tage_pro_jahr: tage,
    ort_chf_pro_jahr: jahr,
    ort_chf_pro_tag: Math.round(jahr / tage),
    tarife,
    grundlage:
      `${tage} Veranstaltungstage pro Jahr, Tagesmietwert aus ${chf(f.monatsmiete_chf!)} CHF ` +
      `Monatsmiete geteilt durch ${ANNAHMEN.tage_pro_monat}.`,
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
/**
 * Bewertung nach den fuenf Kriterien des Akquise-Auftrags, je 1–5:
 *
 *   Raumpotenzial 20 % · freie Zeitfenster 20 % · Bedarf an Entlastung
 *   25 % · Passung zum Modell 20 % · Erreichbarkeit der Entscheider 15 %
 *
 * Der Entlastungsbedarf wiegt am schwersten — er entscheidet, ob eine
 * Zusammenarbeit dem Haus ueberhaupt etwas abnimmt. Priorität A ab 3.8,
 * B ab 3.0.
 *
 * `score` bleibt die 0–100-Achse der Datenbank (Gesamtwert × 20), damit
 * Sortierung und Anzeige unveraendert funktionieren.
 */
export function bewerte(f: Faktoren): Bewertung {
  const { modell, alternativen } = waehleModell(f);

  /** 1–5 aus einem Ja/Nein/Unklar: ja = 1, unklar = 3, nein = 5. */
  const fehltPunkte = (d: Dreiwertig) => (d === "ja" ? 1 : d === "unklar" ? 3 : 5);

  // Raumpotenzial: Kapazitaet, auf 500 Plaetze als Vollwert normiert.
  const kap = f.kapazitaet;
  const raumpotenzial = kap === null
    ? 2 // unbekannt: nicht ausschliessen, aber nicht belohnen
    : Math.max(1, Math.min(5, Math.round((kap / 500) * 4) + 1));

  // Freie Zeitfenster: die Grundbedingung fuer Modell A.
  const zeitfenster = f.zeitfenster_frei === "ja" ? 5 : f.zeitfenster_frei === "unklar" ? 3 : 1;

  // Entlastungsbedarf: was dem Haus an Betrieb, Vermarktung und Technik
  // fehlt — der Mittelwert der drei.
  const entlastungsbedarf = Math.round(
    (fehltPunkte(f.personal_vor_ort) + fehltPunkte(f.eigene_vermarktung) +
     fehltPunkte(f.technik_vorhanden)) / 3,
  );

  // Modellpassung: wie klar das gewaehlte Modell greift.
  const modellpassung = modell === "keins" ? 1
    : modell === "betriebspartner" ? 5
    : modell === "servicepartner" ? 4
    : 3;

  // Erreichbarkeit: wie gut man an die Entscheider herankommt.
  const erreichbarkeitTabelle: Record<EigentuemerTyp, number> = {
    immobilien: 5,   // Eigentuemer mit Flaeche, rechnet in Auslastung
    corporate: 4,    // Budget da, kurze Wege
    gastro: 3,       // Personal da, Technik fehlt oft
    kultur: 3,       // kleines Gremium, aber knappes Budget
    oeffentlich: 1,  // laeuft ueber Ausschreibung, nicht ueber Akquise
    unbekannt: 2,
  };
  const erreichbarkeit = erreichbarkeitTabelle[f.eigentuemer_typ];

  const gesamtRoh =
    raumpotenzial * 0.20 + zeitfenster * 0.20 + entlastungsbedarf * 0.25 +
    modellpassung * 0.20 + erreichbarkeit * 0.15;
  const gesamt = modell === "keins" ? 0 : Math.round(gesamtRoh * 10) / 10;
  const prioritaet: "A" | "B" | "C" = gesamt >= 3.8 ? "A" : gesamt >= 3.0 ? "B" : "C";

  const annahmen: string[] = [];
  if (f.flaeche === "unklar") annahmen.push("Unklar, ob die Fläche überhaupt vermietet wird.");
  if (f.zeitfenster_frei === "unklar") annahmen.push("Freie Zeitfenster nicht belegt — im Gespräch zu klären.");
  if (kap === null) annahmen.push("Kapazität unbekannt — Raumpotenzial mit 2 von 5 gewertet.");
  if (f.monatsmiete_chf === null) {
    annahmen.push("Monatsmiete unbekannt — ohne sie sind keine Tagesansätze rechenbar.");
  }
  if (f.eigene_vermarktung === "unklar") annahmen.push("Eigene Vermarktung unklar — als Bedarf gewertet.");
  if (f.personal_vor_ort === "unklar") annahmen.push("Personal vor Ort unklar — als Bedarf gewertet.");
  if (f.technik_vorhanden === "unklar") annahmen.push("Technik unklar — als Bedarf gewertet.");
  if (f.eigentuemer_typ === "oeffentlich") {
    annahmen.push("Öffentliche Hand — läuft über Ausschreibung, nicht über Akquise.");
  }

  const modellLabel = KOOPERATIONS_MODELLE.find((m) => m.key === modell)?.label ?? modell;
  const begruendung = f.flaeche === "eigennutzung"
    ? "Nutzt die Fläche selbst und vermietet sie nicht — kein Ansatz."
    : modell === "keins"
      ? "Vermarktung, Betrieb und Technik sind abgedeckt — kein Einstieg erkennbar."
      : `${modellLabel} · Priorität ${prioritaet} (${gesamt.toFixed(1)} von 5). ` +
        (modell === "betriebspartner"
          ? "Zeitfenster stehen leer und der Betrieb bindet eigene Leute."
          : modell === "servicepartner"
            ? "Das Haus vermietet selbst, aber Technik oder Betreuung fehlen."
            : "Das Haus ist ausgelastet und besetzt — Ansatz über einzelne Abende.");

  return {
    modell,
    rentabilitaet_chf: ortAnteilProJahr(modell, f) ?? 0,
    score: Math.round(gesamt * 20),
    gesamt,
    prioritaet,
    begruendung,
    teilscores: { raumpotenzial, zeitfenster, entlastungsbedarf, modellpassung, erreichbarkeit },
    annahmen,
    alternativen,
  };
}
