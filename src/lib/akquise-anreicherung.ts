/**
 * Website-Recherche: liest die Website einer Location und zieht daraus
 * Ansprechpartner, Besetzung (Team, Technikpartner, Rechtsform) und das
 * Angebot (Raeume, Ausstattung, Preise).
 *
 * Liegt als Lib, damit sie sich ohne HTTP-Route pruefen laesst und die
 * Route duenn bleibt — gleiches Muster wie akquise-bewertung.ts.
 *
 * Grundregel des Prompts: nichts erfinden. Ein geratener Ansprechpartner
 * waere schlimmer als keiner, weil ihn jemand anschreiben wuerde.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { leseWebsite, type SeitenText } from "@/lib/akquise-website";
import { geocodeAddress } from "@/lib/geocode";
import { frageKi, KiFehler, AKQUISE_MODELL } from "@/lib/akquise-ki";
import { bewerte, type EigentuemerTyp, type FlaechenArt } from "@/lib/akquise-faktoren";

export const ANREICHERN_PROMPT = `Du liest den Text einer Location-Website und ziehst daraus die Angaben, die die EVENTLINE GmbH für einen Erstkontakt braucht.

STRENGSTE REGEL: Übernimm NUR, was wörtlich im Text steht. Erfinde keinen Namen, keine E-Mail-Adresse, keine Telefonnummer, keine Funktion. Steht nichts da, gib null zurück — ein leeres Feld ist richtig, ein geratener Name macht den Kontakt unbrauchbar und blamiert den Absender.

Gib zurück:
- ansprechperson: Vor- und Nachname der Person, die für Raumvermietung, Betrieb oder Geschäftsführung zuständig ist. Stehen mehrere, nimm die für Vermietung/Betrieb zuständige; sonst die Geschäftsführung. Nur wenn ein Name dasteht, sonst null.
- position: Funktion dieser Person, wörtlich wie angegeben (z. B. "Geschäftsführerin", "Leiter Vermietung", "Betriebsleitung"). Sonst null.
- email: die für Anfragen oder Vermietung passende Adresse. Mehrere → die allgemeinste für Anfragen (info@, kontakt@, vermietung@). Nur wörtlich übernehmen, sonst null.
- telefon: Telefonnummer in der Schreibweise der Seite. Nur wörtlich, sonst null.
- vermietet_raeume: Sagt der Text, dass Räume an Dritte vermietet werden? "ja" wenn es dort steht (Mietangebot, Raumvermietung, "Räume mieten", Preisliste), "nein" wenn der Text klar macht, dass nur selbst genutzt wird, sonst "unklar".
- vermietung_hinweis: EIN kurzer Satz, was die Seite über die Vermietung sagt — welche Räume, an wen, wie gebucht. Nichts gefunden → null.
- eignung: "hoch" wenn die Seite zeigt, dass vermietet wird und der Betrieb dünn aussieht (kein Team genannt, Anfragen laufen über ein allgemeines Postfach, keine Technikangaben); "mittel" wenn vermietet wird, aber ein Team oder Angebot erkennbar ist; "gering" wenn die Seite zeigt, dass Vermarktung, Betreuung und Technik abgedeckt sind oder gar nicht vermietet wird.
- eignung_grund: EIN Satz, warum. Beziehe dich auf das, was auf der Seite steht.

WIE BESETZT IST DAS HAUS? — das entscheidet, ob EVENTLINE überhaupt hineinkommt:
- techniker_im_team: Wie viele eigene Techniker nennt die Seite (Team-, Über-uns- oder Kontaktseite)? Zähle Personen mit Technik-, Ton-, Licht-, Bühnen- oder Hausdienst-Funktion. Nennt die Seite ausdrücklich keine, gib 0. Sagt sie nichts dazu, gib null. Rate keine Zahl.
- technikpartner: Nennt die Seite einen festen externen Technikpartner (Firma für Licht/Ton/Veranstaltungstechnik, "unser Partner", Logo-Leiste, "Technik durch …")? "ja" / "nein" wenn die Seite ausdrücklich sagt, dass Technik mitgebracht werden muss / sonst "unklar".
- technikpartner_name: Name dieser Firma, wörtlich wie genannt. Sonst null.
- team_beschreibung: EIN Satz, wie das Team aussieht — wie viele Personen, welche Rollen, oder dass die Seite gar kein Team nennt (das ist eine wichtige Aussage).
- geschaeftsstruktur: Rechtsform oder Trägerschaft, wie die Seite oder das Impressum sie angibt: Verein, Stiftung, GmbH, AG, Genossenschaft, Einzelfirma, öffentliche Hand, Zwischennutzung. Wörtlich übernehmen, sonst null.

DAS DOSSIER — alles, was ein Erstgespräch vorbereitet:
- raeume: Jeder vermietbare Raum, den die Seite nennt, mit name, kapazitaet (Personen, null wenn nicht genannt), flaeche_m2 (null wenn nicht genannt) und eignung (wofür er sich laut Seite eignet). Nennt die Seite keine einzelnen Räume, gib eine leere Liste.
- infrastruktur: Was an Ausstattung dasteht — Küche, Bar, Bühne, Garderobe, Parkplätze, Barrierefreiheit, Beamer, WLAN, Aufzug, Aussenfläche. Nur Genanntes.
- preis_hinweis: Was die Seite über Preise sagt, wörtlich verdichtet ("ab 800 CHF/Tag", "auf Anfrage"). Sonst null.
- preise_oeffentlich: true, wenn konkrete Zahlen dastehen; false, wenn es "auf Anfrage" heisst oder nichts steht.
- veranstaltungstypen: Was dort laut Seite stattfindet — Konzerte, Firmenanlässe, Hochzeiten, Seminare, Generalversammlungen, Ausstellungen.
- betrieb_seit: Jahr, seit wann das Haus besteht oder bespielt wird, falls genannt. Sonst null.
- besonderheiten: EIN Satz zu dem, was dieses Haus ausmacht und was im Gespräch nützlich ist — Lage, Geschichte, Zwischennutzung, Umnutzung, auslaufender Mietvertrag, Umbau.

DIE DREI BEWERTUNGSFAKTOREN — leite sie aus dem ab, was du auf der Seite siehst. Hier sollst du NICHT auf "unklar" ausweichen, wenn die Seite eine Antwort hergibt; die Seite ist die beste verfügbare Quelle:
- eigene_vermarktung: Vermarktet das Haus seine Räume selbst? "ja" wenn es eine Mietseite, ein Anfrageformular, eine Preisliste, einen Raumkatalog oder einen Belegungskalender gibt — das IST eigene Vermarktung. "nein" wenn Räume erwähnt werden, aber nirgends ein Weg zu mieten dasteht. "unklar" nur, wenn die Seite zur Vermietung gar nichts sagt.
- personal_vor_ort: Gibt es festes Betriebspersonal? "ja" wenn die Seite ein Team, eine Betriebsleitung, einen Hauswart, Mitarbeitende oder mehrere namentliche Personen nennt. "nein" wenn ausdrücklich nur ehrenamtlich, nur ein Vorstand ohne Betrieb, oder Anfragen ausschliesslich über ein allgemeines Postfach laufen und kein Team genannt wird. "unklar" nur, wenn die Seite zu Personen gar nichts sagt.
- eigentuemer_typ: Leite ihn aus Rechtsform und Auftritt ab — "kultur" (Verein, Stiftung, Kulturbetrieb), "gastro" (Hotel, Restaurant), "corporate" (GmbH, AG, Einzelfirma mit gewerblichem Betrieb), "immobilien" (Immobilienverwaltung, Liegenschaftseigentümer, Areal-Entwickler), "oeffentlich" (Stadt, Kanton, Gemeinde, Kirchgemeinde), "unbekannt" nur wenn nichts erkennbar ist.

Für diese drei gilt: begründe deine Wahl in faktoren_grund mit dem, was auf der Seite steht.
- zeitfenster_frei: Stehen Zeitfenster real leer? "ja" wenn die Seite auf freie Termine hindeutet (Belegungskalender mit Lücken, "jetzt anfragen", wenige Anlässe im Programm, Räume ausdrücklich zur Miete frei). "nein" wenn ein dichtes eigenes Programm läuft oder der Kalender voll wirkt. "unklar" sonst. Das ist wichtig: Nur wo Zeitfenster frei sind UND der Betrieb belastet ist, kommt das Modell «Betriebspartner» in Frage.
- faktoren_grund: EIN Satz, worauf du die Einstufungen stützt.

Sonst gilt weiter: nur was dasteht. Ein erfundenes Team oder ein geratener Preis macht die Einschätzung wertlos. Leere Liste und null sind richtige Antworten.`;

export const SCHEMA = {
  type: "object",
  properties: {
    ansprechperson: { type: ["string", "null"] },
    position: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    telefon: { type: ["string", "null"] },
    vermietet_raeume: { type: "string", enum: ["ja", "nein", "unklar"] },
    vermietung_hinweis: { type: ["string", "null"] },
    eignung: { type: "string", enum: ["hoch", "mittel", "gering"] },
    eignung_grund: { type: "string" },
    techniker_im_team: { type: ["integer", "null"] },
    technikpartner: { type: "string", enum: ["ja", "nein", "unklar"] },
    technikpartner_name: { type: ["string", "null"] },
    team_beschreibung: { type: ["string", "null"] },
    geschaeftsstruktur: { type: ["string", "null"] },
    raeume: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kapazitaet: { type: ["integer", "null"] },
          flaeche_m2: { type: ["integer", "null"] },
          eignung: { type: ["string", "null"] },
        },
        required: ["name", "kapazitaet", "flaeche_m2", "eignung"],
        additionalProperties: false,
      },
    },
    infrastruktur: { type: "array", items: { type: "string" } },
    preis_hinweis: { type: ["string", "null"] },
    preise_oeffentlich: { type: "boolean" },
    veranstaltungstypen: { type: "array", items: { type: "string" } },
    betrieb_seit: { type: ["string", "null"] },
    besonderheiten: { type: ["string", "null"] },
    eigene_vermarktung: { type: "string", enum: ["ja", "nein", "unklar"] },
    personal_vor_ort: { type: "string", enum: ["ja", "nein", "unklar"] },
    eigentuemer_typ: {
      type: "string",
      enum: ["corporate", "immobilien", "kultur", "oeffentlich", "gastro", "unbekannt"],
    },
    zeitfenster_frei: { type: "string", enum: ["ja", "nein", "unklar"] },
    faktoren_grund: { type: "string" },
  },
  required: ["ansprechperson", "position", "email", "telefon",
             "vermietet_raeume", "vermietung_hinweis", "eignung", "eignung_grund",
             "techniker_im_team", "technikpartner", "technikpartner_name",
             "team_beschreibung", "geschaeftsstruktur", "raeume", "infrastruktur",
             "preis_hinweis", "preise_oeffentlich", "veranstaltungstypen",
             "betrieb_seit", "besonderheiten", "eigene_vermarktung",
             "personal_vor_ort", "eigentuemer_typ", "zeitfenster_frei", "faktoren_grund"],
  additionalProperties: false,
} as const;

export interface WebBefund {
  ansprechperson: string | null;
  position: string | null;
  email: string | null;
  telefon: string | null;
  vermietet_raeume: "ja" | "nein" | "unklar";
  vermietung_hinweis: string | null;
  eignung: "hoch" | "mittel" | "gering";
  eignung_grund: string;
  techniker_im_team: number | null;
  technikpartner: "ja" | "nein" | "unklar";
  technikpartner_name: string | null;
  team_beschreibung: string | null;
  geschaeftsstruktur: string | null;
  raeume: { name: string; kapazitaet: number | null; flaeche_m2: number | null; eignung: string | null }[];
  infrastruktur: string[];
  preis_hinweis: string | null;
  preise_oeffentlich: boolean;
  veranstaltungstypen: string[];
  betrieb_seit: string | null;
  besonderheiten: string | null;
  eigene_vermarktung: "ja" | "nein" | "unklar";
  personal_vor_ort: "ja" | "nein" | "unklar";
  eigentuemer_typ: EigentuemerTyp;
  zeitfenster_frei: "ja" | "nein" | "unklar";
  faktoren_grund: string;
}

/** Liest eine Website und wertet sie aus. null = nichts zu holen. */
export async function rechercheFuer(
  name: string,
  ort: string,
  website: string,
): Promise<{ befund: WebBefund; seiten: SeitenText[] } | null> {
  const seiten = await leseWebsite(website);
  if (seiten.length === 0) return null;
  try {
    const befund = await frageKi<WebBefund>(
      ANREICHERN_PROMPT,
      `Location: ${name}, ${ort}\n\n` +
        seiten.map((s) => `--- ${s.zweck}: ${s.url} ---\n${s.text}`).join("\n\n"),
      SCHEMA,
    );
    return { befund, seiten };
  } catch (e) {
    if (e instanceof KiFehler) throw e;
    return null;
  }
}

