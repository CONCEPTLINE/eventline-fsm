import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { sucheLocations, OverpassFehler } from "@/lib/overpass";
import { bewerteLocations, type ZuBewerten } from "@/lib/akquise-bewertung";

/**
 * Wie viele Kandidaten je Gebiet behalten werden.
 *
 * Bewusst klein: gesucht ist nicht die vollstaendige Liste aller Haeuser
 * einer Stadt, sondern die Handvoll, die man wirklich anruft. Alles
 * darunter waere Arbeit fuer jemanden, der aussortieren muss. Angepinnte
 * sind ausgenommen — was jemand von Hand markiert hat, bleibt.
 */
const PRO_GEBIET = 20;

// Overpass (~15s) plus die Bewertung aller neuen Kandidaten.
export const maxDuration = 300;

/**
 * POST /api/akquise/suchen  { gebiet: "Basel" }
 *
 * Drei Schritte in einem Aufruf, damit aus einer Eingabe eine fertige
 * Arbeitsliste wird statt einer Rohdatensammlung:
 *   1. Event-Locations aus OpenStreetMap holen (echte Orte und Adressen)
 *   2. die neuen davon bewerten lassen
 *   3. auf die besten PRO_GEBIET kuerzen — der Rest wird verworfen
 *
 * Idempotent: ein zweiter Lauf fuegt nur Neues hinzu, bestehende
 * Bewertungen, Anreicherungen und Pins bleiben unberuehrt.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:create");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const gebiet = typeof body.gebiet === "string" ? body.gebiet.trim() : "";
  if (!gebiet) {
    return NextResponse.json({ success: false, error: "Kein Gebiet angegeben" }, { status: 400 });
  }

  let kandidaten;
  try {
    kandidaten = await sucheLocations(gebiet);
  } catch (e) {
    // Overpass-Ausfaelle sind erwartbar (Rate-Limit, Wartung) — als 503
    // melden, damit die UI "nochmal versuchen" sagen kann statt "Fehler".
    if (e instanceof OverpassFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 503 });
    }
    throw e;
  }

  if (kandidaten.length === 0) {
    return NextResponse.json({
      success: true, gefunden: 0, neu: 0,
      hinweis: `Für «${gebiet}» hat OpenStreetMap keine Locations. Schreibweise prüfen (z. B. «Zürich» statt «Zuerich»).`,
    });
  }

  const supabase = await createClient();

  // Welche osm_ids kennen wir schon? Nur diese Teilmenge abfragen, nicht
  // die ganze Tabelle.
  const osmIds = kandidaten.map((k) => k.osm_id);
  const { data: bekannt } = await supabase
    .from("akquise_locations")
    .select("osm_id")
    .in("osm_id", osmIds);
  const schonDa = new Set((bekannt ?? []).map((r) => r.osm_id as string));

  const neue = kandidaten
    .filter((k) => !schonDa.has(k.osm_id))
    .map((k) => ({
      name: k.name,
      typ: k.typ,
      strasse: k.strasse,
      plz: k.plz,
      // OSM laesst addr:city oft leer — dann das Suchgebiet als Ort nehmen,
      // sonst verletzt die Zeile das NOT NULL und der ganze Insert fiele aus.
      ort: k.ort ?? gebiet,
      lat: k.lat,
      lng: k.lng,
      website: k.website,
      email: k.email,
      telefon: k.telefon,
      kapazitaet: k.kapazitaet,
      quelle: "osm" as const,
      osm_id: k.osm_id,
      recherchiert_am: new Date().toISOString(),
    }));

  if (neue.length > 0) {
    const { error } = await supabase
      .from("akquise_locations").insert(neue)
      .select("id, name, typ, strasse, ort, website, kapazitaet");
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  // --- 2. Bewerten ------------------------------------------------------
  // Alles was im Gebiet noch keinen Score hat, nicht nur das eben
  // Eingefuegte: ein abgebrochener Vorgang soll beim naechsten Lauf
  // aufgeraeumt werden.
  const { data: unbewertet } = await supabase
    .from("akquise_locations")
    .select("id, name, typ, strasse, ort, website, kapazitaet")
    .eq("ort", gebiet).is("score", null).limit(200);

  let bewertet = 0;
  const kiFehler: string[] = [];
  if (unbewertet?.length) {
    const r = await bewerteLocations(supabase, unbewertet as ZuBewerten[]);
    bewertet = r.bewertet;
    kiFehler.push(...r.fehler);
  }

  // --- 3. Auf die Besten kuerzen ---------------------------------------
  // Eine Suche = eine Stadt. Was aus einem frueheren Gebiet stammt, wird
  // verworfen — sonst mischen sich Basel und Thun in derselben Liste und
  // niemand sieht mehr, woran er gerade arbeitet. Angepinntes bleibt,
  // das hat jemand bewusst markiert.
  const { data: fremd } = await supabase
    .from("akquise_locations")
    .select("id")
    .neq("ort", gebiet)
    .is("angepinnt_am", null);
  let andereGebiete = 0;
  if (fremd?.length) {
    const { error } = await supabase
      .from("akquise_locations").delete().in("id", fremd.map((l) => l.id));
    if (!error) andereGebiete = fremd.length;
  }

  const { data: imGebiet } = await supabase
    .from("akquise_locations")
    .select("id, score, flaeche, angepinnt_am, website")
    .eq("ort", gebiet)
    .order("score", { ascending: false, nullsFirst: false });

  let verworfen = 0;
  if (imGebiet) {
    // Ohne Website ist ein Kandidat nicht anrufbar: kein Kontaktweg, keine
    // Recherche, kein Ansprechpartner. Bei gleicher Eignung gewinnt also
    // der mit Website — erst wenn die Plaetze nicht voll werden, kommen
    // die anderen dazu.
    const geeignet = imGebiet.filter((l) => l.flaeche !== "eigennutzung");
    const behalten = [
      ...geeignet.filter((l) => l.website),
      ...geeignet.filter((l) => !l.website),
    ].slice(0, PRO_GEBIET).map((l) => l.id);
    const weg = imGebiet
      // Angepinntes nie wegwerfen — das hat jemand bewusst markiert.
      .filter((l) => l.angepinnt_am === null && !behalten.includes(l.id))
      .map((l) => l.id);
    if (weg.length) {
      const { error } = await supabase.from("akquise_locations").delete().in("id", weg);
      if (!error) verworfen = weg.length;
    }
  }

  return NextResponse.json({
    success: true,
    gefunden: kandidaten.length,
    neu: neue.length,
    bewertet,
    verworfen,
    andere_gebiete: andereGebiete,
    behalten: Math.min(PRO_GEBIET, (imGebiet ?? []).filter((l) => l.flaeche !== "eigennutzung").length),
    ohne_website: (imGebiet ?? []).filter((l) => l.flaeche !== "eigennutzung" && !l.website).length,
    ...(kiFehler.length ? { fehler: kiFehler } : {}),
  });
}
