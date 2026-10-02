// POST /api/ablage/vorschlaege-pruefen — KI-Plausibilitaetspruefung der
// deterministisch erzeugten Ordner-Vorschlaege (Leo 2026-10-02: "nicht
// blind Regeln folgen"). Die Regel-Engine bleibt der Kandidaten-Finder
// (vollstaendig, erfindet nichts); die KI sieht die ECHTE Nachbar-
// struktur (nur Ordnernamen, nie Inhalte) und darf pro Vorschlag
// streichen oder eine Teilmenge der Pfade behalten — nie ergaenzen.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";
import { logError } from "@/lib/log";

export const maxDuration = 30;

type Bewertung = { id: string; behalten_pfade: string[]; grund: string };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bewertungen"],
  properties: {
    bewertungen: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "behalten_pfade", "grund"],
        properties: {
          id: { type: "string", description: "Die Vorschlags-ID unveraendert." },
          behalten_pfade: {
            type: "array",
            items: { type: "string" },
            description:
              "Die fachlich sinnvollen Pfade dieses Vorschlags — exakte Teilmenge der mitgeschickten neuen Pfade. Leer = Vorschlag komplett verwerfen.",
          },
          grund: { type: "string", description: "Ein kurzer Satz Begruendung (Deutsch)." },
        },
      },
    },
  },
};

const SYSTEM = `Du pruefst Ordnerstruktur-Vorschlaege fuer die Dokumentenablage der EVENTLINE GmbH (Eventtechnik, Basel). Eine Regel-Engine hat Kandidaten erzeugt; du beurteilst SEMANTISCH anhand der gezeigten Nachbarstruktur, ob sie fachlich Sinn ergeben.

Leitlinien:
- Jahresordner (2026, 2027, …) gehoeren nur in SAMMEL-Ordner, die laufend neue Ablagen pro Jahr bekommen (z.B. Interne_Schulungen, Nachweise, Rechnungen, Backups). NICHT in Katalog-, Vorlagen-, Plan- oder Themen-Ordner (z.B. Externe_Angebote mit Themen-Unterordnern, Schulungsplan, Vorlagen).
- Geschwister-Unterordner nur vorschlagen, wenn die Geschwister wirklich GLEICHARTIGE Instanzen sind (z.B. Personalakten, Locations) — nicht, wenn jeder Geschwister-Ordner etwas anderes ist.
- Du darfst pro Vorschlag auch nur EINEN Teil der Pfade behalten, wenn er nur dort Sinn ergibt.
- Im Zweifel verwerfen — ein unsinniger Vorschlag nervt mehr, als ein fehlender schadet.`;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }
  try {
    const body = await req.json().catch(() => null);
    const roh = Array.isArray(body?.vorschlaege) ? (body.vorschlaege as { id?: unknown; titel?: unknown; neuePfade?: unknown }[]) : [];
    const vorschlaege = roh
      .map((v) => ({
        id: String(v?.id ?? "").slice(0, 200),
        titel: String(v?.titel ?? "").slice(0, 300),
        neuePfade: (Array.isArray(v?.neuePfade) ? (v.neuePfade as unknown[]) : [])
          .map((p) => String(p ?? ""))
          .filter(Boolean)
          .slice(0, 50),
      }))
      .filter((v) => v.id && v.neuePfade.length > 0)
      .slice(0, 8);
    if (vorschlaege.length === 0) {
      return NextResponse.json({ success: true, bewertungen: [] });
    }

    // Nachbarstruktur als Kontext: pro Vorschlag der Unterbaum der
    // Gruppen-Eltern (nur aktive Ordnernamen, gekappt).
    const admin = createAdminClient();
    const { data: alleOrdner } = await admin.from("ablage_ordner").select("pfad, aktiv").order("pfad").limit(2000);
    const inaktiv = (alleOrdner ?? []).filter((o) => !o.aktiv).map((o) => o.pfad as string);
    const aktive = (alleOrdner ?? [])
      .map((o) => o.pfad as string)
      .filter((p) => !inaktiv.some((i) => p === i || p.startsWith(i + "/")));

    const bloecke = vorschlaege.map((v) => {
      const instanz = v.neuePfade[0].slice(0, v.neuePfade[0].lastIndexOf("/"));
      const gruppe = instanz.includes("/") ? instanz.slice(0, instanz.lastIndexOf("/")) : instanz;
      const baum = aktive.filter((p) => p === gruppe || p.startsWith(gruppe + "/")).slice(0, 120);
      return `VORSCHLAG ${v.id}
${v.titel}
Neue Pfade:
${v.neuePfade.map((p) => `+ ${p}`).join("\n")}
Bestehende Struktur unter «${gruppe}»:
${baum.join("\n")}`;
    });

    const v = await structuredCall<{ bewertungen: Bewertung[] }>({
      system: SYSTEM,
      content: [{ type: "text", text: bloecke.join("\n\n---\n\n") }],
      toolName: "vorschlaege_bewerten",
      toolDescription: "Bewertet jeden Vorschlag: sinnvolle Pfade behalten, Rest verwerfen.",
      schema: SCHEMA,
      maxTokens: 2048,
    });

    // Validierung: nur exakte Teilmengen der eingereichten Pfade.
    const erlaubt = new Map(vorschlaege.map((x) => [x.id, new Set(x.neuePfade)]));
    const bewertungen = (v.bewertungen ?? [])
      .filter((b) => erlaubt.has(b.id))
      .map((b) => ({
        id: b.id,
        behalten_pfade: (b.behalten_pfade ?? []).filter((p) => erlaubt.get(b.id)!.has(p)),
        grund: String(b.grund ?? "").slice(0, 300),
      }));
    return NextResponse.json({ success: true, bewertungen });
  } catch (e) {
    logError("ablage.vorschlaege-pruefen", e);
    return NextResponse.json({ success: false, error: "Prüfung fehlgeschlagen" }, { status: 502 });
  }
}
