// Server-Helfer der Technik-Planung (nur in API-Routen importieren).
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";

/** Auth-Gate fuer Lieferantenportal-Routen: eingeloggter, aktiver
 *  Portal-User mit Firma (Impersonation via effectiveUserId inklusive). */
export async function requireLieferantPortal(): Promise<
  | { error: NextResponse }
  | { error: null; admin: SupabaseClient; userId: string; lieferantId: string; userName: string | null }
> {
  const auth = await requireUser();
  if (auth.error) return { error: auth.error };
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, lieferant_id, is_active, full_name")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (!profile || profile.is_active === false || profile.role !== "lieferant" || !profile.lieferant_id) {
    return { error: NextResponse.json({ success: false, error: "Kein Zugriff" }, { status: 403 }) };
  }
  return {
    error: null,
    admin,
    userId: auth.effectiveUserId,
    lieferantId: profile.lieferant_id as string,
    userName: (profile.full_name as string | null) ?? null,
  };
}

/** Aktivitaets-Eintrag schreiben — Fehler nie werfen (Aktivitaet ist
 *  Protokoll, nicht Fachlogik). */
export async function logTechnik(
  admin: SupabaseClient,
  jobId: string,
  actor: { id: string | null; name: string | null },
  aktion: string,
  beschreibung: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("job_technik_aktivitaet").insert({
    job_id: jobId,
    actor_id: actor.id,
    actor_name: actor.name,
    aktion,
    beschreibung,
    meta: meta ?? null,
  });
  if (error) logError("technik.aktivitaet", error, { jobId, aktion });
}

/** Anzeigename eines Users (fuer Aktivitaet/Kommentare). */
export async function actorName(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("full_name").eq("id", userId).maybeSingle();
  return (data?.full_name as string | undefined) ?? null;
}

/** Aktive Portal-User eines Lieferanten (Notification-Empfaenger). */
export async function lieferantPortalUserIds(admin: SupabaseClient, lieferantId: string): Promise<string[]> {
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "lieferant")
    .eq("lieferant_id", lieferantId)
    .eq("is_active", true);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/** Der dem Auftrag zugewiesene Lieferant (v1: genau einer). */
export async function zugewiesenerLieferant(
  admin: SupabaseClient,
  jobId: string,
): Promise<{ zuweisungId: string; lieferantId: string; name: string; angefragtAt: string | null } | null> {
  const { data } = await admin
    .from("job_lieferanten")
    .select("id, lieferant_id, angefragt_at, lieferant:lieferanten(name)")
    .eq("job_id", jobId)
    .maybeSingle();
  if (!data) return null;
  const lief = Array.isArray(data.lieferant) ? data.lieferant[0] : data.lieferant;
  return {
    zuweisungId: data.id as string,
    lieferantId: data.lieferant_id as string,
    name: (lief as { name?: string } | null)?.name ?? "Lieferant",
    angefragtAt: (data.angefragt_at as string | null) ?? null,
  };
}

/** Datum-Text fuer Mails/Notifications (Europe/Zurich). */
export function jobDatumText(start: string | null, end: string | null): string {
  if (!start) return "";
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
  const s = fmt(start);
  if (!end || fmt(end) === s) return s;
  return `${s} – ${fmt(end)}`;
}
