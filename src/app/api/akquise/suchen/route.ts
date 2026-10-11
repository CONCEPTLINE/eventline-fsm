import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { sucheImNetz, pruefeWebsites } from "@/lib/akquise-websuche";
import { geocodeAddress } from "@/lib/geocode";
import { KiFehler } from "@/lib/akquise-ki";

/**
 * Wie viele Kandidaten je Gebiet behalten werden.
 *
 * Bewusst klein: gesucht ist nicht die vollstaendige Liste aller Haeuser
 * einer Stadt, sondern die Handvoll, die man wirklich anruft. Angepinnte
 * sind ausgenommen — was jemand von Hand markiert hat, bleibt.
 */
const PRO_GEBIET = 20;

// Websuche (~2 min) plus das Lesen der gefundenen Websites.
export const maxDuration = 300;

/**
 * POST /api/akquise/suchen  { gebiet: "Basel" | "Kanton Aargau" | "Thun" }
 *
 * Aus einer Ortseingabe wird eine fertige Arbeitsliste:
 *   1. im Netz nach Haeusern suchen, die ihre Raeume VERMIETEN
 *   2. die genannten Websites abrufen — was nicht antwortet, verliert sie
 *   3. verorten und speichern, Dubletten uebergehen, fremde Gebiete raeumen
 *   4. die Websites lesen: Ansprechpartner, Team, Raeume, Struktur —
 *      daraus die Faktoren und die Bewertung
 *
 * Die Quelle ist bewusst die Websuche und nicht OpenStreetMap: OSM kennt
 * Clubs, Tanzschulen und Hotels ohne Saal, aber nicht die Halle, die
 * tatsaechlich vermietet wird. Wer vermietet, will gefunden werden und
 * steht im Netz. Erfundene Adressen kann es trotzdem nicht geben —
 * Schritt 2 prueft jede URL.
 *
 * Idempotent: ein zweiter Lauf ergaenzt nur, bestehende Recherchen und
 * Pins bleiben.
 */

export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:create");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const gebiet = typeof body.gebiet === "string" ? body.gebiet.trim() : "";
  if (!gebiet) {
    return NextResponse.json({ success: false, error: "Kein Gebiet angegeben" }, { status: 400 });
  }

  // --- 1. Im Netz suchen ------------------------------------------------
  let gefunden;
  try {
    gefunden = await sucheImNetz(gebiet, PRO_GEBIET + 5);
  } catch (e) {
    if (e instanceof KiFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 502 });
    }
    throw e;
  }

  if (gefunden.length === 0) {
    return NextResponse.json({
      success: true, gefunden: 0, neu: 0,
      hinweis: `Für «${gebiet}» wurden keine Locations gefunden, die Räume vermieten. ` +
        `Schreibweise prüfen oder eine grössere Region angeben (z. B. den Kanton).`,
    });
  }

  // --- 2. Websites pruefen ---------------------------------------------
  const kandidaten = await pruefeWebsites(gefunden);

  // --- 3. Speichern -----------------------------------------------------
  const supabase = await createClient();

  // Eine Suche = eine Stadt. Was aus einem frueheren Gebiet stammt, wird
  // verworfen — sonst mischen sich Basel und Thun in derselben Liste.
  const { data: fremd } = await supabase
    .from("akquise_locations").select("id").neq("ort", gebiet).is("angepinnt_am", null);
  let andereGebiete = 0;
  if (fremd?.length) {
    const { error } = await supabase
      .from("akquise_locations").delete().in("id", fremd.map((l) => l.id));
    if (!error) andereGebiete = fremd.length;
  }

  // Dubletten gegen den Bestand: gleicher Name am gleichen Ort.
  const { data: bekannt } = await supabase
    .from("akquise_locations").select("name").eq("ort", gebiet);
  const schonDa = new Set((bekannt ?? []).map((r) => (r.name as string).toLowerCase()));

  const neue = kandidaten
    .filter((k) => !schonDa.has(k.name.toLowerCase()))
    .slice(0, PRO_GEBIET)
    .map((k) => ({
      name: k.name,
      typ: k.typ,
      strasse: k.strasse,
      // Der eingegebene Ort ist die Suchachse — die Angabe des Modells
      // kann abweichen (Stadtteil, Schreibweise) und wuerde das Raeumen
      // beim naechsten Gebietswechsel aushebeln.
      ort: gebiet,
      website: k.website,
      // Die Websuche findet nur Vermieter — das ist der Zweck der Abfrage.
      flaeche: "vermietung" as const,
      quelle: "ki" as const,
      lat: null as number | null,
      lng: null as number | null,
      recherchiert_am: new Date().toISOString(),
      notizen: k.warum,
    }));

  // Koordinaten gleich hier holen, nicht erst beim Nachladen der
  // Details: sonst steht die Karte minutenlang leer, obwohl die Treffer
  // schon da sind. Nominatim erlaubt eine Abfrage pro Sekunde — bei
  // zwanzig Häusern also rund zwanzig Sekunden, das ist vertretbar.
  for (const n of neue) {
    const punkt = await geocodeAddress(n.strasse, null, n.ort);
    if (punkt) { n.lat = punkt.lat; n.lng = punkt.lng; }
    await new Promise((r) => setTimeout(r, 1100));
  }

  if (neue.length > 0) {
    const { error } = await supabase.from("akquise_locations").insert(neue);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    success: true,
    gefunden: gefunden.length,
    neu: neue.length,
    ohne_website: kandidaten.filter((k) => !k.website).length,
    andere_gebiete: andereGebiete,
  });
}
