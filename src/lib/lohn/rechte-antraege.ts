// Vier Augen bei Rechten (Lohn-Umbau Phase 1, Strohmann-Schutz, Migration 359).
//
// Admin-Rolle vergeben/entziehen, eine Rolle mit Lohnrecht vergeben/entziehen,
// das Lohnrecht einer Rolle ändern und die Vertretung ändern gehen nur als
// ANTRAG. Bestätigen kann nur der ANDERE Admin (nicht der Antragsteller, bei
// Gewährung nicht die Zielperson), auf einem vertrauten Gerät, innerhalb von
// 24 h (/api/admin/rechte-antraege, Seite /rechte-antraege). Ausgeführt wird
// in der DB-Funktion rechte_antrag_ausfuehren — die Trigger auf profiles,
// roles und lohn_einstellungen lassen die Änderung nur dort zu.
// Notweg: scripts/rechte-notfreigabe.mjs (Mischa, protokolliert).

import type { SupabaseClient } from "@supabase/supabase-js";
import { logPermissionAudit } from "@/lib/permission-audit";
import { notifySystem } from "@/lib/notification-service";
import { logError } from "@/lib/log";

export const LOHN_PERMISSION = "lohn:manage";

export type RechteAntragArt = "person" | "rolle_rechte" | "vertretung";

/** Hinweis für die UI nach dem Stellen eines Antrags. */
export const ANTRAG_HINWEIS =
  "Beantragt — wird erst wirksam, wenn der andere Admin innerhalb von 24 h auf einem vertrauten Gerät bestätigt (Vier Augen).";

/** Spiegel von public.rolle_oeffnet_lohn(slug, permissions). */
export function oeffnetLohn(slug: string, permissions: unknown): boolean {
  return slug === "admin" || (Array.isArray(permissions) && (permissions as unknown[]).includes(LOHN_PERMISSION));
}

export async function rolleOeffnetLohn(admin: SupabaseClient, slug: string): Promise<boolean> {
  if (slug === "admin") return true;
  const { data, error } = await admin.from("roles").select("slug, permissions").eq("slug", slug).maybeSingle();
  if (error) throw new Error(`Rolle konnte nicht geladen werden: ${error.message}`);
  return data ? oeffnetLohn(data.slug as string, data.permissions) : false;
}

/** Braucht diese Personen-Änderung einen Antrag? Gleiche Regel wie der
 *  DB-Trigger profiles_lohn_rechte_schutz: Admin-Status oder Lohnzugang
 *  ändert sich (nur Deaktivieren ohne Rollenwechsel ist frei). */
export function personBrauchtAntrag(a: {
  altRolle: string;
  neuRolle: string;
  altAktiv: boolean;
  neuAktiv: boolean;
  altOeffnet: boolean;
  neuOeffnet: boolean;
}): { noetig: boolean; gewaehrt: boolean } {
  if (a.altRolle === a.neuRolle && a.altAktiv && !a.neuAktiv) return { noetig: false, gewaehrt: false };
  const altAdmin = a.altAktiv && a.altRolle === "admin";
  const neuAdmin = a.neuAktiv && a.neuRolle === "admin";
  const altLohn = a.altAktiv && a.altOeffnet;
  const neuLohn = a.neuAktiv && a.neuOeffnet;
  const noetig = altAdmin !== neuAdmin || altLohn !== neuLohn;
  return { noetig, gewaehrt: (neuAdmin && !altAdmin) || (neuLohn && !altLohn) };
}

export interface AntragInput {
  art: RechteAntragArt;
  zielProfileId?: string | null;
  zielName?: string | null;
  zielRolle?: string | null;
  payload: Record<string, unknown>;
  beschreibung: string;
  gewaehrt: boolean;
  actorId: string;
  actorName: string | null;
}

/** Antrag speichern, protokollieren und die anderen Admins benachrichtigen.
 *  Gibt es schon einen offenen Antrag für dasselbe Ziel, wird er nicht
 *  verdoppelt (Fehler mit Hinweis). */
