import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { EVE_SYSTEM_PROMPT } from "@/lib/eve-system-prompt";
import { EVE_TOOL_DECLARATIONS, executeEveTool } from "@/lib/eve-tools";

/**
 * POST /api/chat — Eve mit Tool-Use (Phase 2).
 *
 * Loop:
 *  1. Sende messages + tools an Gemini
 *  2. Wenn Response functionCall enthaelt: tool serverside ausfuehren,
 *     Result anhaengen, Schleife
 *  3. Wenn text-Response: an Client zurueck
 *
 * Max 6 Iterationen (Schutz gegen runaway-Loops). Non-streaming damit
 * der Tool-Loop einfach bleibt — UX-mässig zeigt der Client einen
 * "denkt nach"-Indikator, das reicht.
 */

interface ClientMessage {
  role: "user" | "model";
  text: string;
}

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_ITERATIONS = 6;

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result?: unknown } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export async function POST(request: NextRequest) {
  try {
    // Eve ist seit 2026-05-07 fuer alle eingeloggten Mitarbeiter offen.
    // RLS auf den DB-Queries (via user-session, nicht service-role) sorgt
    // dafuer dass Techniker nur ihre eigenen Daten sehen.
    const auth = await requireUser();
    if (auth.error) return auth.error;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY fehlt" }, { status: 503 });
    }

    const body = await request.json();
    const incoming = (body?.messages ?? []) as ClientMessage[];
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return NextResponse.json({ error: "messages fehlt" }, { status: 400 });
    }

    const history: GeminiContent[] = incoming.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    }));

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: history,
          systemInstruction: { parts: [{ text: EVE_SYSTEM_PROMPT }] },
          tools: [{ functionDeclarations: EVE_TOOL_DECLARATIONS }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        logError("api.chat.gemini", new Error(`${res.status}: ${txt}`));
        return NextResponse.json({ error: `Gemini Fehler ${res.status}` }, { status: 502 });
      }

      const json = await res.json();
      const candidate = json?.candidates?.[0];
      const parts: GeminiPart[] = candidate?.content?.parts ?? [];
      const finishReason: string | undefined = candidate?.finishReason;

      const fnCallPart = parts.find((p) => p.functionCall);
      if (fnCallPart?.functionCall) {
        // Tool ausfuehren
        const { name, args } = fnCallPart.functionCall;
        console.log(`[eve] iter=${i} tool_call=${name} args=${JSON.stringify(args ?? {})}`);
        let result: unknown;
        try {
          result = await executeEveTool(name, args ?? {});
          console.log(`[eve] iter=${i} tool_result=${JSON.stringify(result).slice(0, 400)}`);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : "Tool-Fehler" };
          console.log(`[eve] iter=${i} tool_error=${(result as { error: string }).error}`);
        }
        // History fortschreiben: model's functionCall + user's functionResponse
        history.push({ role: "model", parts });
        history.push({
          role: "user",
          parts: [{ functionResponse: { name, response: { result } } }],
        });
        continue;
      }

      // Text-Antwort — fertig
      const text = parts
        .map((p) => p.text)
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .join("");
      if (!text) {
        // Kein Text + kein Tool-Call → meist safety-block, max-tokens, oder
        // Gemini hat eine leere Response geliefert. Loggen damit wir's sehen.
        console.log(`[eve] iter=${i} EMPTY_RESPONSE finishReason=${finishReason} parts=${JSON.stringify(parts).slice(0, 400)}`);
        const reasonMsg = finishReason === "SAFETY" ? "(Safety-Filter hat geblockt)"
          : finishReason === "MAX_TOKENS" ? "(Antwort wurde abgeschnitten — frag nochmal mit kürzerem Scope)"
          : "(keine Antwort — eventuell Frage präzisieren)";
        return NextResponse.json({ text: reasonMsg });
      }
      return NextResponse.json({ text });
    }

    return NextResponse.json({ text: "Ich konnte das in der Zeit nicht beantworten — bitte konkreter fragen." });
  } catch (e) {
    logError("api.chat", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unbekannter Fehler" }, { status: 500 });
  }
}
