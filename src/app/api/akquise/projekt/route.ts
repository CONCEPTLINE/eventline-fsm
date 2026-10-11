import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { KOOPERATIONS_MODELLE, waehleTraeger, konzeptKennzahlen, chf } from "@/lib/akquise-faktoren";
import type { AkquiseLocation } from "@/types/akquise";

/**
 * POST /api/akquise/projekt  { id, stunden? }
 *
 * Macht aus einem Akquise-Kandidaten ein Projekt — den internen
 * Zeit-Topf, auf den Gespraeche, Begehung und Konzeptarbeit gestempelt
 * werden.
 *
 * Die Beschreibung traegt die Rechercheergebnisse mit hinueber:
 * Ansprechpartner, Adresse, Modell, Kennzahlen. Wer spaeter das Projekt
 * oeffnet, soll nicht in die Akquise zurueckspringen muessen, um zu
 * wissen, worum es geht.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("projekte:create");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  // Vorschlag, keine Vorgabe: das verbindliche Budget setzt die
  // Genehmigung im Projekt selbst.
  const stunden = Number(body.stunden) > 0 ? Number(body.stunden) : 8;
  if (!id) return NextResponse.json({ success: false, error: "Keine id" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("akquise_locations").select("*").eq("id", id).single();
  if (error || !data) {
    return NextResponse.json({ success: false, error: "Location nicht gefunden" }, { status: 404 });
  }
  const l = data as AkquiseLocation;

  // Schon umgewandelt: das bestehende Projekt zurueckgeben statt ein
  // zweites anzulegen.
  if (l.projekt_id) {
    return NextResponse.json({ success: true, projekt_id: l.projekt_id, bestand: true });
  }

  const faktoren = {
    flaeche: l.flaeche,
    kapazitaet: l.kapazitaet,
    zeitfenster_frei: l.zeitfenster_frei,
    monatsmiete_chf: l.monatsmiete_chf,
    eigene_vermarktung: l.eigene_vermarktung,
    personal_vor_ort: l.personal_vor_ort,
    technik_vorhanden: l.technik_vorhanden,
    eigentuemer_typ: l.eigentuemer_typ,
  };
  const modell = KOOPERATIONS_MODELLE.find((m) => m.key === l.empfohlenes_modell);
  const { traeger } = waehleTraeger(faktoren);
  const kennzahlen = konzeptKennzahlen(faktoren, l.empfohlenes_modell ?? "keins");

  const adresse = [l.strasse, [l.plz, l.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const beschreibung = [
    `Akquise ${l.name}${adresse ? `, ${adresse}` : ""}`,
    "",
    modell ? `Modell: ${modell.label} — ${modell.kurz}` : null,
    `Vertragspartner: ${traeger === "kulturline" ? "Verein KULTURLINE" : "EVENTLINE GmbH"}`,
    l.prioritaet ? `Priorität ${l.prioritaet} (Score ${l.score ?? "—"})` : null,
    "",
    l.ansprechperson
      ? `Ansprechperson: ${l.ansprechperson}${l.position ? `, ${l.position}` : ""}`
      : "Ansprechperson: noch offen",
    [l.email, l.telefon].filter(Boolean).join(" · ") || null,
    l.website,
    "",
    kennzahlen
      ? `Rechnung: rund ${kennzahlen.tage_pro_jahr} Veranstaltungstage, ` +
        `${chf(kennzahlen.ort_chf_pro_jahr)} CHF/Jahr für den Ort ` +
        `(${chf(kennzahlen.ort_chf_pro_tag)} CHF pro Tag).`
      : "Tarife noch nicht rechenbar — Monatsmiete der Liegenschaft fehlt.",
    l.bewertung?.begruendung ?? null,
  ].filter((z) => z !== null).join("\n");

  const { data: projekt, error: anlegeFehler } = await supabase
    .from("projects")
    .insert({
      title: `Akquise: ${l.name}`,
      description: beschreibung,
      proposed_hours: stunden,
      assigned_to: auth.effectiveUserId,
      created_by: auth.effectiveUserId,
      goal_text: modell
        ? `${modell.label} mit ${l.name} vereinbaren`
        : `Kooperation mit ${l.name} klären`,
    })
    .select("id, project_number")
    .single();

  if (anlegeFehler || !projekt) {
    return NextResponse.json(
      { success: false, error: anlegeFehler?.message ?? "Projekt konnte nicht angelegt werden" },
      { status: 500 },
    );
  }

  // Verknüpfen — und anpinnen, denn ein verfolgter Kandidat soll nicht
  // bei der nächsten Suche weggeräumt werden.
  await supabase.from("akquise_locations")
    .update({
      projekt_id: projekt.id,
      angepinnt_am: l.angepinnt_am ?? new Date().toISOString(),
      angepinnt_von: l.angepinnt_von ?? auth.effectiveUserId,
    })
    .eq("id", id);

  return NextResponse.json({
    success: true,
    projekt_id: projekt.id,
    projekt_nummer: projekt.project_number,
  });
}
