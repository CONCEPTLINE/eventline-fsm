// POST /api/ablage/name-vorschlag — strukturiert einen frei getippten
// Kurzbeschrieb ("Haftpflichtversicherung von der AXA, Police P-778812,
// vom 15.1.26") in die Bausteine des Ablage-Namensschemas (Typ, Betreff,
// Partei, Nummer, Dokument-Datum). Den finalen Namen baut weiterhin
// deterministisch lib/ablage-doktypen — die KI erfindet nichts.
//
// DATENSCHUTZ (harte Leo-Vorgabe 2026-09-29): Das Dokument selbst wird
// NIE an die KI geschickt — nur der getippte Beschrieb und der
// Original-Dateiname. Vertrauliche Inhalte verlassen das System nicht.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";
import { DOK_TYPEN, dokTyp } from "@/lib/ablage-doktypen";
import { logError } from "@/lib/log";

export const maxDuration = 30;

type Vorschlag = {
  typ: string;
  betreff: string;
  partei: string;
  nummer: string;
  dok_datum: string;
  fragen: string[];
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["typ", "betreff", "partei", "nummer", "dok_datum", "fragen"],
  properties: {
    typ: {
      type: "string",
      enum: DOK_TYPEN.map((t) => t.key),
      description: "Passendster Dokumenttyp; wenn keiner klar passt: sonstiges.",
    },
    betreff: {
      type: "string",
      description:
        "Kern-Betreff in 1-4 Woertern Deutsch (das WAS, z.B. 'Haftpflicht', 'Buero-Miete'). Ohne Typ-Wiederholung, ohne Datum, ohne Nummer, ohne Partei. Leer nur wenn der Beschrieb gar nichts hergibt.",
    },
    partei: {
      type: "string",
      description:
        "Gegenpartei/Aussteller aus Sicht der EVENTLINE GmbH (z.B. Versicherer, Vertragspartner, Bank). Nie EVENTLINE selbst. Leer wenn nicht genannt.",
    },
    nummer: {
      type: "string",
      description: "Referenz-/Policen-/Rechnungsnummer, exakt wie genannt. Leer wenn keine genannt.",
    },
    dok_datum: {
      type: "string",
      description:
        "Datum DES DOKUMENTS als YYYY-MM-DD, nur wenn ein konkreter Tag eindeutig bestimmbar ist. Bei blossem Monat/Jahr oder Unsicherheit: leer.",
    },
    fragen: {
      type: "array",
      items: { type: "string" },
      description:
        "Maximal 2 kurze Rueckfragen an den Nutzer, NUR wenn eine fuers Wiederfinden wichtige Angabe KOMPLETT fehlt: die betroffene Person (z.B. bei Zertifikat/Kursbestaetigung/Bewilligung/Lohnabrechnung), die Gegenpartei/der Aussteller, oder das Dokumentdatum AUSSCHLIESSLICH bei Rechnung, Versicherungspolice, Mahnung oder Behoerdenbrief. Kurz und konkret, z.B. 'Für wen ist die Kursbestätigung?'. HARTE REGELN: Was der Nutzer schon genannt hat, gilt als beantwortet — nie nach Praezisierungen fragen (Vorname genuegt als Person, Kurzform genuegt als Firma). Nach dem Datum bei anderen Typen NIE fragen. Keine Fragen zu Optionalem (Nummern sind immer optional). Wenn nichts Wichtiges fehlt: leere Liste.",
    },
  },
};

const SYSTEM = `Du strukturierst Kurzbeschriebe fuer die Dokumentenablage der EVENTLINE GmbH (Eventtechnik-Firma, Basel). Du bekommst NUR den vom Nutzer getippten Beschrieb und den Dateinamen — nie das Dokument.

Regeln:
- Uebernimm ausschliesslich Informationen, die im Beschrieb oder Dateinamen stehen. NICHTS erfinden, NICHTS raten — im Zweifel Feld leer lassen.
- Schweizer Kontext: Datumsangaben wie "15.1.26" bedeuten 2026-01-15.
- Der Betreff ist der kuerzeste praezise Kern (1-4 Woerter), nicht der ganze Satz.
- Personen, um die es geht (z.B. Mitarbeiter bei Zertifikat, Kursbestaetigung oder Bewilligung), gehoeren mit in den Betreff — sonst ist spaeter unklar, wessen Dokument es ist. Ausnahme Lohnabrechnung: dort ist die Person die Partei.
- Normale deutsche Schreibweise mit Umlauten (Büro, Kündigung) — keine Ersatzschreibweisen wie "ue".`;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }
  try {
    const body = await req.json().catch(() => null);
    const beschrieb = String(body?.beschrieb ?? "").trim().slice(0, 600);
    const dateiname = String(body?.dateiname ?? "").trim().slice(0, 200);
    if (beschrieb.length < 3) {
      return NextResponse.json({ success: false, error: "Beschrieb ist zu kurz" }, { status: 400 });
    }

    const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
    const v = await structuredCall<Vorschlag>({
      system: SYSTEM,
      content: [
        {
          type: "text",
          text: `Heutiges Datum: ${heute}\nDateiname: ${dateiname || "(unbekannt)"}\n\nBeschrieb des Nutzers:\n${beschrieb}`,
        },
      ],
      toolName: "name_bausteine",
      toolDescription: "Die strukturierten Bausteine fuer den Ablage-Dateinamen.",
      schema: SCHEMA,
      maxTokens: 1024,
    });

    // Server-seitige Absicherung: nur gueltige Werte durchlassen.
    const vorschlag: Vorschlag = {
      typ: dokTyp(v.typ) ? v.typ : "sonstiges",
      betreff: (v.betreff ?? "").trim().slice(0, 120),
      partei: (v.partei ?? "").trim().slice(0, 120),
      nummer: (v.nummer ?? "").trim().slice(0, 120),
      dok_datum: /^\d{4}-\d{2}-\d{2}$/.test(v.dok_datum ?? "") ? v.dok_datum : "",
      fragen: (Array.isArray(v.fragen) ? v.fragen : [])
        .map((f) => String(f ?? "").trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, 2),
    };
    return NextResponse.json({ success: true, vorschlag });
  } catch (e) {
    logError("ablage.name-vorschlag", e);
    return NextResponse.json({ success: false, error: "KI-Vorschlag fehlgeschlagen — Felder bitte selbst ausfüllen" }, { status: 502 });
  }
}
