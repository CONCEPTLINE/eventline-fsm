// POST /api/ai/auftrag-entwurf — macht aus einem frei eingeworfenen Text
// (weitergeleitete Kunden-Mail, diktierter Satz) einen vorbefuellten
// Auftrags-Entwurf. Die UI (auftraege/neu) mappt kunde_name/ort_name auf
// bestehende Datensaetze; die KI liefert nur Rohwerte und erfindet nichts.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";

type Entwurf = {
  titel: string | null;
  beschreibung: string | null;
  kunde_name: string | null;
  ort_name: string | null;
  adresse: string | null;
  start_datum: string | null;
  end_datum: string | null;
  kontakt_person: string | null;
  kontakt_telefon: string | null;
  kontakt_email: string | null;
};

const ENTWURF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "titel", "beschreibung", "kunde_name", "ort_name", "adresse",
    "start_datum", "end_datum", "kontakt_person", "kontakt_telefon", "kontakt_email",
  ],
  properties: {
    titel: { type: ["string", "null"], description: "Kurzer Auftragstitel." },
    beschreibung: { type: ["string", "null"], description: "Was zu tun ist, sachlich zusammengefasst." },
    kunde_name: { type: ["string", "null"], description: "Firmen-/Kundenname, exakt wie im Text." },
    ort_name: { type: ["string", "null"], description: "Name der Location/des Veranstaltungsorts." },
    adresse: { type: ["string", "null"], description: "Strasse/PLZ/Ort, falls genannt." },
    start_datum: { type: ["string", "null"], description: "Beginn als YYYY-MM-DD, nur wenn eindeutig." },
    end_datum: { type: ["string", "null"], description: "Ende als YYYY-MM-DD, nur wenn eindeutig." },
    kontakt_person: { type: ["string", "null"] },
    kontakt_telefon: { type: ["string", "null"] },
    kontakt_email: { type: ["string", "null"] },
  },
};

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const text = (body.text ?? "").trim().slice(0, 20000);
  if (text.length < 10) {
    return NextResponse.json({ success: false, error: "Zu wenig Text" }, { status: 400 });
  }

  try {
    const entwurf = await structuredCall<Entwurf>({
      system:
        "Du extrahierst aus einem frei formulierten Text (Kunden-Mail, diktierte Notiz) die Eckdaten " +
        "für einen neuen Veranstaltungstechnik-Auftrag der Firma EVENTLINE (Basel). " +
        `Heute ist ${new Date().toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" })}. ` +
        "Relative Angaben (z.B. 'nächsten Freitag') in konkrete Daten umrechnen. " +
        "Nichts erfinden: Was der Text nicht hergibt, bleibt null.",
      content: [{ type: "text", text }],
      toolName: "entwurf_speichern",
      toolDescription: "Speichert die extrahierten Auftrags-Eckdaten.",
      schema: ENTWURF_SCHEMA,
      maxTokens: 1500,
    });
    return NextResponse.json({ success: true, entwurf });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Anfrage fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
