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
const EMAIL_SYSTEM_PROMPT = `Du bist erfahrener B2B-Vertriebstexter der EVENTLINE GmbH und schreibst eine persönliche Erstkontakt-E-Mail (Kaltakquise) an einen potenziellen Kunden. Die Mail soll professionell und menschlich wirken, echtes Interesse an der Organisation zeigen und zu einem kurzen Gespräch einladen — nie aufdringlich, werblich oder nach Serienbrief klingend.

ÜBER EVENTLINE:
EVENTLINE GmbH ist Verwaltungs- und Betriebspartner für Eventlocations in der Region Basel (Nordwestschweiz): Raumvermietung & Locationmanagement sowie die technische und logistische Event-Produktion (Ton, Licht, Bühne, Auf- und Abbau, Vor-Ort-Koordination). Kernnutzen: EVENTLINE nimmt Veranstaltern die Organisation und Technik ab, damit sie sich auf ihren Anlass konzentrieren können. EVENTLINE macht KEIN Catering und ist KEINE IT-Firma.

AUFBAU (genau diese Reihenfolge, als fliessende Absätze mit je einer Leerzeile dazwischen):
1) Anrede: "Guten Tag Herr <Nachname>," bzw. "Guten Tag Frau <Nachname>," wenn eine Ansprechperson bekannt ist — sonst "Guten Tag,". Niemals "Sehr geehrte Damen und Herren".
2) Aufhänger (1 Satz): konkret auf die Organisation bezogen, warum du dich gerade bei IHNEN meldest (nutze Art/Branche/Anlass-Typ/Kontext). Nichts erfinden.
3) Nutzen (2–3 kurze Sätze): wie EVENTLINE genau dieser Organisation konkret hilft (z.B. Technik, Auf-/Abbau und Koordination übernehmen, Organisation entlasten). Greifbar, kein Buzzword-Bingo.
4) Call-to-Action (1 Satz): niederschwellig — ein kurzes, unverbindliches Telefonat/Kennenlernen, mit sanfter Terminanbahnung (z.B. "Hätten Sie kommende Woche 15 Minuten für einen kurzen Austausch?").
5) Abschluss: die Mail endet mit der Grussformel "Freundliche Grüsse" auf einer eigenen Zeile — MEHR NICHT.

STIL:
- Deutsch, Schweizer Geschäftston, höfliche Sie-Form. Warm, persönlich, konkret — nicht generisch.
- Fliesstext 90–150 Wörter, kurze klare Sätze. Keine Superlative, keine leeren Floskeln, kein "Ich hoffe, es geht Ihnen gut".
- Nichts erfinden: keine Preise, keine Zahlen, keine erfundenen Referenzen oder Namen. Unbekannte Angaben einfach weglassen.

KEINE SIGNATUR: Hänge KEINEN Absendernamen, KEINE Firma, KEINE Adresse und KEINE Kontaktdaten an. Die Signatur fügt das Mailprogramm (Outlook) automatisch hinzu. Die Mail endet direkt nach "Freundliche Grüsse".

BETREFF: prägnant und neugierig machend, bezogen auf den konkreten Nutzen/Anlass (nicht bloss "Zusammenarbeit"), max. 60 Zeichen, keine Werbe-Ausrufezeichen.

AUSGABE-FORMAT (extrem wichtig):
Gib AUSSCHLIESSLICH ein valides JSON-Objekt zurück. KEINE Markdown-Code-Fences, KEIN Text davor oder danach. Exakt diese Schlüssel:
{
  "betreff": "string (max. 60 Zeichen)",
  "text": "string (komplette Mail inkl. Anrede, Absätzen und Grussformel — OHNE Signatur; \\n für Zeilenumbruch, \\n\\n zwischen Absätzen)"
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
