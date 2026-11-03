// GET /api/standorte/[id]/belegungsplan?start=ISO&end=ISO — interner
// Belegungsplan eines Standorts (Recht locations:view, Admin immer).
//
// Antwort { success, eintraege: KalenderEintrag[], darfEintragen }
// (src/lib/standort-kalender.ts): alle nicht geloeschten, nicht stornierten
// Auftraege am Standort — «anfrage», wenn aus einer Partner-Anfrage
// entstanden, sonst «auftrag», Link /auftraege/<id> — plus die eigenen
// Termine des Standorts (standort_termine). darfEintragen = Standort hat
// den Kalender (partner_kalender) UND locations:edit.
//
// Auftraege, Termin-Zuteilungen und Standort-Termine laufen ueber den RLS-
// Client des Nutzers: wer Auftraege nicht sehen darf (jobs_select), sieht
// sie auch hier nicht. Nur Personen-Namen und die Partner-Konten des
// Standorts (fuer die Regel «Partner-Anfrage») kommen vom Admin-Client.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { interneNamen } from "@/lib/partner-portal-server";
import {
  internKalenderEintraege,
  istIsoDatum,
  kalenderJobsLaden,
  kalenderSortieren,
  kalenderTermineLaden,
  kalenderZuteilungenLaden,
  terminKalenderEintraege,
} from "@/lib/standort-kalender";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

const fehler = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("locations:view");
  if (auth.error) return auth.error;
  const { id: roh } = await params;
  if (!isUuid(roh)) return fehler("Ungültige ID", 400);
  const standortId = roh.toLowerCase();

  const start = req.nextUrl.searchParams.get("start");
  const end = req.nextUrl.searchParams.get("end");
  // start/end landen im .or()-Filter — nur echte ISO-Daten zulassen.
  if (!istIsoDatum(start) || !istIsoDatum(end)) return fehler("start und end muessen ISO-Daten sein", 400);

  try {
    const supabase = await createClient();
    const admin = createAdminClient();
    const [standortRes, rechtRes] = await Promise.all([
      supabase.from("locations").select("id, partner_kalender").eq("id", standortId).maybeSingle(),
      supabase.rpc("has_permission", { perm: "locations:edit" }),
    ]);
    if (standortRes.error) throw standortRes.error;
    if (rechtRes.error) throw rechtRes.error;
    if (!standortRes.data) return fehler("Standort nicht gefunden", 404);
    const kalender = (standortRes.data as { partner_kalender: boolean | null }).partner_kalender === true;
    const darfBearbeiten = rechtRes.data === true;
    const darfEintragen = kalender && darfBearbeiten;

    const [jobs, termine, partnerRes] = await Promise.all([
      kalenderJobsLaden(supabase, standortId, start, end),
      kalenderTermineLaden(supabase, standortId, start, end),
      admin.from("profiles").select("id, partner_location_id").eq("role", "partner"),
    ]);
    if (partnerRes.error) throw partnerRes.error;
    const partnerKonten = (partnerRes.data ?? []) as { id: string; partner_location_id: string | null }[];
    const partnerTeam = {
      standortId,
      teamIds: partnerKonten.filter((p) => p.partner_location_id === standortId).map((p) => p.id),
      fremdePartnerIds: partnerKonten.filter((p) => p.partner_location_id !== standortId).map((p) => p.id),
    };

    const sichtbar = jobs.filter((j) => j.status !== "storniert").map((j) => j.id);
    const zuteilungen = await kalenderZuteilungenLaden(supabase, sichtbar);
    const namen = await interneNamen(admin, zuteilungen.map((t) => t.assigned_to));

    const eintraege = kalenderSortieren([
      ...internKalenderEintraege(jobs, partnerTeam, zuteilungen, namen),
      ...terminKalenderEintraege(termine, darfBearbeiten),
    ]);
    return NextResponse.json({ success: true, eintraege, darfEintragen });
  } catch (e) {
    logError("api.standorte.belegungsplan", e, { standortId });
    return fehler("Belegungsplan konnte nicht geladen werden", 500);
  }
}
