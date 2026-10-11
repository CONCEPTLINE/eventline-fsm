import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { bewerte, type Dreiwertig, type EigentuemerTyp, type FlaechenArt } from "@/lib/akquise-faktoren";

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
const SYSTEM_PROMPT = `Du hilfst der EVENTLINE GmbH (Basel), unter vielen Locations die WENIGEN zu finden, die tatsächlich Kunde werden können. Qualität vor Menge: ein übersehener Kandidat kostet weniger als eine Liste voller Fehltreffer, die jemand von Hand aussortieren muss.

WAS EVENTLINE ANBIETET:
EVENTLINE übernimmt den Betrieb FREMDER Räumlichkeiten. Der Kunde ist ein Eigentümer oder Betreiber einer Fläche, die vermietet wird oder werden soll, der den Betrieb aber nicht selbst machen will oder kann. EVENTLINE ist dann die zentrale Schnittstelle zwischen Mietern und Dienstleistern. Vier Modelle, je nachdem was fehlt: Vermietungsmanagement (wir vermarkten und buchen) / Vermietung + Betreuung / nur Betreuung vor Ort (so läuft es im Barakuba Basel) / nur Technikpartner.

DIE ENTSCHEIDENDE FRAGE ZUERST — wofür ist die Fläche da?
- "vermietung": Die Räume werden an Dritte vermietet, das ist der Zweck des Hauses. Beispiele: Eventlocation, Mehrzweckhalle, Saal eines Vereins oder einer Stiftung, umgenutzte Industriefläche, Gemeindesaal, Kongresszentrum.
- "nebenbei": Ein Betrieb mit eigenem Zweck, der einen Saal oder Raum ZUSÄTZLICH vermietet. Beispiele: Hotel mit Bankettsaal, Restaurant mit Séparée, Museum mit Eventraum.
- "eigennutzung": Nutzt die Fläche selbst und vermietet sie nicht. **Das ist KEIN Kunde.** Beispiele: Tanzschule (unterrichtet dort), Club oder Bar (bespielt sich selbst), Kino, Fitnessstudio, Theater mit eigenem Ensemble und eigenem Spielplan, Apartmenthotel ohne Veranstaltungsraum, Restaurant ohne Saal, Kirche im laufenden Gottesdienstbetrieb.
- "unklar": Du kannst es nicht beurteilen.

Sei hier STRENG. Im Zweifel "eigennutzung" oder "unklar" statt "vermietung". Eine Tanzschule, der die Vermarktung fehlt, ist trotzdem kein Kunde — ihr fehlt nichts, sie will schlicht nicht vermieten.

DANN die weiteren Felder:
- kapazitaet: Personen im grössten Raum. Schätze aus Art und Grösse. Messehalle/Konzerthaus vierstellig, Mehrzwecksaal 150–400, Quartierzentrum 80–150, Bankettsaal eines Stadthotels 40–120. Hat ein Haus gar keinen Veranstaltungsraum, schätze klein (unter 30) — das sortiert es von selbst aus.
- eigentuemer_typ: "immobilien" (Verwaltung/Eigentümer einer Fläche — der beste Zugang), "corporate" (Firma), "gastro" (Hotel, Restaurant), "kultur" (Kulturbetrieb, Verein), "oeffentlich" (Stadt, Kanton, Gemeinde, Kirche — läuft über Ausschreibung), "unbekannt".
- eigene_vermarktung: Vermietet das Haus seine Räume selbst aktiv (eigene Mietseite, eigenes Booking)? "ja"/"nein"/"unklar".
- personal_vor_ort: Festes Betriebspersonal für Veranstaltungen (Hauswart, Technik, Eventteam)? "ja"/"nein"/"unklar".
- technik_vorhanden: Fest installierte Veranstaltungstechnik (Licht/Ton) zu erwarten? "ja"/"nein"/"unklar".
- begruendung: EIN Satz. Sag zuerst, wofür die Fläche da ist und warum, dann wo der Hebel liegt — oder warum es keinen gibt. Stütze dich auf das, was du über das Haus weisst; kennst du es nicht, sag das.

REGELN:
- Nur Allgemeinwissen über das genannte Haus nutzen. Nichts erfinden: keine Adressen, keine Kontakte, keine Umsatz- oder Auslastungszahlen.
- Kennst du ein Haus nicht, schliesse vorsichtig aus Typ und Ortsgrösse und setze die Ja/Nein-Felder auf "unklar".
- "unklar" ist eine richtige Antwort. Rate nicht ins Blaue.
- Clubs, Bars und Theater mit eigenem Spielplan haben fast immer eigenes Personal UND eigene Technik — dort liegt selten ein Hebel.
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
          flaeche: {
            type: "string",
            enum: ["vermietung", "nebenbei", "eigennutzung", "unklar"],
            description: "Wofür die Fläche da ist — das entscheidende Feld",
          },
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
          "id", "flaeche", "kapazitaet", "eigentuemer_typ",
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
  flaeche: FlaechenArt;
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
        flaeche: b.flaeche,
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
          flaeche: faktoren.flaeche,
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
