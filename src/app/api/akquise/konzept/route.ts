import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { KOOPERATIONS_MODELLE, konzeptKennzahlen, waehleTraeger, chf } from "@/lib/akquise-faktoren";
import { EVENTLINE_KONTEXT, locationKontext, frageKi, KiFehler } from "@/lib/akquise-ki";
import type { AkquiseLocation, Kooperationskonzept } from "@/types/akquise";

export const maxDuration = 120;

const SYSTEM_PROMPT = `Du schreibst ein Kooperationskonzept für eine Location. Dieses Dokument GEHT AN DIE LOCATION — anders als die interne Bedarfsanalyse. Es ist eine Verhandlungsgrundlage, kein Werbetext.

${EVENTLINE_KONTEXT}

DIE BEIDEN VERTRAGSGESICHTER:
- **KULTURLINE** ist ein Verein. Er tritt als Vertragspartner auf, wo ein Verein besser passt als eine GmbH: bei kleineren kulturellen und öffentlichen Häusern. Ein Verein wirkt agiler, und die Gegenseite fühlt sich weniger eingeengt — vor einer GmbH haben kulturelle Träger oft Respekt, weil sie Kommerzialisierung und lange Bindung fürchten.
  **KULTURLINE führt einen Fonds, der Veranstaltungen refinanziert.** Das ist der Punkt, den eine GmbH nicht bieten kann: Anlässe, die sich allein nicht tragen — Newcomer, eigene Produktionen, Formate mit kleinem Publikum — können daraus mitfinanziert werden. Für ein Haus ohne eigenes Budget ist das oft erst der Grund, über eine Kooperation nachzudenken; die Betriebsentlastung kommt danach.
- **EVENTLINE GmbH** ist der Vertragspartner bei allen anderen: Hotels, Firmen, Immobilienverwaltungen, grosse Häuser. Dort zählt Verbindlichkeit mehr als Beweglichkeit.

UNVERÄNDERLICH, egal wer unterschreibt: **Betrieb und Administration macht immer die EVENTLINE GmbH.** Steht KULTURLINE auf dem Vertrag, ist EVENTLINE der exklusive operative Partner dahinter. Das verschweigst du nicht — es ist die Stärke des Modells: Beweglichkeit eines Vereins, Verlässlichkeit eines eingespielten Betriebs. Welcher Träger vorgesehen ist, bekommst du vorgegeben; erfinde ihn nicht selbst.

ZAHLEN: Du bekommst berechnete Kennzahlen (Veranstaltungstage pro Jahr, was beim Partner bleibt, Anteil pro Veranstaltungstag). Verwende GENAU diese Zahlen, rechne nichts um, erfinde keine weiteren. Nenne sie als Grössenordnung ("rund", "ca."), denn es sind Schätzungen — und sag das auch. Keine zusätzlichen Prozentsätze, keine Pauschalen, keine Preise, die nicht in den Kennzahlen stehen.

AUFBAU:
- titel: eine Zeile, auf das Haus bezogen — wie "Wochenendbetrieb der Querfeld-Halle" oder "Vermietungsmanagement für das Stadtcasino". Nicht bloss "Kooperationskonzept".
- untertitel: Ein Satz, der das Modell in Alltagssprache fasst: wer macht was, und was hat die Location davon. Hier gehört der konkrete Nutzen hin (feste Einnahmen, professioneller Betrieb, entlastetes Team).
- abschnitte: 4–6 Abschnitte mit titel und text (Fliesstext, 3–6 Sätze):
  1. Ausgangslage — was wir am Haus sehen, als Beobachtung formuliert, nie als Vorwurf. Was intern "kein Personal" heisst, heisst hier "der Betrieb bindet heute Ihre eigenen Leute".
  2. Das Modell — wie die Zusammenarbeit konkret läuft, mit den Kennzahlen.
  3. Rollenteilung — wer entscheidet was, wer trägt welches Risiko, wer tritt gegenüber Mietern auf. Hier gehört hin, dass EVENTLINE den Betrieb führt.
  4. Was es Ihnen bringt — der Nutzen für die Location, nicht für uns.
  5. Was wir von Ihnen brauchen — ehrlich: Zugang, Schlüssel, Ansprechperson, Entscheidungsweg.
  6. optional: Referenz — Theater BAU3 und Barakuba als eigene Häuser, wenn es passt.

WENN KULTURLINE der Vertragspartner ist, bekommt der Fonds einen EIGENEN Abschnitt — nicht einen Nebensatz. Er gehört an die zweite oder dritte Stelle, noch vor die Rollenteilung. Beschreibe darin, was der Fonds für DIESES Haus bedeuten kann: welche Art von Anlässen dort dadurch möglich würde, die es sonst nicht gäbe. Beziehe dich auf das, was das Haus laut Recherche heute zeigt. Nenne KEINE Beträge, keine Quoten und keine Zusagen — der Fonds entscheidet im Einzelfall, und was im Konzept steht, wird später eingefordert.
- naechste_schritte: 2–3 konkrete Schritte, beginnend mit einem unverbindlichen Gespräch.

REGELN:
- Deutsch, Schweizer Hochdeutsch («ss» statt «ß»), höfliche Sie-Form, nüchterner Schweizer Geschäftston.
- Nichts erfinden: keine Referenzkunden ausser BAU3 und Barakuba, keine Auslastungszahlen, keine Namen.
- Die Risiken aus der internen Analyse NICHT abschreiben. Ist die Lage schwierig, formulierst du vorsichtiger — du breitest keine Bedenken aus.
- Firmenname immer EVENTLINE in Versalien, der Verein immer KULTURLINE.
- Keine Anrede, keine Grussformel, keine Signatur — das ist ein Konzept, kein Brief.`;

