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
/** Pro Seite reicht der Anfang — Kontaktangaben stehen oben oder im Fuss. */
const MAX_ZEICHEN = 6000;

/** Unterseiten, auf denen Kontaktangaben typischerweise stehen. */
const INTERESSANT = /(kontakt|impressum|vermiet|miete|mietangebot|raeume|räume|about|ueber-uns|über-uns|team)/i;

export interface SeitenText {
  url: string;
  text: string;
}

function entferneMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
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
    { url: start.url, text: entferneMarkup(start.html).slice(0, MAX_ZEICHEN) },
  ];

  // Bis zu zwei Unterseiten dazu — mehr bringt selten Neues und kostet Zeit.
  const hrefs = [...start.html.matchAll(/href="([^"#]+)"/gi)]
    .map((m) => m[1])
    .filter((h) => INTERESSANT.test(h));
  const ziele: string[] = [];
  for (const h of hrefs) {
    let absolut: string;
    try {
      absolut = new URL(h, start.url).toString();
    } catch { continue; }
    // Nur innerhalb derselben Website bleiben.
    if (new URL(absolut).host !== new URL(start.url).host) continue;
    if (absolut === start.url || ziele.includes(absolut)) continue;
    ziele.push(absolut);
    if (ziele.length === 2) break;
  }

  for (const z of ziele) {
    const s = await holeSeite(z);
    if (s) seiten.push({ url: s.url, text: entferneMarkup(s.html).slice(0, MAX_ZEICHEN) });
  }
  return seiten;
}
