import "server-only";
import { unstable_cache } from "next/cache";
import { FLOW_FIRMA } from "@/lib/flow/ausweis";
import { TRUST_ONE_ABLAGE_BEREICH, TRUST_ONE_FRISTEN_LINK, TRUST_ONE_URL_STANDARD } from "@/lib/trust-one";

// Fristen-Zaehler der Ablage fuer Dashboard und Buero-Bildschirm. Die Ablage der EVENTLINE GmbH lebt seit 01.11.2026
// in Trust flow (vorher seit 24.10.2026 in Trust one); das ERP liest nur noch den Zaehler. Mail-Anhaenge leitet es nicht
// mehr weiter: ablage@in.eventline-basel.com meldet nur noch den Admins die neue Adresse ablage@in.trust-group.ch
// (api/inbound/mail).
// Schalter env ABLAGE_ZIEL = "trust-flow" | "trust-one" (Standard, auch leer/unbekannt) — ablageZiel():
//   trust-flow  POST {TRUST_FLOW_URL}/api/ablage/extern/fristen  Body {firma: "eventline", tage: 30}
//               → {offen, faellig, vorschlaege}; faellig (innert 30 Tagen) = aktiv, vorschlaege = vorschlag
//   trust-one   GET  {TRUST_ONE_URL}/api/ablage/extern/fristen?bereich=…&tage=30 (Rueckweg bis 15.11.2026; danach
//               faellt dieser Zweig samt Schalter weg)
// ablageFristenLink() folgt demselben Schalter (Dashboard-Kachel). TRUST_FLOW_URL / TRUST_ONE_URL optional (Standard
// https://flow.trust-group.ch bzw. https://one.trust-group.ch); Bearer TRUST_ONE_ABLAGE_TOKEN (= ABLAGE_EXTERN_TOKEN).
// Werte nie loggen.

/** Wartezeit auf die Fristen (Dashboard und Wand warten darauf). */
const FRISTEN_TIMEOUT_MS = 8_000;
/** Fristen-Zaehler kurz zwischenspeichern — Dashboard und Wand pollen, die Fristen aendern sich selten. */
const FRISTEN_CACHE_S = 300;
/** Fenster des Fristen-Zaehlers (Tage ab heute, Zuerich) — gleich in Trust one und Trust flow. */
const FRISTEN_TAGE = 30;

/** Basis-Adresse von Trust flow (env TRUST_FLOW_URL kann sie ueberschreiben). */
export const TRUST_FLOW_URL_STANDARD = "https://flow.trust-group.ch";

export type AblageZiel = "trust-one" | "trust-flow";

/** Wohin die Ablage-Aufrufe gehen: env ABLAGE_ZIEL; nur "trust-flow" schaltet um, alles andere = "trust-one". */
export function ablageZiel(): AblageZiel {
  return process.env.ABLAGE_ZIEL?.trim().toLowerCase() === "trust-flow" ? "trust-flow" : "trust-one";
}

const ZIEL_NAME: Record<AblageZiel, string> = { "trust-one": "Trust one", "trust-flow": "Trust flow" };

function basisUrl(ziel: AblageZiel): string {
  const roh = ziel === "trust-flow"
    ? process.env.TRUST_FLOW_URL?.trim() || TRUST_FLOW_URL_STANDARD
    : process.env.TRUST_ONE_URL?.trim() || TRUST_ONE_URL_STANDARD;
  return roh.replace(/\/+$/, "");
}

function token(): string | null {
  return process.env.TRUST_ONE_ABLAGE_TOKEN?.trim() || null;
}

// ---------------------------------------------------------------------------
// Fristen
// ---------------------------------------------------------------------------

/** Fristen der Ablage von Zuerich-heute bis +30 Tage. `aktiv` = bestaetigt, `vorschlag` = Vorschlag der lokalen KI,
 *  noch nicht entschieden. Das Dashboard zaehlt beide, der Buero-Bildschirm nur `aktiv`. Gleiche Form fuer beide
 *  Ziele (Trust flow: faellig → aktiv, vorschlaege → vorschlag; offen = alle offenen, hier nicht gebraucht). */
export interface TrustOneFristen {
  aktiv: number;
  vorschlag: number;
}

function anzahl(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null;
}

async function holeFristen(ziel: AblageZiel): Promise<TrustOneFristen> {
  const name = ZIEL_NAME[ziel];
  const t = token();
  if (!t) throw new Error(`Fristen: ${name} ist nicht verbunden (TRUST_ONE_ABLAGE_TOKEN fehlt)`);
  const gemeinsam = { cache: "no-store" as const, signal: AbortSignal.timeout(FRISTEN_TIMEOUT_MS) };
  let res: Response;
  try {
    res = ziel === "trust-flow"
      ? await fetch(`${basisUrl(ziel)}/api/ablage/extern/fristen`, {
          method: "POST",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: JSON.stringify({ firma: FLOW_FIRMA, tage: FRISTEN_TAGE }),
          ...gemeinsam,
        })
      : await fetch(`${basisUrl(ziel)}/api/ablage/extern/fristen?bereich=${TRUST_ONE_ABLAGE_BEREICH}&tage=${FRISTEN_TAGE}`, {
          headers: { Authorization: `Bearer ${t}` },
          ...gemeinsam,
        });
  } catch {
    throw new Error(`Fristen: ${name} ist nicht erreichbar`);
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const [aktiv, vorschlag, formOk] = ziel === "trust-flow"
    ? [anzahl(j?.faellig), anzahl(j?.vorschlaege), true]
    : [anzahl(j?.anzahl_aktiv), anzahl(j?.anzahl_vorschlag), j?.success === true];
  if (!res.ok || !formOk || aktiv === null || vorschlag === null) {
    throw new Error(`Fristen: ${name} antwortet nicht wie erwartet (HTTP ${res.status})`);
  }
  return { aktiv, vorschlag };
}

/** Je Ziel eigener Eintrag (das Argument gehoert zum Cache-Schluessel): Umschalten zeigt sofort das neue Ziel. */
const fristenZwischengespeichert = unstable_cache(holeFristen, ["ablage-fristen-30"], { revalidate: FRISTEN_CACHE_S });

/** Fristen-Zaehler der Ablage (Ziel laut ABLAGE_ZIEL), 5 min zwischengespeichert. Wirft bei jedem Fehler (§7: nie
 *  still als 0 anzeigen) — ein Fehler wird nicht zwischengespeichert, der naechste Aufruf fragt neu. */
export function ladeTrustOneFristen(): Promise<TrustOneFristen> {
  return fristenZwischengespeichert(ablageZiel());
}

/** Ziel der Dashboard-Zeile «Fristen in 30 Tagen»: folgt ABLAGE_ZIEL — Trust flow `{TRUST_FLOW_URL}/<firma>/fristen`,
 *  sonst wie bisher die Fristen-Ansicht in Trust one. Server-seitig, weil der Schalter eine Server-Env ist. */
export function ablageFristenLink(): string {
  return ablageZiel() === "trust-flow" ? `${basisUrl("trust-flow")}/${FLOW_FIRMA}/fristen` : TRUST_ONE_FRISTEN_LINK;
}
