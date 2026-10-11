/**
 * Website-Anreicherung: holt Ansprechperson und Kontakt aus der eigenen
 * Website einer Location.
 *
 * Warum nicht raten: Ein erfundener Name macht einen Lead unbrauchbar —
 * schlimmer noch, jemand schreibt ihn an. Deshalb wird hier wirklich die
 * Seite gelesen, und `quelle` haelt fest, welche. Findet sich nichts,
 * bleiben die Felder leer; das ist ein ehrliches Ergebnis.
 *
 * Nur server-seitig (fremde Hosts, eigener User-Agent).
 */

const UA = "Mozilla/5.0 (compatible; EventlineFSM/1.0; +https://www.eventline-basel.com)";
const ZEIT_MS = 15000;
/**
 * Zeichen je Seite. 6000 statt 9000: der Rest einer Seite ist fast immer
 * Navigation, Cookie-Hinweis und Fusszeile — Text, der Geld kostet und
 * nichts beitraegt. Kontakt, Raeume und Team stehen weiter oben.
 */
const MAX_ZEICHEN = 6000;
/** So viele Unterseiten zusaetzlich zur Startseite. */
const MAX_UNTERSEITEN = 4;

/**
 * Unterseiten nach Wert geordnet — gelesen wird in dieser Reihenfolge,
 * damit bei knappem Budget die ergiebigsten Seiten drin sind.
 *
 * Reihenfolge begruendet: Vermietung sagt, OB und WAS vermietet wird;
 * Raeume sagen, wie gross; Team sagt, wie besetzt das Haus ist (der
 * Punkt, an dem sich entscheidet, ob EVENTLINE hineinkommt); Kontakt
 * und Impressum liefern Person und Rechtsform; Preise runden ab.
 */
const SEITEN_MUSTER: { re: RegExp; zweck: string }[] = [
  { re: /(vermiet|mietangebot|miete|raumvermietung|location|saalmiete)/i, zweck: "Vermietung" },
  { re: /(raeume|räume|raum|saal|saele|säle|infrastruktur|ausstattung)/i, zweck: "Räume" },
  { re: /(team|ueber-uns|über-uns|about|wir|organisation|vorstand)/i, zweck: "Team" },
  { re: /(kontakt|contact)/i, zweck: "Kontakt" },
  { re: /(impressum|rechtlich|legal)/i, zweck: "Impressum" },
  { re: /(preis|tarif|konditionen|kosten)/i, zweck: "Preise" },
  { re: /(technik|ton|licht|buehne|bühne)/i, zweck: "Technik" },
  { re: /(referenz|veranstaltung|events|programm|agenda)/i, zweck: "Veranstaltungen" },
];

export interface SeitenText {
  url: string;
  /** Wofuer die Seite steht ("Vermietung", "Team", …) — hilft der
   *  Auswertung, Angaben richtig einzuordnen. */
  zweck: string;
  text: string;
}

function entferneMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // Navigation, Kopf- und Fusszeile tragen nichts bei und machen bei
    // vielen Seiten den groesseren Teil des Textes aus.
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    // Wiederholte Platzhalter und Leerzeichenwüsten zusammenziehen.
    .replace(/\s+/g, " ")
    .trim();
}

async function holeSeite(url: string): Promise<{ html: string; url: string } | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(ZEIT_MS),
    });
    if (!r.ok) return null;
    const typ = r.headers.get("content-type") ?? "";
    if (!typ.includes("html")) return null;
    return { html: await r.text(), url: r.url };
  } catch {
    // Fremde Websites fallen staendig aus — das ist kein Fehler des
    // Vorgangs, nur eine Location ohne belegbaren Kontakt.
    return null;
  }
}

/**
 * Liest Start- und die vielversprechendste Unterseite (Kontakt/Impressum/
 * Vermietung) und gibt deren Text zurueck.
 */
export async function leseWebsite(website: string): Promise<SeitenText[]> {
  const start = await holeSeite(website);
  if (!start) return [];

  const seiten: SeitenText[] = [
    { url: start.url, zweck: "Startseite", text: entferneMarkup(start.html).slice(0, MAX_ZEICHEN) },
  ];

  const host = new URL(start.url).host;
  const hrefs = [...start.html.matchAll(/href="([^"#]+)"/gi)].map((m) => m[1]);

  // Je Zweck die erste passende Seite — so kommt breit gestreutes
  // Material zusammen statt fuenfmal dieselbe Rubrik.
  const ziele: { url: string; zweck: string }[] = [];
  const gesehen = new Set([start.url]);
  for (const muster of SEITEN_MUSTER) {
    if (ziele.length >= MAX_UNTERSEITEN) break;
    for (const h of hrefs) {
      if (!muster.re.test(h)) continue;
      let absolut: string;
      try { absolut = new URL(h, start.url).toString(); } catch { continue; }
      // Nur innerhalb derselben Website bleiben, keine Dateien.
      if (new URL(absolut).host !== host) continue;
      if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?)$/i.test(absolut)) continue;
      if (gesehen.has(absolut)) continue;
      gesehen.add(absolut);
      ziele.push({ url: absolut, zweck: muster.zweck });
      break;
    }
  }

  for (const z of ziele) {
    const s = await holeSeite(z.url);
    if (s) seiten.push({ url: s.url, zweck: z.zweck, text: entferneMarkup(s.html).slice(0, MAX_ZEICHEN) });
  }
  return seiten;
}