/** Baut aus einem Befund das Update fuer `akquise_locations`. */
export function befundZuPatch(
  befund: WebBefund,
  seiten: SeitenText[],
  bisherigeFlaeche: string,
  /** Kapazitaet aus der Bewertung, falls die Website keine nennt. */
  bisherigeKapazitaet: number | null = null,
): Record<string, unknown> {
  // Die Website schlaegt die Schaetzung: sagt sie klar, dass vermietet
  // wird (oder eben nicht), korrigieren wir die Flaechenart.
  const flaeche: string =
    befund.vermietet_raeume === "ja" ? "vermietung"
    : befund.vermietet_raeume === "nein" ? "eigennutzung"
    : bisherigeFlaeche;

  // Eigenes Technikteam oder fester Partner heisst: die Technik ist
  // besetzt — das nimmt das Technikpartner-Modell aus dem Spiel.
  const technikBesetzt =
    (befund.techniker_im_team !== null && befund.techniker_im_team > 0) ||
    befund.technikpartner === "ja";

  // Nennt die Website konkrete Raumgroessen, sind die belastbarer als die
  // Schaetzung der Bewertung — groesster Raum zaehlt.
  const groesster = befund.raeume
    .map((r) => r.kapazitaet)
    .filter((k): k is number => typeof k === "number" && k > 0)
    .sort((x, y) => y - x)[0];
  const kapazitaet = groesster ?? bisherigeKapazitaet;

  /**
   * Die Faktoren kommen jetzt aus der Website, nicht mehr aus der
   * Schaetzung am OSM-Typ — die Seite weiss, ob es eine Mietseite gibt
   * und ob ein Team genannt wird. Damit wird auch die Bewertung neu
   * gerechnet: sonst stuenden belegte Faktoren neben einem Score, der
   * noch auf Vermutungen beruht.
   */
  const faktoren = {
    flaeche: flaeche as FlaechenArt,
    kapazitaet,
    zeitfenster_frei: befund.zeitfenster_frei,
    monatsmiete_chf: null, // aus der Website praktisch nie zu holen

    eigene_vermarktung: befund.eigene_vermarktung,
    personal_vor_ort: befund.personal_vor_ort,
    technik_vorhanden: technikBesetzt ? ("ja" as const) : befund.technikpartner === "nein" ? ("nein" as const) : ("unklar" as const),
    eigentuemer_typ: befund.eigentuemer_typ,
  };
  const neueBewertung = bewerte(faktoren);

  const patch: Record<string, unknown> = {
    ...faktoren,
    prioritaet: neueBewertung.prioritaet,
    empfohlenes_modell: neueBewertung.modell,
    rentabilitaet_chf: neueBewertung.rentabilitaet_chf,
    score: neueBewertung.score,
    bewertung: {
      begruendung: neueBewertung.begruendung,
      // Die Begruendung stammt jetzt aus der Website, nicht aus einer
      // Schaetzung — das steht auch so da.
      ki_einschaetzung: befund.faktoren_grund,
      teilscores: neueBewertung.teilscores,
      gesamt: neueBewertung.gesamt,
      prioritaet: neueBewertung.prioritaet,
      annahmen: neueBewertung.annahmen,
      alternativen: neueBewertung.alternativen,
      modell: AKQUISE_MODELL,
      quelle: "website",
      bewertet_am: new Date().toISOString(),
    },
    vermietung_hinweis: befund.vermietung_hinweis,
    techniker_im_team: befund.techniker_im_team,
    technikpartner: befund.technikpartner,
    technikpartner_name: befund.technikpartner_name,
    team_beschreibung: befund.team_beschreibung,
    geschaeftsstruktur: befund.geschaeftsstruktur,
    kontakt_quelle: seiten[0].url,
    angereichert_am: new Date().toISOString(),
    recherche: {
      raeume: befund.raeume,
      infrastruktur: befund.infrastruktur,
      preis_hinweis: befund.preis_hinweis,
      preise_oeffentlich: befund.preise_oeffentlich,
      veranstaltungstypen: befund.veranstaltungstypen,
      betrieb_seit: befund.betrieb_seit,
      besonderheiten: befund.besonderheiten,
      gelesene_seiten: seiten.map((s) => ({ url: s.url, zweck: s.zweck })),
    },
  };

  // Leere Felder nicht ueber vorhandene Werte schreiben.
  if (befund.ansprechperson) patch.ansprechperson = befund.ansprechperson;
  if (befund.position) patch.position = befund.position;
  if (befund.email) patch.email = befund.email;
  if (befund.telefon) patch.telefon = befund.telefon;

  return patch;
}

