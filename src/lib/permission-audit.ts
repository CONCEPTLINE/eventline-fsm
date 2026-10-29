/**
 * Logger fuer Permission-Aenderungen (Audit-Trail).
 *
 * Wird aus den API-Routes /api/admin/roles + /api/admin/users aufgerufen
 * nach jeder erfolgreichen Mutation. Best-effort — wenn der Log-Insert
 * schiefgeht, soll der eigentliche Request trotzdem durchgehen.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export type PermissionAuditAction =
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "user.role_changed"
  | "user.permissions_changed"
  // Lohn-Umbau Phase 1 (Migration 360): «Ansicht als» und Geraetefreigabe
  | "view_as.started"
  | "view_as.stopped"
  | "view_as.write_enabled"
  | "view_as.write_disabled"
  | "device.requested"
  | "device.approved"
  | "device.rejected"
  | "device.revoked"
  | "lohn.vertretung_changed"
  // Migration 361: Vier Augen bei Rechten (Antraege)
  | "rechte.antrag_gestellt"
  | "rechte.antrag_bestaetigt"
  | "rechte.antrag_abgelehnt"
  | "rechte.antrag_notweg"
  // Migration 363: Wartungsmodus (schreibt public.wartung_setzen bzw.
  // wartung_ausnahmen_setzen selbst, hier nur fuer die Vollstaendigkeit)
  | "wartung.an"
  | "wartung.aus"
  | "wartung.ausnahmen";

interface BaseEntry {
  actor_profile_id: string;
  action: PermissionAuditAction;
  details?: Record<string, unknown>;
}

interface RoleEntry extends BaseEntry {
  target_role_slug: string;
}

interface UserEntry extends BaseEntry {
  target_profile_id: string;
}

type AuditEntry = RoleEntry | UserEntry;

/** Schreibt den Eintrag. true = gespeichert. Wirft nie — wer das Protokoll
 *  zwingend braucht (z. B. «Ansicht als» starten), wertet die Rueckgabe aus. */
export async function logPermissionAudit(entry: AuditEntry): Promise<boolean> {
  try {
    const admin = createAdminClient();
    // Actor + Target denormalisieren (full_name), damit der Log auch
    // nach User-Loeschung lesbar bleibt.
    const ids: string[] = [entry.actor_profile_id];
    if ("target_profile_id" in entry) ids.push(entry.target_profile_id);
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name")
      .in("id", ids);
    const labelById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
    const row: Record<string, unknown> = {
      actor_profile_id: entry.actor_profile_id,
      actor_label: labelById.get(entry.actor_profile_id) ?? null,
      action: entry.action,
      details: entry.details ?? {},
    };
    if ("target_role_slug" in entry) {
      row.target_role_slug = entry.target_role_slug;
    } else {
      row.target_profile_id = entry.target_profile_id;
      row.target_profile_label = labelById.get(entry.target_profile_id) ?? null;
    }
    const { error } = await admin.from("permission_audit_log").insert(row);
    return !error;
  } catch {
    // Audit-Logging darf nie den eigentlichen Request kippen.
    // Fehler werden absichtlich geschluckt.
    return false;
  }
}
