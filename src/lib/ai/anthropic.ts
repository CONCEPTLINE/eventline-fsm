// Gemeinsame Anthropic-Anbindung fuer die KI-Routen (Auftrag-Eingang,
// Auftrag-Frage, Auftrags-Entwurf). Ein Client, ein Modell, ein Helfer
// fuer strukturierte Antworten via strict-Tool (garantiert schema-gueltiges
// JSON — kein fragiles JSON.parse auf Freitext).
//
// ANTHROPIC_API_KEY: liegt in Vercel-Env + .env.local. Fehlt/ungueltig →
// Routen antworten 503 mit Klartext-Meldung (UI zeigt sie als Toast).

import Anthropic from "@anthropic-ai/sdk";

export const AI_MODEL = "claude-opus-5";

export function aiAvailable(): boolean {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.length > 20 && !k.includes("HIER");
}

export const AI_UNAVAILABLE_MSG =
  "KI ist noch nicht eingerichtet — der Anthropic-Schlüssel fehlt oder ist ungültig.";

let _client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/** Ein Request mit erzwungenem strict-Tool: die Antwort IST das validierte
 *  Tool-Input-Objekt. content = User-Bloecke (Text/Bilder/PDFs). */
export async function structuredCall<T>(opts: {
  system: string;
  content: Anthropic.ContentBlockParam[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const client = anthropicClient();
  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
        strict: true,
      } as Anthropic.Tool,
    ],
    tool_choice: { type: "tool", name: opts.toolName },
    messages: [{ role: "user", content: opts.content }],
  });
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.toolName,
  );
  if (!toolUse) throw new Error("KI-Antwort ohne strukturiertes Ergebnis");
  return toolUse.input as T;
}
