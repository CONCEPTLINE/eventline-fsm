/**
 * Overpass/OpenStreetMap — Kandidaten-Suche fuer die Location-Akquise.
 *
 * Liefert die FAKTEN (Name, Adresse, Koordinaten, Typ, Kapazitaet, Kontakt)
 * aus echten OSM-Daten. Die EVENTLINE-Einordnung passiert nicht hier,
 * sondern in `akquise-faktoren.ts` bzw. der KI-Bewertung — so kann keine
 * erfundene Adresse in die Datenbank gelangen.
 *
 * Nur server-seitig (wie `geocode.ts`): Overpass hat harte Rate-Limits und
 * verlangt einen User-Agent; vom Client aus wuerde jeder Browser einzeln
 * fragen und die oeffentliche Instanz belasten.
 */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "Eventline-FSM/1.0 (leo@eventline-basel.com)";
/** Overpass-eigener Timeout in Sekunden; unser fetch bricht spaeter ab. */
const QUERY_TIMEOUT_S = 50;

/**
 * OSM-Tags, hinter denen in der Schweiz Event-Locations stecken, mit der
 * Abbildung auf unseren `typ`. Bewusst breit: ein Kandidat zu viel kostet
 * einen Blick, ein uebersehener kostet einen Auftrag. Reine Gastronomie
 * und Hotels ohne Saal sind NICHT dabei — die taeuschen sonst die
 * Trefferliste zu.
 */
// `leisure=dance` ist bewusst NICHT dabei: das sind in der Schweiz fast
// immer Tanzschulen und Tanzlokale, die ihre Saele selbst bespielen —
// sie standen in der ersten Fassung ganz oben in der Trefferliste und
// waren durchweg Fehltreffer.
const GESUCHTE_TAGS: { tag: string; wert: string; typ: string }[] = [
  { tag: "amenity", wert: "events_venue",      typ: "Eventlocation" },
  { tag: "amenity", wert: "conference_centre", typ: "Kongresszentrum" },
  { tag: "amenity", wert: "exhibition_centre", typ: "Messehalle" },
  { tag: "amenity", wert: "theatre",           typ: "Theater" },
  { tag: "amenity", wert: "arts_centre",       typ: "Kulturzentrum" },
  { tag: "amenity", wert: "community_centre",  typ: "Gemeinschaftszentrum" },
  { tag: "amenity", wert: "nightclub",         typ: "Club" },
  { tag: "leisure", wert: "hall",              typ: "Saal" },
  { tag: "leisure", wert: "sports_hall",       typ: "Sporthalle" },
  // Corporate-Schiene: Hotels und Gasthoefe betreiben das Bankett- und
  // Seminargeschaeft, haben Personal, aber meist keine Veranstaltungs-
  // technik — klassische Technikpartner-Kandidaten. OSM taggt den Saal
  // selbst selten, darum ueber das Haus suchen.
  { tag: "tourism", wert: "hotel",             typ: "Hotel" },
  { tag: "amenity", wert: "function_room",     typ: "Banketsaal" },
];