const SCHEMA = {
  type: "object",
  properties: {
    titel: { type: "string" },
    untertitel: { type: "string" },
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
  required: ["titel", "untertitel", "abschnitte", "naechste_schritte"],
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

  // Traeger und Zahlen kommen aus der Rechnung, nicht aus dem Modell —
  // erfundene Betraege in einem Dokument beim Kunden waeren nicht mehr
  // einzufangen.
  const faktoren = {
    flaeche: location.flaeche,
    kapazitaet: location.kapazitaet,
    zeitfenster_frei: location.zeitfenster_frei,
    monatsmiete_chf: location.monatsmiete_chf,
    eigene_vermarktung: location.eigene_vermarktung,
    personal_vor_ort: location.personal_vor_ort,
    technik_vorhanden: location.technik_vorhanden,
    eigentuemer_typ: location.eigentuemer_typ,
  };
  const { traeger, begruendung: traegerGrund } = waehleTraeger(faktoren);
  const kennzahlen = konzeptKennzahlen(faktoren, location.empfohlenes_modell ?? "keins");

  const eingabe = [
    locationKontext(location),
    "",
    "VERTRAGSPARTNER: " + (traeger === "kulturline"
      ? "der Verein KULTURLINE, mit der EVENTLINE GmbH als exklusivem operativem Partner"
      : "die EVENTLINE GmbH"),
    `Begründung (nicht wörtlich übernehmen): ${traegerGrund}`,
    "",
    kennzahlen
      ? [
          "BERECHNETE KENNZAHLEN (genau so verwenden, nichts umrechnen):",
          `- rund ${kennzahlen.tage_pro_jahr} Veranstaltungstage pro Jahr`,
          `- rund ${chf(kennzahlen.ort_chf_pro_jahr)} CHF pro Jahr für den Ort`,
          `- ${chf(kennzahlen.ort_chf_pro_tag)} CHF fixer Anteil pro Veranstaltungstag`,
          "TAGESANSÄTZE je Mieterkategorie (für Kapitel «Tarife»):",
          ...kennzahlen.tarife.map((t) => `- ${t.label}: ${chf(t.chf)} CHF pro Tag`),
          "Die Rechnung dahinter ist INTERN — nenne nie die Formel, nur die Beträge.",
        ].join("\n")
      : "KENNZAHLEN: keine rechenbar (Monatsmiete der Liegenschaft unbekannt) — " +
        "schreibe das Konzept ohne Beträge und markiere die Tarife als im Gespräch zu klären.",
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
    traeger,
    traeger_begruendung: traegerGrund,
    kennzahlen,
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
