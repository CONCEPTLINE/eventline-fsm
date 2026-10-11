/**
 * Kandidaten-Suche ueber das Netz statt ueber OpenStreetMap.
 *
 * Warum der Wechsel: OSM kennt Clubs, Tanzschulen und Hotels ohne Saal,
 * aber nicht die Halle, die tatsaechlich vermietet wird. Von 41 Treffern
 * aus OSM hatten 19 nicht einmal eine Website. Locations, die ihre Raeume
 * vermieten, WOLLEN dagegen gefunden werden — sie stehen auf der eigenen
 * Seite, in Portalen wie eventlokale.ch, in Listen der Stadt.
 *
 * Deshalb sucht hier das Modell mit echter Websuche und liefert Namen
 * samt Website. Erfundene Adressen koennen so nicht entstehen: jede URL
 * wird danach abgerufen, und was nicht antwortet, fliegt raus.
 */

import Anthropic from "@anthropic-ai/sdk";
import { KiFehler, mitWiederholung } from "@/lib/akquise-ki";

const MODELL = "claude-opus-5-5";

const SUCH_PROMPT = `Du suchst für die EVENTLINE GmbH (Basel) Locations, die ihre Räume an Dritte VERMIETEN.

EVENTLINE übernimmt für solche Häuser den Betrieb: Vermarktung, Buchung, Betreuung am Anlass, Technik. Der Kunde ist also ein Haus, das vermietet (oder vermieten will), den Betrieb aber nicht selbst stemmen mag.

GESUCHT:
- Säle, Mehrzweckhallen, Eventlocations, umgenutzte Industrie- und Gewerbeflächen
- Gemeinde-, Quartier- und Vereinssäle, Kirchgemeindehäuser
- Häuser von Stiftungen, Bürgergemeinden, Immobilienverwaltungen und Firmen, die Räume vermieten
- Hotels und Restaurants NUR, wenn sie einen eigenen Saal oder Banketträume vermieten

AUSGESCHLOSSEN — nie aufnehmen:
- **Kirchliche Liegenschaften**: Kirchen, Kapellen, Kirchgemeindehäuser, Pfarreizentren, Räume von Kirchgemeinden oder Pfarreien. Auch dann nicht, wenn sie aktiv vermieten.

NICHT GESUCHT — das sind keine Kunden:
- Clubs, Bars und Theater mit eigenem Programm, die ihre Fläche selbst bespielen
- Tanzschulen, Fitnessstudios, Kinos, Museen ohne Vermietung
- Restaurants ohne Saal, Apartmenthotels ohne Veranstaltungsraum
- Reine Seminarraum-Anbieter in Bürohäusern (Coworking)

VORGEHEN:
Suche mehrfach und unterschiedlich — etwa nach "Saal mieten <Ort>", "Eventlocation <Ort> mieten", "Räume vermieten <Ort> Veranstaltung", "Mehrzweckhalle <Ort> Vermietung", und schau in Portale wie eventlokale.ch. Nimm auch kleinere, unbekannte Häuser mit; gerade die haben oft keinen eigenen Betrieb.

FÜR JEDE LOCATION:
- name: wie das Haus heisst
- website: vollständige URL der EIGENEN Website, wenn du sie in den Suchergebnissen siehst. Findest du nur einen Portaleintrag, gib dessen URL. Hast du gar keine, gib null — rate keine Adresse.
- ort: Gemeinde/Stadt
- strasse: Strasse und Nummer, wenn sie in den Ergebnissen steht, sonst null
- typ: kurz, was es ist ("Mehrzwecksaal", "Industriehalle", "Kirchgemeindehaus", "Bankettsaal")
- warum: EIN Satz, woran du siehst, dass dort vermietet wird — aus dem Suchergebnis, nicht aus Annahme

REGELN:
- Nur was du in den Suchergebnissen wirklich siehst. Keine erfundenen Adressen, keine geratenen URLs, keine Häuser aus dem Gedächtnis ohne Beleg.
- Lieber zwölf belegte Treffer als dreissig behauptete.
- Keine Dubletten.`;

export interface WebKandidat {
  name: string;
  website: string | null;
  ort: string;
  strasse: string | null;
  typ: string;
  warum: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          website: { type: ["string", "null"] },
          ort: { type: "string" },
          strasse: { type: ["string", "null"] },
          typ: { type: "string" },
          warum: { type: "string" },
        },
        required: ["name", "website", "ort", "strasse", "typ", "warum"],
        additionalProperties: false,
      },
    },
  },
  required: ["locations"],
  additionalProperties: false,
} as const;

/**
 * Sucht Vermietungs-Locations in einem Gebiet.
 *
 * Zwei Schritte, weil Websuche und erzwungenes JSON-Format sich nicht
 * kombinieren lassen: erst recherchiert das Modell mit der Suche frei,
 * dann bringt ein zweiter Aufruf das Ergebnis in die feste Form.
 */
export async function sucheImNetz(gebiet: string, anzahl = 25): Promise<WebKandidat[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new KiFehler("ANTHROPIC_API_KEY ist nicht gesetzt");
  }
  const client = new Anthropic();

  let recherche;
  try {
    recherche = await mitWiederholung(() => client.messages.create({
      model: MODELL,
      max_tokens: 16000,
      system: SUCH_PROMPT,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 12 } as never],
      messages: [{
        role: "user",
        content: `Finde bis zu ${anzahl} Locations in ${gebiet}, die ihre Räume vermieten. ` +
          `Suche gründlich und nenne zu jeder, woran du die Vermietung erkennst.`,
      }],
    }));
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status === 400 && /credit balance/i.test(e.message)) {
      throw new KiFehler("Das Anthropic-Guthaben ist aufgebraucht.");
    }
    throw new KiFehler("Websuche fehlgeschlagen.");
  }

  if (recherche.stop_reason === "refusal") {
    throw new KiFehler("Die Websuche wurde abgelehnt.");
  }

  const roh = recherche.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  if (!roh) return [];

  // Zweiter Aufruf: dasselbe Material, aber in die feste Form gebracht.
  const { jsonSchemaOutputFormat } = await import("@anthropic-ai/sdk/helpers/json-schema");
  const strukturiert = await mitWiederholung(() => client.messages.parse({
    model: MODELL,
    max_tokens: 16000,
    system:
      "Bringe die folgende Recherche in die vorgegebene Form. Übernimm NUR Locations, die " +
      "im Text stehen, mit genau den dort genannten Angaben. Erfinde nichts, ergänze nichts " +
      "aus eigenem Wissen, lass Unbekanntes null. Keine Dubletten.",
    output_config: { format: jsonSchemaOutputFormat(SCHEMA) },
    messages: [{ role: "user", content: roh }],
  }));

  const out = strukturiert.parsed_output as { locations: WebKandidat[] } | null;
  return out?.locations ?? [];
}

/**
 * Prueft, ob die genannten Websites wirklich antworten. Was nicht
 * erreichbar ist, verliert die URL — damit steht in der Datenbank keine
 * Adresse, die niemand oeffnen kann.
 */
export async function pruefeWebsites(kandidaten: WebKandidat[]): Promise<WebKandidat[]> {
  const geprueft = await Promise.all(kandidaten.map(async (k) => {
    if (!k.website) return k;
    try {
      const r = await fetch(k.website, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; EventlineFSM/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      return r.ok ? { ...k, website: r.url } : { ...k, website: null };
    } catch {
      return { ...k, website: null };
    }
  }));
  return geprueft;
}
