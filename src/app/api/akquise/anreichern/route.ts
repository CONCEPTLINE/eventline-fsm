import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { leseWebsite } from "@/lib/akquise-website";
import { frageKi, KiFehler } from "@/lib/akquise-ki";
import type { AkquiseLocation } from "@/types/akquise";

// Je Location bis zu drei Seitenabrufe plus ein KI-Aufruf.
export const maxDuration = 300;

const SYSTEM_PROMPT = `Du liest den Text einer Location-Website und ziehst daraus die Angaben, die die EVENTLINE GmbH für einen Erstkontakt braucht.

STRENGSTE REGEL: Übernimm NUR, was wörtlich im Text steht. Erfinde keinen Namen, keine E-Mail-Adresse, keine Telefonnummer, keine Funktion. Steht nichts da, gib null zurück — ein leeres Feld ist richtig, ein geratener Name macht den Kontakt unbrauchbar und blamiert den Absender.

Gib zurück:
- ansprechperson: Vor- und Nachname der Person, die für Raumvermietung, Betrieb oder Geschäftsführung zuständig ist. Stehen mehrere, nimm die für Vermietung/Betrieb zuständige; sonst die Geschäftsführung. Nur wenn ein Name dasteht, sonst null.
- position: Funktion dieser Person, wörtlich wie angegeben (z. B. "Geschäftsführerin", "Leiter Vermietung", "Betriebsleitung"). Sonst null.
- email: die für Anfragen oder Vermietung passende Adresse. Mehrere → die allgemeinste für Anfragen (info@, kontakt@, vermietung@). Nur wörtlich übernehmen, sonst null.
- telefon: Telefonnummer in der Schreibweise der Seite. Nur wörtlich, sonst null.
- vermietet_raeume: Sagt der Text, dass Räume an Dritte vermietet werden? "ja" wenn es dort steht (Mietangebot, Raumvermietung, "Räume mieten", Preisliste), "nein" wenn der Text klar macht, dass nur selbst genutzt wird, sonst "unklar".
- vermietung_hinweis: EIN kurzer Satz, was die Seite über die Vermietung sagt — welche Räume, an wen, wie gebucht. Nichts gefunden → null.
- eignung: "hoch" wenn die Seite zeigt, dass vermietet wird und der Betrieb dünn aussieht (kein Team genannt, Anfragen laufen über ein allgemeines Postfach, keine Technikangaben); "mittel" wenn vermietet wird, aber ein Team oder Angebot erkennbar ist; "gering" wenn die Seite zeigt, dass Vermarktung, Betreuung und Technik abgedeckt sind oder gar nicht vermietet wird.
- eignung_grund: EIN Satz, warum. Beziehe dich auf das, was auf der Seite steht.`;

const SCHEMA = {
  type: "object",
  properties: {
    ansprechperson: { type: ["string", "null"] },
    position: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    telefon: { type: ["string", "null"] },
    vermietet_raeume: { type: "string", enum: ["ja", "nein", "unklar"] },
    vermietung_hinweis: { type: ["string", "null"] },
    eignung: { type: "string", enum: ["hoch", "mittel", "gering"] },
    eignung_grund: { type: "string" },
  },
  required: ["ansprechperson", "position", "email", "telefon",
             "vermietet_raeume", "vermietung_hinweis", "eignung", "eignung_grund"],
  additionalProperties: false,
} as const;

interface WebBefund {
  ansprechperson: string | null;
  position: string | null;
  email: string | null;
  telefon: string | null;
  vermietet_raeume: "ja" | "nein" | "unklar";
  vermietung_hinweis: string | null;
  eignung: "hoch" | "mittel" | "gering";
  eignung_grund: string;
}

/**
 * POST /api/akquise/anreichern  { ids?: string[], limit?: number }
 *
 * Holt für die besten noch nicht angereicherten Kandidaten die Website
 * und zieht Ansprechperson und Kontakt daraus. Bestätigt dabei auch, ob
 * wirklich vermietet wird — die Website weiss das besser als die
 * Schätzung aus dem OSM-Typ.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const ids: string[] | null = Array.isArray(body.ids) ? body.ids : null;
  const limit = Math.min(Number(body.limit) || 20, 40);

  const supabase = await createClient();
  let query = supabase
    .from("akquise_locations")
    .select("id, name, ort, website, flaeche, score");
  query = ids
    ? query.in("id", ids)
    : query.is("angereichert_am", null).neq("flaeche", "eigennutzung")
           .not("website", "is", null)
           .order("score", { ascending: false, nullsFirst: false });

  const { data: kandidaten, error } = await query.limit(limit);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!kandidaten?.length) {
    return NextResponse.json({ success: true, angereichert: 0, hinweis: "Nichts anzureichern." });
  }

  let angereichert = 0, ohneBefund = 0;
  const ohneWebsite: string[] = [];

  for (const k of kandidaten as Pick<AkquiseLocation, "id"|"name"|"ort"|"website"|"flaeche"|"score">[]) {
    if (!k.website) { ohneWebsite.push(k.name); continue; }

    const seiten = await leseWebsite(k.website);
    if (seiten.length === 0) {
      // Website nicht erreichbar: Versuch vermerken, damit der nächste
      // Lauf sie nicht endlos erneut probiert.
      await supabase.from("akquise_locations")
        .update({ angereichert_am: new Date().toISOString() }).eq("id", k.id);
      ohneBefund++;
      continue;
    }

    let b: WebBefund;
    try {
      b = await frageKi<WebBefund>(
        SYSTEM_PROMPT,
        `Location: ${k.name}, ${k.ort}\n\n` +
          seiten.map((s) => `--- ${s.url} ---\n${s.text}`).join("\n\n"),
        SCHEMA,
      );
    } catch (e) {
      if (e instanceof KiFehler) { ohneBefund++; continue; }
      throw e;
    }

    // Die Website schlägt die Schätzung: sagt sie klar, dass vermietet
    // wird (oder eben nicht), korrigieren wir die Flächenart.
    const flaeche =
      b.vermietet_raeume === "ja" ? "vermietung"
      : b.vermietet_raeume === "nein" ? "eigennutzung"
      : k.flaeche;

    const patch: Record<string, unknown> = {
      flaeche,
      vermietung_hinweis: b.vermietung_hinweis,
      kontakt_quelle: seiten[0].url,
      angereichert_am: new Date().toISOString(),
    };
    // Leere Felder nicht über vorhandene Werte schreiben.
    if (b.ansprechperson) patch.ansprechperson = b.ansprechperson;
    if (b.position) patch.position = b.position;
    if (b.email) patch.email = b.email;
    if (b.telefon) patch.telefon = b.telefon;

    const { error: schreibFehler } = await supabase
      .from("akquise_locations").update(patch).eq("id", k.id);
    if (!schreibFehler) angereichert++;
  }

  return NextResponse.json({
    success: true,
    angereichert,
    ohne_befund: ohneBefund,
    ...(ohneWebsite.length ? { ohne_website: ohneWebsite } : {}),
  });
}
