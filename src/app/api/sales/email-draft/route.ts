import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";

// KI-Textentwurf kann ein paar Sekunden dauern
export const maxDuration = 30;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// ───────────────────────────────────────────────────────────────────────────
// ERSTKONTAKT-PROMPT — hier steuerst du, WIE die KI die Akquise-Mail schreibt.
// Leicht editierbar: Tonalität, Länge, was EVENTLINE anbietet.
// ───────────────────────────────────────────────────────────────────────────
const EMAIL_SYSTEM_PROMPT = `Du bist der Vertriebs-Assistent von EVENTLINE GmbH und schreibst eine persönliche Erstkontakt-E-Mail (Kaltakquise) an einen potenziellen Kunden.

ÜBER EVENTLINE:
EVENTLINE GmbH ist Verwaltungs- und Betriebspartner für Eventlocations in der Region Basel (Nordwestschweiz). EVENTLINE übernimmt Raumvermietung, Locationmanagement und die technische/logistische Event-Produktion (Ton, Licht, Bühne, Auf- und Abbau, Vor-Ort-Koordination). EVENTLINE macht KEIN Catering und ist KEINE IT-Firma.

ZIEL DER E-MAIL:
Die Organisation freundlich und auf Augenhöhe ansprechen, EVENTLINE kurz vorstellen und aufzeigen, wie EVENTLINE ihnen bei ihren Anlässen konkret helfen kann (z.B. Entlastung bei Organisation, Technik, Auf-/Abbau). Am Ende zu einem unverbindlichen Gespräch einladen.

STIL-REGELN:
- Sprache: Deutsch (Schweizer Geschäftston), höfliche Sie-Form. Begrüssung "Guten Tag" (mit Namen, wenn eine Ansprechperson bekannt ist, sonst nur "Guten Tag").
- Kurz und konkret: 90–160 Wörter im Fliesstext. Keine Floskel-Wüste, keine übertriebenen Superlative.
- Auf die Organisation eingehen (Art, Branche, Anlass-Typ), aber NICHTS erfinden, was nicht in den Daten steht.
- Ein klarer, niederschwelliger Call-to-Action (kurzes Telefonat / unverbindliches Kennenlernen).
- Kein Preis, keine erfundenen Referenzen, keine erfundenen Namen.
- Signatur am Schluss mit dem angegebenen Absendernamen und "EVENTLINE GmbH".

AUSGABE-FORMAT (extrem wichtig):
Gib AUSSCHLIESSLICH ein valides JSON-Objekt zurück. KEINE Markdown-Code-Fences, KEIN Fliesstext davor oder danach. Exakt diese Schlüssel:
{
  "betreff": "string (prägnante Betreffzeile, max. 60 Zeichen)",
  "text": "string (die komplette E-Mail inkl. Anrede, Fliesstext, Gruss und Signatur; \\n für Zeilenumbrüche)"
}`;

interface LeadInput {
  firma?: string;
  branche?: string;
  ansprechperson?: string;
  position?: string;
  event_typ?: string;
  notiz?: string;
  senderName?: string;
}

function buildUserPrompt(lead: LeadInput) {
  const zeilen: string[] = [];
  if (lead.firma) zeilen.push(`Organisation: ${lead.firma}`);
  if (lead.branche) zeilen.push(`Branche/Segment: ${lead.branche}`);
  if (lead.ansprechperson) zeilen.push(`Ansprechperson: ${lead.ansprechperson}${lead.position ? ` (${lead.position})` : ""}`);
  if (lead.event_typ) zeilen.push(`Art/Anlass-Typ: ${lead.event_typ}`);
  if (lead.notiz) zeilen.push(`Notiz/Kontext: ${lead.notiz}`);
  zeilen.push(`Absendername (für Signatur): ${lead.senderName || "Ihr EVENTLINE-Team"}`);

  return `Schreibe die Erstkontakt-E-Mail auf Basis dieser Lead-Daten:

${zeilen.join("\n")}

Nur, was oben steht, ist bekannt. Erfinde keine weiteren Details. Antworte nur mit dem JSON-Objekt.`;
}

// Robust: Fences strippen, JSON-Objekt extrahieren, try/catch
function parseEmail(text: string): { betreff?: string; text?: string } | null {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(t);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  // Auth-Gate wie bei den anderen Sales-Routen — kein anonymer KI-Aufruf.
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  try {
    const { firma, branche, ansprechperson, position, event_typ, notiz, senderName } =
      (await request.json()) as LeadInput;

    if (!firma) {
      return NextResponse.json({ success: false, error: "Firma/Organisation fehlt." }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "ANTHROPIC_API_KEY ist nicht gesetzt (Vercel-Umgebungsvariable)." },
        { status: 500 }
      );
    }

    let aiRes: Response;
    try {
      aiRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          system: EMAIL_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildUserPrompt({ firma, branche, ansprechperson, position, event_typ, notiz, senderName }),
            },
          ],
        }),
      });
    } catch (e) {
      return NextResponse.json(
        { success: false, error: "Verbindung zur Anthropic API fehlgeschlagen: " + (e as Error).message },
        { status: 502 }
      );
    }

    if (!aiRes.ok) {
      const body = await aiRes.text().catch(() => "");
      return NextResponse.json(
        { success: false, error: `Anthropic API Fehler (${aiRes.status}): ${body.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const aiData = await aiRes.json();
    const text: string = Array.isArray(aiData?.content)
      ? aiData.content
          .filter((b: { type?: string }) => b?.type === "text")
          .map((b: { text?: string }) => b.text || "")
          .join("\n")
      : "";

    const parsed = parseEmail(text);
    if (!parsed || !parsed.text) {
      return NextResponse.json(
        { success: false, error: "Die KI-Antwort konnte nicht ausgewertet werden. Bitte nochmals versuchen." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      betreff: (parsed.betreff || "").trim() || `EVENTLINE GmbH — Zusammenarbeit mit ${firma}`,
      text: parsed.text.trim(),
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: "Unerwarteter Fehler: " + (e as Error).message },
      { status: 500 }
    );
  }
}