export async function stelleRechteAntrag(admin: SupabaseClient, i: AntragInput): Promise<{ id: string; gueltig_bis: string }> {
  let q = admin
    .from("rechte_antraege")
    .select("id")
    .eq("status", "offen")
    .eq("art", i.art)
    .gt("gueltig_bis", new Date().toISOString())
    .limit(1);
  // Je Person bzw. Rolle höchstens ein offener Antrag; Vertretung nur einer insgesamt.
  if (i.art === "person" && i.zielProfileId) q = q.eq("ziel_profile_id", i.zielProfileId);
  if (i.art === "rolle_rechte" && i.zielRolle) q = q.eq("ziel_rolle", i.zielRolle);
  const { data: offen, error: offenErr } = await q.maybeSingle();
  if (offenErr) throw new Error(offenErr.message);
  if (offen) throw new Error("Dafür ist schon ein Antrag offen — erst bestätigen oder ablehnen lassen (Rechte-Anträge).");

  // Lohnrecht an eine Rolle: festhalten, WEN das betrifft. Die DB-Funktion
  // lehnt ab, wenn sich die Personen der Rolle bis zur Bestaetigung aendern
  // (sonst liesse sich jemand vorher in die Rolle setzen).
  let payload = i.payload;
  let beschreibung = i.beschreibung;
  if (i.art === "rolle_rechte" && i.gewaehrt && i.zielRolle) {
    const { data: mitglieder, error: mErr } = await admin
      .from("profiles")
      .select("id, full_name, is_active")
      .eq("role", i.zielRolle);
    if (mErr) throw new Error(mErr.message);
    const aktiv = ((mitglieder ?? []) as { id: string; full_name: string | null; is_active: boolean | null }[]).filter((m) => m.is_active === true);
    payload = { ...payload, mitglieder: aktiv.map((m) => ({ id: m.id, name: m.full_name })) };
    beschreibung = `${beschreibung} — betrifft ${aktiv.length === 0 ? "niemanden" : aktiv.map((m) => m.full_name ?? m.id).join(", ")}`;
  }

  const { data, error } = await admin
    .from("rechte_antraege")
    .insert({
      art: i.art,
      ziel_profile_id: i.zielProfileId ?? null,
      ziel_name: i.zielName ?? null,
      ziel_rolle: i.zielRolle ?? null,
      payload,
      beschreibung,
      gewaehrt: i.gewaehrt,
      beantragt_von: i.actorId,
      beantragt_von_name: i.actorName,
    })
    .select("id, gueltig_bis")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Antrag konnte nicht gespeichert werden");

  await logPermissionAudit({
    actor_profile_id: i.actorId,
    action: "rechte.antrag_gestellt",
    ...(i.zielProfileId ? { target_profile_id: i.zielProfileId } : { target_role_slug: i.zielRolle ?? "lohn_einstellungen" }),
    details: { antrag_id: data.id, art: i.art, beschreibung, payload },
  } as Parameters<typeof logPermissionAudit>[0]);

  try {
    const { data: admins, error: aErr } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
    if (aErr) throw new Error(aErr.message);
    const empfaenger = ((admins ?? []) as { id: string }[]).map((a) => a.id).filter((id) => id !== i.actorId);
    if (empfaenger.length > 0) {
      await notifySystem(admin, {
        recipients: empfaenger,
        title: "Rechte-Antrag bestätigen",
        message: `${i.actorName ?? "Ein Admin"}: ${beschreibung}. Bestätigen innerhalb von 24 h auf einem vertrauten Gerät.`,
        link: `/rechte-antraege?id=${data.id}`,
      });
    }
  } catch (e) {
    logError("rechte.antrag.notify", e);
  }
  return { id: data.id as string, gueltig_bis: data.gueltig_bis as string };
}

export async function ladeName(admin: SupabaseClient, profileId: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
  return (data?.full_name as string | null) ?? null;
}
