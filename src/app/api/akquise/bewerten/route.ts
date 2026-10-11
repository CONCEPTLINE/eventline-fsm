import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { bewerte, type Dreiwertig, type EigentuemerTyp } from "@/lib/akquise-faktoren";

// Mehrere Locations in einem Durchgang — das dauert.
export const maxDuration = 180;

const MODEL = "claude-opus-5-5";
/**
 * Locations pro Anfrage. Gross genug, dass der System-Prompt sich lohnt,
 * klein genug, dass ein Fehlschlag nicht die ganze Suche kostet.
 */
const BLOCK = 20;

// ───────────────────────────────────────────────────────────────────────────
// EINORDNUNGS-PROMPT — hier steuerst du, wie die KI Locations einschaetzt.
// Sie liefert NUR Fakten-Schaetzungen; den Score und die Rentabilitaet
// rechnet akquise-faktoren.ts daraus deterministisch.
// ───────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Du unterstützt die EVENTLINE GmbH (Basel) bei der Akquise von Kooperations-Locations in der Schweiz.

EVENTLINE bietet fremden Locations vier Modelle an:
- Vermietungsmanagement: EVENTLINE vermarktet und bucht die Räume.
- Vermietung + Betreuung: dazu Betreuung vor Ort am Eventtag.
- Location-Betreuung: nur Betrieb vor Ort (so läuft es im Barakuba Basel).
- Technikpartner: nur Licht, Ton, Aufbau.

Der Hebel ist immer das, was der Location FEHLT. Deine Aufgabe ist deshalb, pro Location vier Dinge einzuschätzen:

1. kapazitaet — Personen, die in den grössten Raum passen. Schätze aus Art und Grösse des Hauses. Ein Stadtcasino oder eine Messehalle liegt im vierstelligen Bereich, ein Quartier-Gemeinschaftszentrum bei 80–150, ein Kellerclub bei 100–250. Gib die Zahl, nicht eine Spanne.
2. eigentuemer_typ — "corporate" (Firma), "immobilien" (Verwaltung/Eigentümer), "kultur" (Theater, Kulturbetrieb, Verein), "oeffentlich" (Stadt, Kanton, Gemeinde, Kirche), "gastro" (Hotel, Restaurant), "unbekannt".
3. eigene_vermarktung — Vermietet das Haus seine Räume selbst aktiv (eigene Website mit Mietangebot, eigenes Booking)? "ja" / "nein" / "unklar".
4. personal_vor_ort — Gibt es festes Betriebspersonal (Hauswart, Technik, Eventteam)? "ja" / "nein" / "unklar".
5. technik_vorhanden — Ist eine fest installierte Veranstaltungstechnik (Licht/Ton) zu erwarten? "ja" / "nein" / "unklar".

REGELN:
- Nutze NUR Allgemeinwissen über das genannte Haus. Erfinde keine Adressen, keine Kontaktdaten, keine Zahlen zu Umsatz oder Auslastung.
- Kennst du ein Haus nicht, schätze konservativ aus Typ und Ortsgrösse und setze die drei Ja/Nein-Felder auf "unklar".
- "unklar" ist eine korrekte, erwünschte Antwort. Rate nicht ins Blaue.
- begruendung: ein kurzer Satz, warum du so einschätzt. Nenne, worauf du dich stützt (bekanntes Haus / aus dem Typ geschlossen).
- Theater, Clubs und Kulturbetriebe haben meist eigenes Personal und eigene Technik — der Hebel liegt dort selten.
- Hotels und Gasthöfe haben Personal, aber selten eigene Veranstaltungstechnik.

