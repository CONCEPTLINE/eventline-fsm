/**
 * Tiefenrecherche je Location: was NICHT auf der eigenen Website steht.
 *
 * Die Website eines Hauses sagt, was es anbietet — sie sagt nicht, wer
 * dort gerade gekündigt hat, dass der Betrieb umgebaut wird, wer
 * Subventionen zahlt oder mit welchem Technikpartner gearbeitet wird.
 * Genau das entscheidet aber, ob und wie man ein Haus anspricht.
 *
 * Deshalb hier eine echte Websuche je Kandidat, nach den Punkten aus dem
 * Akquise-Auftrag: Presse der letzten zwei Jahre, Finanzierung und
 * Subventionen, Personalsituation, laufende Veraenderungen, Partner und
 * Lieferanten.
 *
 * Alles mit Quelle. Was sich nicht belegen laesst, bleibt leer — eine
 * erfundene Pressemeldung im Gespraech waere ein Eigentor.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { KiFehler, mitWiederholung } from "@/lib/akquise-ki";

const MODELL = "claude-opus-5-5";

const PROMPT = `Du recherchierst für die EVENTLINE GmbH (Basel) ein einzelnes Haus, das als Kooperationspartner in Frage kommt. Gesucht ist, was NICHT auf dessen eigener Website steht und was für ein Erstgespräch zählt.

SUCHE GEZIELT NACH:
- Presse der letzten zwei Jahre: lokale Zeitungen, Online-Portale, Branchenmedien. Was wurde über das Haus geschrieben?
- Trägerschaft und Finanzierung: Subventionen, Leistungsvereinbarungen, Beiträge der Gemeinde oder des Kantons, Stiftungsgelder, Handelsregister-Eintrag, Jahresberichte.
- Personalsituation: Leitungswechsel, Kündigungen, Stellenausschreibungen, ehrenamtliche Strukturen, Nachfolgefragen.
- Laufende Veränderungen: Umbau, Sanierung, Umzug, auslaufender Mietvertrag, Zwischennutzung mit Enddatum, Betreiberwechsel, Schliessungsdebatte.
- Mit wem das Haus zusammenarbeitet: Technikfirmen, Catering, Eventagenturen, Vereine, regelmässige Veranstalter, Sponsoren.
- Auslastung und Programm: wie viele Anlässe, welche Lücken, läuft das Haus voll oder nicht.

FÜR JEDEN BEFUND:
- aussage: EIN Satz, was du gefunden hast. Konkret, keine Allgemeinplätze.
- quelle: URL, auf der es steht. Ohne URL kein Befund.
- datum: Datum oder Jahr der Quelle, soweit erkennbar, sonst null.
- kategorie: "presse" / "finanzierung" / "personal" / "veraenderung" / "partner" / "auslastung"
- relevanz: "hoch" wenn es die Ansprache direkt beeinflusst (Betreiberwechsel, Geldnot, Leitungswechsel, auslaufender Vertrag), "mittel" wenn es den Hintergrund schärft, "gering" wenn es bloss Kolorit ist.

REGELN:
- NUR was du in den Suchergebnissen wirklich siehst. Keine Vermutung, keine Erinnerung ohne Beleg, keine erfundene Quelle.
- Findest du nichts, gib eine leere Liste zurück. Das ist ein korrektes Ergebnis und besser als Erfundenes.
- Achte darauf, dass die Quelle wirklich dieses Haus meint und nicht ein gleichnamiges anderswo.
- Höchstens 10 Befunde, die relevantesten zuerst.
- gespraechseinstieg: EIN Satz, wie man das Haus nach dieser Recherche ansprechen würde — woran man anknüpft. Nichts gefunden → null.`;

const SCHEMA = {
  type: "object",
  properties: {
    befunde: {
      type: "array",
      items: {
        type: "object",
        properties: {
          aussage: { type: "string" },
          quelle: { type: "string" },
          datum: { type: ["string", "null"] },
          kategorie: {
            type: "string",
            enum: ["presse", "finanzierung", "personal", "veraenderung", "partner", "auslastung"],
          },
          relevanz: { type: "string", enum: ["hoch", "mittel", "gering"] },
        },
        required: ["aussage", "quelle", "datum", "kategorie", "relevanz"],
        additionalProperties: false,
      },
    },
    gespraechseinstieg: { type: ["string", "null"] },
  },
  required: ["befunde", "gespraechseinstieg"],
  additionalProperties: false,
} as const;

export interface Befund {
  aussage: string;
  quelle: string;
  datum: string | null;
  kategorie: "presse" | "finanzierung" | "personal" | "veraenderung" | "partner" | "auslastung";
  relevanz: "hoch" | "mittel" | "gering";
}

export interface Tiefenrecherche {
  befunde: Befund[];
  gespraechseinstieg: string | null;
  recherchiert_am: string;
}

/**
 * Recherchiert ein Haus im Netz. Zwei Schritte, weil Websuche und
 * erzwungenes JSON-Format sich nicht kombinieren lassen.
 */
export async function tiefenRecherche(
  name: string,
  ort: string,
  website: string | null,
): Promise<Tiefenrecherche> {
  if (!process.env.ANTHROPIC_API_KEY) throw new KiFehler("ANTHROPIC_API_KEY ist nicht gesetzt");
  const client = new Anthropic();

  const auftrag =
    `Haus: ${name}, ${ort}${website ? ` (${website})` : ""}\n\n` +
    "Recherchiere im Netz nach Presse, Finanzierung, Personal, laufenden Veränderungen, " +
    "Partnern und Auslastung. Nenne zu jedem Befund die Quelle.";

  let roh: string;
  try {
    const r = await mitWiederholung(() => client.messages.create({
      model: MODELL,
      max_tokens: 16000,
      system: PROMPT,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 } as never],
      messages: [{ role: "user", content: auftrag }],
    }));
    if (r.stop_reason === "refusal") throw new KiFehler("Recherche abgelehnt.");
    roh = r.content.filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text).join("\n").trim();
  } catch (e) {
    if (e instanceof KiFehler) throw e;
    if (e instanceof Anthropic.APIError && e.status === 400 && /credit balance/i.test(e.message)) {
      throw new KiFehler("Das Anthropic-Guthaben ist aufgebraucht.");
    }
    throw new KiFehler("Tiefenrecherche fehlgeschlagen.");
  }

  if (!roh) {
    return { befunde: [], gespraechseinstieg: null, recherchiert_am: new Date().toISOString() };
  }

  const strukturiert = await mitWiederholung(() => client.messages.parse({
    model: MODELL,
    max_tokens: 16000,
    system:
      "Bringe die folgende Recherche in die vorgegebene Form. Übernimm NUR Befunde mit " +
      "Quelle, die im Text stehen. Erfinde nichts, ergänze nichts aus eigenem Wissen.",
    output_config: { format: jsonSchemaOutputFormat(SCHEMA) },
    messages: [{ role: "user", content: roh }],
  }));

  const out = strukturiert.parsed_output as
    { befunde: Befund[]; gespraechseinstieg: string | null } | null;

  return {
    befunde: out?.befunde ?? [],
    gespraechseinstieg: out?.gespraechseinstieg ?? null,
    recherchiert_am: new Date().toISOString(),
  };
}
