// Gemeinsame Anthropic-Anbindung fuer die KI-Routen (Auftrag-Eingang,
// Auftrag-Frage, Auftrags-Entwurf). Ein Client, ein Modell, ein Helfer
// fuer strukturierte Antworten via strict-Tool (garantiert schema-gueltiges
// JSON — kein fragiles JSON.parse auf Freitext).
//
// ANTHROPIC_API_KEY: liegt in Vercel-Env + .env.local. Fehlt/ungueltig →
// Routen antworten 503 mit Klartext-Meldung (UI zeigt sie als Toast).

import Anthropic from "@anthropic-ai/sdk";
import { logError } from "@/lib/log";

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

// ── Claude am Limit (Trust-one-Repo docs/lokale-ki/MASTERPLAN.md §3.9) ──────────────────
// Ist Claude gesperrt (Guthaben/Nutzungslimit), ueberlastet oder der Zugang
// ungueltig, bekommt der Nutzer eine klare deutsche Meldung statt «400 …».
// Kein lokaler Ersatz, kein DB-Zustand, kein Nachholen.
//
// Umsetzung: structuredCall wirft dann den ORIGINAL-Fehler des SDK weiter,
// nur mit klarer `message` und `grund` markiert. So zeigen die Routen, die
// `e.message` als Toast weitergeben, die Meldung automatisch — und Routen,
// die nach SDK-Klassen unterscheiden (`instanceof Anthropic.RateLimitError`),
// verhalten sich unveraendert. `e instanceof ClaudeNichtVerfuegbarError`
// erkennt beides: markierte SDK-Fehler und selbst erzeugte Instanzen.

export type ClaudeSperrGrund = "limit" | "ueberlastet" | "zugang";

export const CLAUDE_SPERR_MELDUNG: Readonly<Record<ClaudeSperrGrund, string>> = {
  limit: "Claude ist gerade nicht verfügbar: Guthaben oder Nutzungslimit erreicht. Bitte Mischa informieren.",
  ueberlastet: "Claude ist gerade ausgelastet. Bitte in ein paar Minuten nochmals versuchen.",
  zugang: "Claude-Zugang ungültig. Bitte Mischa informieren.",
};

const SPERR_MARKE = Symbol.for("eventline.claudeNichtVerfuegbar");

/** Texte der Anthropic-API zu Guthaben/Nutzungslimit (400/429), z. B.
 *  «Your credit balance is too low …», «You have reached your specified
 *  API usage limits …», Workspace-/Spend-Limits. */
const RE_LIMIT_TEXT = /credit balance|usage limit|spend(ing)? limit|billing|insufficient (credit|fund|balance)|quota/i;

/** Ordnet einen Fehler des Anthropic-SDK ein — null = kein Sperrgrund
 *  (normaler Fehler, z. B. kaputtes Bild oder Netzwerk). Rein, getestet. */
export function claudeSperrGrund(err: unknown): ClaudeSperrGrund | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const status = err.status;
  const body = err.error as { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown } | undefined;
  const typ = String(err.type ?? body?.error?.type ?? body?.type ?? "");
  const text = `${err.message} ${String(body?.error?.message ?? body?.message ?? "")}`;
  if (status === 402 || typ === "billing_error") return "limit";
  if ((status === 400 || status === 429) && RE_LIMIT_TEXT.test(text)) return "limit";
  if (status === 429 || status === 529 || typ === "overloaded_error" || typ === "rate_limit_error") return "ueberlastet";
  if (status === 401 || status === 403 || typ === "authentication_error" || typ === "permission_error") return "zugang";
  return null;
}

/** Claude gesperrt/ueberlastet/Zugang ungueltig — `message` ist die klare
 *  Meldung fuer den Toast, `grund` die Einordnung, `status` der HTTP-Status. */
export class ClaudeNichtVerfuegbarError extends Error {
  grund: ClaudeSperrGrund;
  status: number | undefined;

  constructor(grund: ClaudeSperrGrund, status?: number) {
    super(CLAUDE_SPERR_MELDUNG[grund]);
    this.name = "ClaudeNichtVerfuegbarError";
    this.grund = grund;
    this.status = status;
    Object.defineProperty(this, SPERR_MARKE, { value: true });
  }

  /** Erkennt auch die markierten SDK-Fehler (siehe oben). */
  static [Symbol.hasInstance](x: unknown): boolean {
    return typeof x === "object" && x !== null && (x as Record<symbol, unknown>)[SPERR_MARKE] === true;
  }
}

/** Markiert einen SDK-Fehler mit Sperrgrund (klare `message`, `grund`) und
 *  gibt ihn zurueck; andere Fehler unveraendert. Die urspruengliche
 *  SDK-Meldung bleibt fuer die Fehlersuche in `detail`. */
export function markiereClaudeFehler(err: unknown): unknown {
  const grund = claudeSperrGrund(err);
  if (!grund || !(err instanceof Error)) return err;
  const markiert = err as Error & { grund?: ClaudeSperrGrund; detail?: string };
  markiert.detail = err.message;
  markiert.message = CLAUDE_SPERR_MELDUNG[grund];
  markiert.grund = grund;
  Object.defineProperty(markiert, SPERR_MARKE, { value: true });
  return markiert;
}

/** Ein Request mit erzwungenem strict-Tool: die Antwort IST das validierte
 *  Tool-Input-Objekt. content = User-Bloecke (Text/Bilder/PDFs).
 *  Wirft bei Sperre/Ueberlast/Zugang einen ClaudeNichtVerfuegbarError
 *  (markierter SDK-Fehler, klare Meldung in `message`). */
export async function structuredCall<T>(opts: {
  system: string;
  content: Anthropic.ContentBlockParam[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const client = anthropicClient();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
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
  } catch (err) {
    const markiert = markiereClaudeFehler(err);
    // Die Routen loggen spaeter nur `message` (= die deutsche Meldung) —
    // die Original-Meldung der API (Datum der Sperre, 401 vs. 403, welche
    // 400) hier einmal festhalten, damit sie in den Vercel-Logs bleibt.
    if (markiert instanceof ClaudeNichtVerfuegbarError) {
      const m = markiert as Error & { grund?: ClaudeSperrGrund; detail?: string; status?: number };
      logError("ai.claude.nicht_verfuegbar", m.detail ?? m.message, { grund: m.grund, status: m.status });
    }
    throw markiert;
  }
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.toolName,
  );
  if (!toolUse) throw new Error("KI-Antwort ohne strukturiertes Ergebnis");
  return toolUse.input as T;
}
