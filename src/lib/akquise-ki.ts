/**
 * Gemeinsamer Unterbau der Akquise-KI-Routen: Client, Modell, Kontextzeile
 * und der Aufruf mit erzwungenem JSON-Schema.
 *
 * Bewusst zentral, damit Bedarfsanalyse und Konzept dieselbe Firmen-
 * beschreibung und dieselbe Fehlerbehandlung benutzen — driften die
 * auseinander, widersprechen sich die beiden Dokumente beim Kunden.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { KOOPERATIONS_MODELLE, type ModellKey } from "@/lib/akquise-faktoren";
import type { AkquiseLocation } from "@/types/akquise";

export const AKQUISE_MODELL = "claude-opus-5-5";

/** Was EVENTLINE ist — identisch in jedem erzeugten Dokument. */
export const EVENTLINE_KONTEXT = `ÜBER EVENTLINE:
Die EVENTLINE GmbH (Basel) ist Betriebs- und Vermarktungspartner für Eventlocations in der Schweiz. Sie betreibt und betreut eigene Häuser (Theater BAU3, Barakuba) und bietet fremden Locations vier Kooperationsmodelle an:
- Vermietungsmanagement: EVENTLINE vermarktet und bucht die Räume, der Eigentümer bleibt Vermieter.
- Vermietung + Betreuung: zusätzlich Betreuung vor Ort am Eventtag (Auf-/Abbau, Ansprechperson, Koordination der Gewerke).
- Location-Betreuung: nur der Betrieb vor Ort — so läuft es im Barakuba Basel.
- Technikpartner: nur Veranstaltungstechnik (Licht, Ton, Aufbau).
EVENTLINE macht KEIN Catering und ist KEINE IT-Firma. Technikpartner ist Herzog Tech.`;

/** Kurzprofil der Location für den Prompt — nur gesicherte Felder. */
export function locationKontext(l: AkquiseLocation): string {
  const modell = KOOPERATIONS_MODELLE.find((m) => m.key === l.empfohlenes_modell);
  const zeilen = [
    `Name: ${l.name}`,
    `Art: ${l.typ ?? "unbekannt"}`,
    `Ort: ${[l.strasse, l.plz, l.ort].filter(Boolean).join(", ")}`,
    l.kapazitaet !== null ? `Kapazität: ca. ${l.kapazitaet} Personen (Schätzung)` : "Kapazität: unbekannt",
    `Eigentümer-Typ: ${l.eigentuemer_typ}`,
    `Vermarktet selbst: ${l.eigene_vermarktung}`,
    `Personal vor Ort: ${l.personal_vor_ort}`,
    `Technik vorhanden: ${l.technik_vorhanden}`,
    modell ? `Empfohlenes Modell: ${modell.label} — ${modell.beschreibung}` : "Empfohlenes Modell: noch keines",
    l.rentabilitaet_chf !== null
      ? `Geschätzter EVENTLINE-Jahresbeitrag: ${l.rentabilitaet_chf} CHF (eigene Schätzrechnung, NICHT dem Kunden nennen)`
      : "",
    l.website ? `Website: ${l.website}` : "",
    l.bewertung?.ki_einschaetzung ? `Bisherige Einschätzung: ${l.bewertung.ki_einschaetzung}` : "",
    l.notizen ? `Interne Notizen: ${l.notizen}` : "",
  ];
  return zeilen.filter(Boolean).join("\n");
}

export class KiFehler extends Error {}

/**
 * Ein Aufruf mit erzwungenem Schema. Wirft `KiFehler` mit lesbarem Text —
 * die Routen geben den direkt an die UI weiter (§7: nie stiller Fehlschlag).
 */
export async function frageKi<T>(
  systemPrompt: string,
  userInhalt: string,
  schema: Parameters<typeof jsonSchemaOutputFormat>[0],
): Promise<T> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new KiFehler("ANTHROPIC_API_KEY ist nicht gesetzt");
  }
  const client = new Anthropic();

  let antwort;
  try {
    antwort = await client.messages.parse({
      model: AKQUISE_MODELL,
      max_tokens: 16000,
      system: systemPrompt,
      output_config: { format: jsonSchemaOutputFormat(schema) },
      messages: [{ role: "user", content: userInhalt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new KiFehler("KI ist gerade überlastet — in einer Minute erneut versuchen.");
    }
    if (e instanceof Anthropic.APIError) {
      throw new KiFehler(`KI-Fehler ${e.status}: ${e.message}`);
    }
    throw new KiFehler("KI nicht erreichbar");
  }

  // Sicherheitsklassifikatoren antworten mit HTTP 200 — stop_reason prüfen,
  // bevor content gelesen wird.
  if (antwort.stop_reason === "refusal") {
    throw new KiFehler("Die KI hat die Anfrage abgelehnt.");
  }
  if (antwort.stop_reason === "max_tokens") {
    throw new KiFehler("Antwort wurde abgeschnitten — bitte erneut versuchen.");
  }
  const out = antwort.parsed_output as T | null;
  if (!out) throw new KiFehler("Antwort der KI war nicht lesbar.");
  return out;
}

export type { ModellKey };
