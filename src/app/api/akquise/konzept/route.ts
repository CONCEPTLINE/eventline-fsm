import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { KOOPERATIONS_MODELLE } from "@/lib/akquise-faktoren";
import { EVENTLINE_KONTEXT, locationKontext, frageKi, KiFehler } from "@/lib/akquise-ki";
import type { AkquiseLocation, Kooperationskonzept } from "@/types/akquise";

export const maxDuration = 120;

const SYSTEM_PROMPT = `Du schreibst für die EVENTLINE GmbH ein Kooperationskonzept an eine Location. Dieses Dokument GEHT AN DIE LOCATION — anders als die Bedarfsanalyse, die intern bleibt.

${EVENTLINE_KONTEXT}

Du bekommst die Location-Daten UND die interne Bedarfsanalyse. Das Konzept macht aus der Analyse ein Angebot: es benennt die Situation respektvoll, zeigt was EVENTLINE übernimmt, und schlägt einen konkreten nächsten Schritt vor.

AUFBAU:
- titel: eine Zeile, konkret auf das Haus bezogen. Nicht «Kooperationskonzept», sondern z. B. «Vermietungsmanagement für das Stadtcasino Basel».
- abschnitte: 4-6 Abschnitte, je mit titel und text (Fliesstext, 3-6 Sätze). Sinnvolle Reihenfolge:
  1. Worum es geht — warum EVENTLINE sich meldet, auf das Haus bezogen.
  2. Ausgangslage, wie wir sie sehen — die Lücken aus der Analyse, aber als Beobachtung formuliert, nie als Vorwurf. Was intern «kein Personal» heisst, heisst hier «der Betrieb bindet heute Ihre eigenen Leute».
  3. Was EVENTLINE übernimmt — das empfohlene Modell konkret ausbuchstabiert.
  4. Wie die Zusammenarbeit aussieht — Rollenteilung, wer was entscheidet, wer wen bezahlt (OHNE konkrete Preise oder Prozentsätze zu nennen).
  5. Was es Ihnen bringt — der Nutzen für die Location, nicht für EVENTLINE.
  6. optional: Referenz — Theater BAU3 und Barakuba als eigene Häuser erwähnen, wenn es passt.
- naechste_schritte: 2-3 konkrete Schritte, beginnend mit einem unverbindlichen Gespräch.

REGELN:
- Deutsch, Schweizer Hochdeutsch («ss» statt «ß»), höfliche Sie-Form, Schweizer Geschäftston.
- KEINE Preise, keine Prozentsätze, keine Zahlen zu Provision oder Pauschalen — die werden im Gespräch verhandelt.
- Nichts erfinden: keine Referenzkunden ausser BAU3 und Barakuba, keine Auslastungszahlen, keine Namen.
- Die Risiken aus der Analyse NICHT abschreiben — sie sind intern. Ist die Lage schwierig, dann vorsichtiger formulieren, nicht die Bedenken ausbreiten.
- Firmenname immer EVENTLINE in Versalien.
- Keine Grussformel, keine Signatur, keine Anrede — das Dokument ist ein Konzept, kein Brief.`;

const SCHEMA = {
  type: "object",
  properties: {
    titel: { type: "string" },
    abschnitte: {
      type: "array",
      items: {
        type: "object",
        properties: { titel: { type: "string" }, text: { type: "string" } },
        required: ["titel", "text"],
        additionalProperties: false,
      },
    },
    naechste_schritte: { type: "array", items: { type: "string" } },
  },
  required: ["titel", "abschnitte", "naechste_schritte"],
  additionalProperties: false,
} as const;

/** POST /api/akquise/konzept  { id } — setzt eine Bedarfsanalyse voraus. */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ success: false, error: "Keine id" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("akquise_locations").select("*").eq("id", id).single();
  if (error || !data) {
    return NextResponse.json({ success: false, error: "Location nicht gefunden" }, { status: 404 });
  }
  const location = data as AkquiseLocation;

  // Das Konzept baut auf der Analyse auf — ohne sie würde es raten.
  if (!location.bedarfsanalyse) {
    return NextResponse.json(
      { success: false, error: "Zuerst die Bedarfsanalyse erstellen" },
      { status: 400 },
    );
  }

  const a = location.bedarfsanalyse;
  const eingabe = [
    locationKontext(location),
    "",
    "INTERNE BEDARFSANALYSE:",
    `Ausgangslage: ${a.ausgangslage}`,
    `Lücken: ${a.luecken.join(" | ")}`,
    `Unser Beitrag: ${a.unser_beitrag.join(" | ")}`,
    `Risiken (INTERN, nicht ins Konzept): ${a.risiken.join(" | ")}`,
    `Offene Fragen: ${a.offene_fragen.join(" | ")}`,
  ].join("\n");

  let teile;
  try {
    teile = await frageKi<Omit<Kooperationskonzept, "erstellt_am" | "modell">>(
      SYSTEM_PROMPT, eingabe, SCHEMA,
    );
  } catch (e) {
    if (e instanceof KiFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 502 });
    }
    throw e;
  }

  const konzept: Kooperationskonzept = {
    ...teile,
    modell: location.empfohlenes_modell ?? "keins",
    erstellt_am: new Date().toISOString(),
  };

  const { error: schreibFehler } = await supabase
    .from("akquise_locations").update({ kooperationskonzept: konzept }).eq("id", id);
  if (schreibFehler) {
    return NextResponse.json({ success: false, error: schreibFehler.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true, konzept,
    modell_label: KOOPERATIONS_MODELLE.find((m) => m.key === konzept.modell)?.label,
  });
}