Gib für JEDE Location der Liste genau einen Eintrag zurück, in derselben Reihenfolge, mit derselben id.`;

const SCHEMA = {
  type: "object",
  properties: {
    bewertungen: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Die id aus der Eingabe, unverändert" },
          kapazitaet: { type: "integer", description: "Geschätzte Personen im grössten Raum" },
          eigentuemer_typ: {
            type: "string",
            enum: ["corporate", "immobilien", "kultur", "oeffentlich", "gastro", "unbekannt"],
          },
          eigene_vermarktung: { type: "string", enum: ["ja", "nein", "unklar"] },
          personal_vor_ort: { type: "string", enum: ["ja", "nein", "unklar"] },
          technik_vorhanden: { type: "string", enum: ["ja", "nein", "unklar"] },
          begruendung: { type: "string" },
        },
        required: [
          "id", "kapazitaet", "eigentuemer_typ",
          "eigene_vermarktung", "personal_vor_ort", "technik_vorhanden", "begruendung",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["bewertungen"],
  additionalProperties: false,
} as const;

interface KiBewertung {
  id: string;
  kapazitaet: number;
  eigentuemer_typ: EigentuemerTyp;
  eigene_vermarktung: Dreiwertig;
  personal_vor_ort: Dreiwertig;
  technik_vorhanden: Dreiwertig;
  begruendung: string;
}

/**
 * POST /api/akquise/bewerten  { ids?: string[] }
 *
 * Ohne ids: alle noch unbewerteten Kandidaten. Die KI schaetzt die Fakten,
 * `bewerte()` rechnet daraus Modell, Rentabilitaet und Score — die Zahlen
 * entstehen also deterministisch im Code, nicht im Sprachmodell.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { success: false, error: "ANTHROPIC_API_KEY ist nicht gesetzt" },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const ids: string[] | null = Array.isArray(body.ids) ? body.ids : null;

  const supabase = await createClient();
  let query = supabase
    .from("akquise_locations")
    .select("id, name, typ, strasse, plz, ort, website, kapazitaet");
  query = ids ? query.in("id", ids) : query.is("score", null);
  const { data: offen, error: ladeFehler } = await query.limit(200);

  if (ladeFehler) {
    return NextResponse.json({ success: false, error: ladeFehler.message }, { status: 500 });
  }
  if (!offen || offen.length === 0) {
    return NextResponse.json({ success: true, bewertet: 0, hinweis: "Nichts zu bewerten." });
  }

  const client = new Anthropic();
  let bewertet = 0;
  const fehler: string[] = [];

  for (let i = 0; i < offen.length; i += BLOCK) {
    const block = offen.slice(i, i + BLOCK);
    const eingabe = block.map((l) => ({
      id: l.id,
      name: l.name,
      typ: l.typ,
      ort: l.ort,
      adresse: l.strasse,
      website: l.website,
      kapazitaet_aus_osm: l.kapazitaet,
    }));

    let ergebnis: { bewertungen: KiBewertung[] } | null = null;
    try {
      const antwort = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: { format: jsonSchemaOutputFormat(SCHEMA) },
        messages: [{ role: "user", content: JSON.stringify(eingabe, null, 1) }],
      });
      // Sicherheitsklassifikatoren koennen ablehnen — vor content pruefen.
      if (antwort.stop_reason === "refusal") {
        fehler.push(`Block ${i / BLOCK + 1}: von der KI abgelehnt`);
        continue;
      }
      ergebnis = antwort.parsed_output as { bewertungen: KiBewertung[] } | null;
    } catch (e) {
      fehler.push(`Block ${i / BLOCK + 1}: ${e instanceof Error ? e.message : "KI-Fehler"}`);
      continue;
    }

    if (!ergebnis?.bewertungen) {
      fehler.push(`Block ${i / BLOCK + 1}: unlesbare Antwort`);
      continue;
    }

    for (const b of ergebnis.bewertungen) {
      // Die KI darf sich in der id vertippen — nur echte Treffer schreiben.
      if (!block.some((l) => l.id === b.id)) continue;

      const faktoren = {
        kapazitaet: Number.isFinite(b.kapazitaet) && b.kapazitaet > 0 ? b.kapazitaet : null,
        eigene_vermarktung: b.eigene_vermarktung,
        personal_vor_ort: b.personal_vor_ort,
        technik_vorhanden: b.technik_vorhanden,
        eigentuemer_typ: b.eigentuemer_typ,
      };
      const b2 = bewerte(faktoren);

      const { error } = await supabase
        .from("akquise_locations")
        .update({
          kapazitaet: faktoren.kapazitaet,
          eigentuemer_typ: faktoren.eigentuemer_typ,
          eigene_vermarktung: faktoren.eigene_vermarktung,
          personal_vor_ort: faktoren.personal_vor_ort,
          technik_vorhanden: faktoren.technik_vorhanden,
          empfohlenes_modell: b2.modell,
          rentabilitaet_chf: b2.rentabilitaet_chf,
          score: b2.score,
          bewertung: {
            begruendung: b2.begruendung,
            ki_einschaetzung: b.begruendung,
            teilscores: b2.teilscores,
            annahmen: b2.annahmen,
            alternativen: b2.alternativen,
            modell: MODEL,
            bewertet_am: new Date().toISOString(),
          },
        })
        .eq("id", b.id);
      if (!error) bewertet++;
    }
  }

  return NextResponse.json({
    success: true,
    bewertet,
    offen: offen.length - bewertet,
    ...(fehler.length > 0 ? { fehler } : {}),
  });
}