export interface OsmKandidat {
  /** "node/123" | "way/456" | "relation/789" — stabiler Dedupe-Schluessel. */
  osm_id: string;
  name: string;
  typ: string;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  email: string | null;
  telefon: string | null;
  kapazitaet: number | null;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Anfuehrungszeichen und Backslashes raus — Overpass QL hat kein Binding. */
function fuerQl(s: string): string {
  return s.replace(/["\\]/g, "").trim();
}

/**
 * Baut die Overpass-Query. `admin_level` 4 = Kanton, 6 = Bezirk, 8 =
 * Gemeinde — alle drei zulassen, damit sowohl "Basel-Landschaft" als auch
 * "Liestal" als Gebiet gefunden werden.
 */
function baueQuery(gebiet: string): string {
  const g = fuerQl(gebiet);
  const zeilen = GESUCHTE_TAGS
    .map((t) => `  nwr["${t.tag}"="${t.wert}"](area.suchgebiet);`)
    .join("\n");
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];
area["name"="${g}"]["admin_level"~"^(4|6|8)$"]->.suchgebiet;
(
${zeilen}
);
out center tags;`;
}

function zahlOderNull(s: string | undefined): number | null {
  if (!s) return null;
  // OSM-Werte sind Freitext ("ca. 200", "200 Personen") — erste Zahl nehmen.
  const m = s.match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nachKandidat(el: OverpassElement): OsmKandidat | null {
  const t = el.tags ?? {};
  const name = (t.name ?? "").trim();
  // Ohne Namen ist der Eintrag fuer die Akquise wertlos — niemand kann
  // einen unbenannten Punkt anschreiben.
  if (!name) return null;

  const treffer = GESUCHTE_TAGS.find((g) => t[g.tag] === g.wert);

  const hausnr = t["addr:housenumber"];
  const strasse = t["addr:street"]
    ? `${t["addr:street"]}${hausnr ? ` ${hausnr}` : ""}`
    : null;

  return {
    osm_id: `${el.type}/${el.id}`,
    name,
    typ: treffer?.typ ?? "Location",
    strasse,
    plz: t["addr:postcode"] ?? null,
    ort: t["addr:city"] ?? null,
    lat: el.lat ?? el.center?.lat ?? null,
    lng: el.lon ?? el.center?.lon ?? null,
    website: t.website ?? t["contact:website"] ?? null,
    email: t.email ?? t["contact:email"] ?? null,
    telefon: t.phone ?? t["contact:phone"] ?? null,
    kapazitaet: zahlOderNull(t.capacity ?? t.seats ?? t["capacity:persons"]),
  };
}

export class OverpassFehler extends Error {}

/**
 * Sucht Event-Locations in einem Gebiet (Stadt, Gemeinde oder Kanton).
 * Der Gebietsname muss so geschrieben sein wie in OSM ("Basel",
 * "Basel-Landschaft", "Zürich") — Umlaute inklusive.
 */
export async function sucheLocations(gebiet: string): Promise<OsmKandidat[]> {
  if (!gebiet.trim()) throw new OverpassFehler("Kein Gebiet angegeben");

  // Die oeffentliche Overpass-Instanz ist regelmaessig kurz ueberlastet
  // (429/504). Einmal warten und erneut fragen loest das fast immer —
  // ohne das scheitert jede zweite Suche fuer den Nutzer sichtbar.
  let letzterFehler: OverpassFehler | null = null;
  for (let versuch = 0; versuch < 3; versuch++) {
    if (versuch > 0) await new Promise((r) => setTimeout(r, versuch * 8000));
    try {
      return await einVersuch(gebiet);
    } catch (e) {
      if (!(e instanceof OverpassUeberlastet)) throw e;
      letzterFehler = e;
    }
  }
  throw letzterFehler ?? new OverpassFehler("OpenStreetMap ist nicht erreichbar.");
}

/** Signalisiert, dass ein erneuter Versuch sinnvoll ist. */
class OverpassUeberlastet extends OverpassFehler {}

async function einVersuch(gebiet: string): Promise<OsmKandidat[]> {
  let res: Response;
  try {
    res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
      body: baueQuery(gebiet),
      // Overpass selbst bricht bei QUERY_TIMEOUT_S ab; etwas Luft dazu,
      // damit wir dessen Fehlermeldung noch lesen statt selbst abzubrechen.
      signal: AbortSignal.timeout((QUERY_TIMEOUT_S + 15) * 1000),
    });
  } catch (e) {
    // Zeitüberschreitung heisst meist: Instanz ist gerade voll → erneut.
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new OverpassUeberlastet("OpenStreetMap antwortet nicht (Zeitüberschreitung).");
    }
    throw new OverpassFehler("OpenStreetMap ist nicht erreichbar.");
  }

  if (res.status === 429 || res.status === 504) {
    throw new OverpassUeberlastet("OpenStreetMap ist überlastet — in einer Minute erneut versuchen.");
  }
  if (!res.ok) {
    throw new OverpassFehler(`OpenStreetMap antwortete mit ${res.status}.`);
  }

  const json = (await res.json()) as { elements?: OverpassElement[] };
  const elemente = json.elements ?? [];

  const kandidaten: OsmKandidat[] = [];
  const gesehen = new Set<string>();
  for (const el of elemente) {
    const k = nachKandidat(el);
    // Dieselbe Location steckt in OSM oft doppelt (Gebaeude-way +
    // Punkt-node); nach Name+Ort entdoppeln, nicht nur nach osm_id.
    if (!k) continue;
    const schluessel = `${k.name.toLowerCase()}|${(k.ort ?? "").toLowerCase()}`;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    kandidaten.push(k);
  }
  return kandidaten;
}
