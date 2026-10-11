import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { EVENTLINE_KONTEXT, locationKontext, frageKi, KiFehler } from "@/lib/akquise-ki";
import type { AkquiseLocation, Bedarfsanalyse } from "@/types/akquise";

export const maxDuration = 120;

const SYSTEM_PROMPT = `Du erstellst für die EVENTLINE GmbH eine interne Bedarfsanalyse zu einer Location, die als Kooperationspartner in Frage kommt.

${EVENTLINE_KONTEXT}

Die Analyse ist INTERN — sie geht nicht an die Location. Sie ist die Grundlage für das Erstgespräch und für das Kooperationskonzept, das danach erstellt wird. Sie muss nüchtern und ehrlich sein, auch wenn das Ergebnis «lohnt sich nicht» lautet.

AUFBAU:
- ausgangslage: 2-4 Sätze. Was ist das für ein Haus, wie betreibt es sich heute, und wo steht EVENTLINE dazu? Keine Werbung, keine Floskeln.
- luecken: 2-5 Punkte. Was fehlt der Location konkret (Vermarktung, Personal, Technik, Prozesse)? Jeder Punkt ein kurzer Satz.
- unser_beitrag: 2-5 Punkte. Was davon deckt EVENTLINE ab — konkret benannt, nicht «Rundum-Service».
- risiken: 2-4 Punkte. Was spricht dagegen oder macht es schwierig? Hier gehört die unbequeme Wahrheit hin: eigenes Team vorhanden, knappes Budget, öffentliche Ausschreibungspflicht, Lage, Konkurrenz. Wenn der Fall schwach ist, sag es.
- offene_fragen: 3-5 Fragen, die im Erstgespräch geklärt werden müssen und die man NICHT recherchieren kann (Auslastung, Zufriedenheit mit dem Status quo, Entscheidungsweg, Vertragsbindungen).

REGELN:
- Deutsch, Schweizer Hochdeutsch, «ss» statt «ß».
- Nichts erfinden: keine Umsatzzahlen, keine Namen von Ansprechpersonen, keine erfundenen Referenzen. Wo du schätzt, schreibe «vermutlich» oder «zu prüfen».
- Markiere Angaben, die auf «unklar»-Faktoren beruhen, als zu prüfen statt sie als Tatsache zu setzen.
- Die interne Rentabilitätsschätzung NICHT wiederholen — sie ist eine grobe Hausrechnung.`;

const SCHEMA = {
  type: "object",
  properties: {
    ausgangslage: { type: "string" },
    luecken: { type: "array", items: { type: "string" } },
    unser_beitrag: { type: "array", items: { type: "string" } },
    risiken: { type: "array", items: { type: "string" } },
    offene_fragen: { type: "array", items: { type: "string" } },
  },
  required: ["ausgangslage", "luecken", "unser_beitrag", "risiken", "offene_fragen"],
  additionalProperties: false,
} as const;

/** POST /api/akquise/bedarfsanalyse  { id } */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ success: false, error: "Keine id" }, { status: 400 });

  const supabase = await createClient();
  const { data: location, error } = await supabase
    .from("akquise_locations").select("*").eq("id", id).single();
  if (error || !location) {
    return NextResponse.json({ success: false, error: "Location nicht gefunden" }, { status: 404 });
  }

  let teile;
  try {
    teile = await frageKi<Omit<Bedarfsanalyse, "erstellt_am">>(
      SYSTEM_PROMPT, locationKontext(location as AkquiseLocation), SCHEMA,
    );
  } catch (e) {
    if (e instanceof KiFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 502 });
    }
    throw e;
  }

  const bedarfsanalyse: Bedarfsanalyse = { ...teile, erstellt_am: new Date().toISOString() };

  const { error: schreibFehler } = await supabase
    .from("akquise_locations").update({ bedarfsanalyse }).eq("id", id);
  if (schreibFehler) {
    return NextResponse.json({ success: false, error: schreibFehler.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, bedarfsanalyse });
}
