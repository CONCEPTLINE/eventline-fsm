import "server-only";
import { unstable_cache } from "next/cache";
import { FLOW_FIRMA } from "@/lib/flow/ausweis";
import { LINERA_ONE_FRISTEN_LINK_ALT, TRUST_ONE_ABLAGE_BEREICH, TRUST_ONE_URL_STANDARD } from "@/lib/trust-one";

// Fristen-Zaehler der Ablage fuer Dashboard und Buero-Bildschirm. Die Ablage der EVENTLINE GmbH lebt seit 01.11.2026
// in LINERA flow (vorher seit 24.10.2026 in LINERA one); das ERP liest nur noch den Zaehler. Mail-Anhaenge leitet es nicht
// mehr weiter: ablage@in.eventline-basel.com meldet nur noch den Admins die neue Adresse ablage@in.linera-group.ch
// (api/inbound/mail).
// Schalter env ABLAGE_ZIEL = "linera-flow" (= "trust-flow", alter Wert gilt weiter) | "trust-one" (Standard, auch
// leer/unbekannt) — ablageZiel():
//   trust-flow  POST {LINERA_FLOW_URL}/api/ablage/extern/fristen  Body {firma: "eventline", tage: 30}
//               → {offen, faellig, vorschlaege}; faellig (innert 30 Tagen) = aktiv, vorschlaege = vorschlag
//   trust-one   GET  {LINERA_ONE_URL}/api/ablage/extern/fristen?bereich=…&tage=30 (Rueckweg bis 15.11.2026; danach
//               faellt dieser Zweig samt Schalter weg)
// ablageFristenLink() folgt demselben Schalter (Dashboard-Kachel). LINERA_FLOW_URL / LINERA_ONE_URL optional (Standard
// https://flow.linera-group.ch bzw. https://one.linera-group.ch); Bearer LINERA_ONE_ABLAGE_TOKEN (= ABLAGE_EXTERN_TOKEN).
// Env-Namen (E9 W4): zuerst der neue Name LINERA_*, dann der alte TRUST_* als Rueckfall (envNeuOderAlt).
// Werte nie loggen.

/** Wartezeit auf die Fristen (Dashboard und Wand warten darauf). */
const FRISTEN_TIMEOUT_MS = 8_000;
/** Fristen-Zaehler kurz zwischenspeichern — Dashboard und Wand pollen, die Fristen aendern sich selten. */
const FRISTEN_CACHE_S = 300;
/** Fenster des Fristen-Zaehlers (Tage ab heute, Zuerich) — gleich in LINERA one und LINERA flow. */
const FRISTEN_TAGE = 30;

/** Basis-Adresse von LINERA flow (env LINERA_FLOW_URL, Rueckfall TRUST_FLOW_URL, kann sie ueberschreiben). */
export const TRUST_FLOW_URL_STANDARD = "https://flow.linera-group.ch";

export type AblageZiel = "trust-one" | "trust-flow";

/** Werte von ABLAGE_ZIEL, die auf LINERA flow schalten: neu "linera-flow", alt "trust-flow" (beide gueltig). */
const ZIEL_FLOW = new Set(["linera-flow", "trust-flow"]);

/** Wohin die Ablage-Aufrufe gehen: env ABLAGE_ZIEL; nur "linera-flow"/"trust-flow" schaltet um, alles andere =
 *  "trust-one". Der interne Wert bleibt "trust-flow"/"trust-one" (Cache-Schluessel, Tests). */
export function ablageZiel(): AblageZiel {
  return ZIEL_FLOW.has(process.env.ABLAGE_ZIEL?.trim().toLowerCase() ?? "") ? "trust-flow" : "trust-one";
}

/** Env lesen: zuerst der neue Name (LINERA_*), dann der alte (TRUST_*) als Rueckfall; leer zaehlt als fehlend. */
function envNeuOderAlt(neu: string, alt: string): string | undefined {
  return process.env[neu]?.trim() || process.env[alt]?.trim() || undefined;
}

const ZIEL_NAME: Record<AblageZiel, string> = { "trust-one": "LINERA one", "trust-flow": "LINERA flow" };

function basisUrl(ziel: AblageZiel): string {
  const roh = ziel === "trust-flow"
    ? envNeuOderAlt("LINERA_FLOW_URL", "TRUST_FLOW_URL") || TRUST_FLOW_URL_STANDARD
    : envNeuOderAlt("LINERA_ONE_URL", "TRUST_ONE_URL") || TRUST_ONE_URL_STANDARD;
  return roh.replace(/\/+$/, "");
}

function token(): string | null {
  return envNeuOderAlt("LINERA_ONE_ABLAGE_TOKEN", "TRUST_ONE_ABLAGE_TOKEN") ?? null;
}

// ---------------------------------------------------------------------------
// Fristen
// ---------------------------------------------------------------------------

/** Fristen der Ablage von Zuerich-heute bis +30 Tage. `aktiv` = bestaetigt, `vorschlag` = Vorschlag der lokalen KI,
 *  noch nicht entschieden. Das Dashboard zaehlt beide, der Buero-Bildschirm nur `aktiv`. Gleiche Form fuer beide
 *  Ziele (LINERA flow: faellig → aktiv, vorschlaege → vorschlag; offen = alle offenen, hier nicht gebraucht). */
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
  if (!t) throw new Error(`Fristen: ${name} ist nicht verbunden (LINERA_ONE_ABLAGE_TOKEN fehlt)`);
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

/** Ziel der Dashboard-Zeile «Fristen in 30 Tagen»: folgt ABLAGE_ZIEL — LINERA flow `{LINERA_FLOW_URL}/<firma>/fristen`,
 *  sonst wie bisher die Fristen-Ansicht in LINERA one. Server-seitig, weil der Schalter eine Server-Env ist. */
export function ablageFristenLink(): string {
  return ablageZiel() === "trust-flow" ? `${basisUrl("trust-flow")}/${FLOW_FIRMA}/fristen` : LINERA_ONE_FRISTEN_LINK_ALT;
}