/**
 * Wie viele Websites gleichzeitig gelesen werden.
 *
 * Nacheinander braeuchte eine Stadt mit 20 Kandidaten rund zehn Minuten
 * und liefe in die Zeitgrenze der Route. Drei parallel ist der
 * Kompromiss: schnell genug, aber ohne das Rate-Limit der KI-API zu
 * treiben — bei fuenf kam die Suche regelmaessig als "ueberlastet"
 * zurueck, statt Treffer zu liefern.
 *
 * Die Tiefenrecherche (Presse, Finanzierung, Personal) laeuft bewusst
 * NICHT hier mit: sie braucht pro Haus acht Websuchen und haette den
 * Suchlauf auf eine knappe Stunde gedehnt. Sie wird nachgeladen, wenn
 * jemand eine Location oeffnet — dann fuer genau diese eine.
 */
const PARALLEL = 3;

/** Reichert die uebergebenen Kandidaten an und schreibt das Ergebnis. */
export async function reichereAn(
  supabase: SupabaseClient,
  kandidaten: { id: string; name: string; ort: string; website: string | null;
                flaeche: string; kapazitaet?: number | null;
                lat?: number | null; lng?: number | null;
                strasse?: string | null; plz?: string | null }[],
): Promise<{ angereichert: number; ohne_befund: number; ohne_website: string[] }> {
  let angereichert = 0, ohne_befund = 0;
  const ohne_website: string[] = [];

  async function einer(k: (typeof kandidaten)[number]) {
    if (!k.website) { ohne_website.push(k.name); return; }

    let r: Awaited<ReturnType<typeof rechercheFuer>>;
    try {
      r = await rechercheFuer(k.name, k.ort, k.website);
    } catch (e) {
      // Ein Ausfall darf nicht den ganzen Durchgang kippen — bei
      // fehlendem Guthaben bricht der Aufrufer ohnehin ab.
      if (e instanceof KiFehler && /Guthaben|Schlüssel/i.test(e.message)) throw e;
      ohne_befund++;
      return;
    }

    if (!r) {
      // Website nicht erreichbar: Versuch vermerken, damit der naechste
      // Lauf sie nicht endlos erneut probiert.
      await supabase.from("akquise_locations")
        .update({ angereichert_am: new Date().toISOString() }).eq("id", k.id);
      ohne_befund++;
      return;
    }

    const patch = befundZuPatch(r.befund, r.seiten, k.flaeche, k.kapazitaet ?? null);

    // Koordinaten fuer die Karte. Die Websuche liefert Adressen, aber
    // keine Punkte; Nominatim macht daraus einen. Scheitert das, bleibt
    // der Eintrag ohne Marker statt mit einem falschen.
    if (k.lat === null || k.lng === null) {
      const adresse = (patch.strasse as string | undefined) ?? k.strasse;
      const punkt = await geocodeAddress(adresse ?? null, k.plz ?? null, k.ort);
      if (punkt) { patch.lat = punkt.lat; patch.lng = punkt.lng; }
    }

    const { error } = await supabase
      .from("akquise_locations").update(patch).eq("id", k.id);
    if (!error) angereichert++;
  }

  for (let i = 0; i < kandidaten.length; i += PARALLEL) {
    await Promise.all(kandidaten.slice(i, i + PARALLEL).map(einer));
  }
  return { angereichert, ohne_befund, ohne_website };
}
