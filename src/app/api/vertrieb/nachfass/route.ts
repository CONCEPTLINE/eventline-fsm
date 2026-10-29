// POST /api/vertrieb/nachfass  { id }  (vertrieb:edit)
//
// Bereitet für einen Kampagnen-Kontakt eine kurze Nachfass-Mail vor
// (Claude, gemeinsame Anbindung src/lib/ai/anthropic.ts) und speichert sie
// in nachfass_betreff / nachfass_text. Versendet wird NICHTS — Leo kopiert
// den Text in Outlook.
//
// Datenschutz (Leo: «aus dem FSM dürfen keine Daten einfach rausgehen»):
// an die KI gehen nur Firmenname, Betreff und Text der eigenen Erstmail
// (darin die Anrede) und die Runde (1./2. Nachfassen) — keine Adressen,
// Telefonnummern, Notizen oder Antworten.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";
import { AI_UNAVAILABLE_MSG, ClaudeNichtVerfuegbarError, aiAvailable, structuredCall } from "@/lib/ai/anthropic";
import { NACHFASS_MAX, bereinigeNachfassText } from "@/lib/vertrieb/nachfassen";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM = `Du schreibst für Leo Balaszeskul, Geschäftsführer der EVENTLINE GmbH (Events und Messebau, Basel), eine kurze Nachfass-Mail zu seiner eigenen, bisher unbeantworteten Erstmail.

Regeln (alle verbindlich):
- Gleiche Sprache wie die Erstmail.
- Sie-Form. Schweizer Rechtschreibung: immer «ss», nie «ß».
- 50 bis 90 Wörter im Text.
- Beginne mit derselben Anrede wie die Erstmail.
- Erinnere freundlich und kurz an die erste Mail.
- Greife den Partnerschafts-Gedanken der Erstmail in einem Satz auf.
- Schliesse mit einer leichten Ja/Nein-Frage, die einfach zu beantworten ist.
- KEIN Gruss und KEINE Signatur am Ende (die setzt Leo selbst).
- Keine Preise, Beträge oder Rabatte.
- Keine Raumnamen (insbesondere nie BAU3, Barakuba, SCALA, Tanzhaus).
- Nichts erfinden, was nicht in der Erstmail steht. Kein Druck, keine Floskeln.
- Betreff: kurz, in derselben Sprache, mit Bezug zur Erstmail.`;

const SCHEMA = {
  type: "object",
  properties: {
    betreff: { type: "string", description: "Betreff der Nachfass-Mail" },
    text: { type: "string", description: "Text der Nachfass-Mail, mit Anrede, ohne Gruss/Signatur" },
  },
  required: ["betreff", "text"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;
  if (!aiAvailable()) return NextResponse.json({ ok: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (!isUuid(id)) return NextResponse.json({ ok: false, error: "Ungültige Kontakt-ID" }, { status: 400 });

  const admin = createAdminClient();
  const { data: k, error } = await admin
    .from("vertrieb_kampagne_kontakte")
    .select("id, firma, mail_betreff, mail_text, mail_sprache, nachfass_anzahl")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: "Kontakt nicht lesbar" }, { status: 500 });
  if (!k) return NextResponse.json({ ok: false, error: "Kontakt nicht gefunden" }, { status: 404 });
  if (!k.mail_text?.trim()) {
    return NextResponse.json({ ok: false, error: "Ohne Erstmail-Text kann kein Nachfassen vorbereitet werden" }, { status: 422 });
  }
  if (k.nachfass_anzahl >= NACHFASS_MAX) {
    return NextResponse.json({ ok: false, error: `Schon ${NACHFASS_MAX}× nachgefasst` }, { status: 422 });
  }

  const runde = k.nachfass_anzahl + 1;
  const auftrag = [
    `Firma: ${k.firma}`,
    k.mail_sprache ? `Sprache der Erstmail: ${k.mail_sprache}` : null,
    runde === NACHFASS_MAX
      ? `Dies ist die ${runde}. und letzte Nachfrage: noch kürzer, und biete an, das Thema ruhen zu lassen, falls kein Bedarf besteht.`
      : "Dies ist die erste Nachfrage.",
    "",
    `Betreff der Erstmail: ${k.mail_betreff ?? ""}`,
    "Erstmail:",
    k.mail_text,
  ].filter((z) => z !== null).join("\n");

  try {
    let ergebnis: { betreff: string; text: string } | null = null;
    // Höchstens zwei Versuche: enthält der Vorschlag einen Raumnamen, neu erzeugen.
    for (let versuch = 0; versuch < 2 && !ergebnis; versuch++) {
      const roh = await structuredCall<{ betreff: string; text: string }>({
        system: SYSTEM,
        content: [{ type: "text", text: auftrag }],
        toolName: "nachfass_mail",
        toolDescription: "Gibt Betreff und Text der Nachfass-Mail zurück.",
        schema: SCHEMA,
        maxTokens: 1024,
      });
      const text = bereinigeNachfassText(roh.text ?? "");
      const betreff = bereinigeNachfassText(roh.betreff ?? "");
      if (text.text && !text.raumname && !betreff.raumname) ergebnis = { betreff: betreff.text, text: text.text };
    }
    if (!ergebnis) {
      return NextResponse.json({ ok: false, error: "Vorschlag unbrauchbar — bitte nochmals versuchen" }, { status: 502 });
    }

    const { error: uErr } = await admin
      .from("vertrieb_kampagne_kontakte")
      .update({ nachfass_betreff: ergebnis.betreff, nachfass_text: ergebnis.text })
      .eq("id", id);
    if (uErr) return NextResponse.json({ ok: false, error: `Speichern fehlgeschlagen: ${uErr.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, ...ergebnis });
  } catch (e) {
    if (e instanceof ClaudeNichtVerfuegbarError) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 503 });
    }
    logError("vertrieb-nachfass", e);
    return NextResponse.json({ ok: false, error: "Vorschlag konnte nicht erstellt werden" }, { status: 500 });
  }
}
