// GET /api/admin/users/[id]/impact — Impact-Analyse fuer User-Delete.
//
// Bevor ein Admin einen User loescht, zeigt das UI genau WAS passiert:
//   - destructive_cascades: FKs mit ON DELETE CASCADE — die Zeilen sind
//     nach dem Delete UNWIDERRUFLICH weg. Fuer manche davon (Vertriebs-
//     Ordner) kann per POST /transfer der Owner umgezogen werden, sodass
//     die Zeilen erhalten bleiben. Anders sind an die Person gebunden
//     (Lohn, wage_documents, time_off...) und liessen sich fachlich
//     nicht "umziehen".
//   - set_null_preservation: FKs mit ON DELETE SET NULL. Die Zeilen
//     bleiben, aber der Verweis wird NULL. Migration 221 hat parallel
//     eine Freitext-Spalte '<col>_name' angelegt, in die der Full-Name
//     VOR dem Delete gespiegelt wird (Migration 222 Trigger) — so bleibt
//     die Zurechnung in der Historie sichtbar.
//   - can_delete_directly: true wenn keine destructive_cascades Zeilen
//     haben — dann kann der Admin ohne Vorab-Aktionen loeschen.
//
// Admin-only. Zaehlt via count:'exact', head:true — keine Row-Daten,
// nur die Zahl. Alle Counts parallel via Promise.all.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

// Whitelist der Tabellen fuer die /transfer einen Owner-Wechsel unterstuetzt.
// Muss identisch mit der Whitelist in /transfer/route.ts bleiben — sonst
// zeigt das UI "uebertragen" an obwohl die Transfer-API es ablehnt.
const TRANSFERABLE = new Set(["vertrieb_folders", "vertrieb_lead_folders"]);

// Destruktive CASCADE-Loeschungen. Jede Zeile: welche Tabelle, in welcher
// Spalte referenziert sie den User, was verliert man beim Delete? Der
// 'purpose'-Text ist die 1:1-Anzeige im UI (klartext fuer Leo).
type CascadeDef = { table: string; col: string; purpose: string };
const CASCADE_DESTRUCTIVE: CascadeDef[] = [
  {
    table: "vertrieb_folders",
    col: "owner_id",
    purpose:
      "Vertriebs-Ordner (Sammlungen/Kategorien von Leads); Ordner-Struktur des Owners geht komplett verloren",
  },
  {
    table: "vertrieb_lead_folders",
    col: "owner_id",
    purpose:
      "Lead-zu-Ordner-Zuordnungen des Owners (welcher Lead liegt in welchem Ordner); Sortierung geht verloren",
  },
  {
    table: "employee_compensation",
    col: "profile_id",
    purpose:
      "Lohn-Historie des Users (Stundensaetze, Zuschlaege); vollstaendige Payroll-Historie unwiderruflich weg",
  },
  {
    table: "wage_documents",
    col: "profile_id",
    purpose:
      "Lohnabrechnungs-PDFs des Users (jeder Monat ein Dokument); alle Abrechnungen unwiderruflich weg",
  },
  {
    table: "time_off",
    col: "user_id",
    purpose:
      "Urlaubs-/Abwesenheitsantraege des Users (inkl. genehmigter Historie); Payroll-relevante Historie weg",
  },
  {
    table: "office_attendance",
    col: "user_id",
    purpose:
      "Buero-Anwesenheitshistorie des Users (Check-in/Check-out); Auswertungs-Basis weg",
  },
  {
    table: "project_members",
    col: "user_id",
    purpose:
      "Projekt-Mitgliedschaften des Users; Projekt-Zugehoerigkeit verschwindet (Historie im project_audit bleibt)",
  },
  {
    table: "project_appointment_participants",
    col: "profile_id",
    purpose:
      "Termin-Teilnahmen des Users an Projekt-Terminen; wer war wann dabei geht verloren",
  },
  {
    table: "notifications",
    col: "user_id",
    purpose: "Persoenliche Benachrichtigungen des Users; irrelevant nach Delete",
  },
  {
    table: "push_subscriptions",
    col: "user_id",
    purpose:
      "Push-Notification-Endpoints des Users (Browser/Device); technisch, irrelevant nach Delete",
  },
  {
    table: "trusted_devices",
    col: "user_id",
    purpose:
      "Vertraute Geraete (Finanz-Gating) des Users; Auth-Kontext, irrelevant nach Delete",
  },
  {
    table: "user_dashboard_overrides",
    col: "user_id",
    purpose: "Persoenliche Dashboard-Layout-Overrides; UI-Praeferenz, irrelevant",
  },
  {
    table: "user_notification_settings",
    col: "user_id",
    purpose: "Persoenliche Notification-Praeferenzen; irrelevant",
  },
  {
    table: "user_passkey_challenges",
    col: "user_id",
    purpose: "Passkey-Auth-Challenges (kurzlebig); irrelevant",
  },
  {
    table: "user_passkeys",
    col: "user_id",
    purpose:
      "Registrierte Passkeys des Users; Auth-Material, irrelevant nach Delete",
  },
  {
    table: "user_sessions",
    col: "user_id",
    purpose: "Aktive Login-Sessions des Users; irrelevant",
  },
];

// SET NULL preserve-name-Spalten. Pro Column ein Eintrag — es gibt Tabellen
// (jobs, tickets, todos) mit mehreren User-Refs, jede Spalte zaehlt einzeln.
// Muss synchron gehalten werden mit Migration 222 (die _name-Trigger anlegt).
type SetNullDef = { table: string; col: string };
const SET_NULL_PRESERVE: SetNullDef[] = [
  { table: "bexio_connection", col: "connected_by" },
  { table: "calendar_events", col: "created_by" },
  { table: "calendar_events", col: "profile_id" },
  { table: "company_settings", col: "updated_by" },
  { table: "documents", col: "uploaded_by" },
  { table: "employee_compensation", col: "created_by" },
  { table: "job_appointments", col: "assigned_to" },
  { table: "job_draft_notes", col: "author_id" },
  { table: "job_drafts", col: "created_by" },
  { table: "job_drafts", col: "owner_id" },
  { table: "jobs", col: "accepted_by" },
  { table: "jobs", col: "cancelled_by" },
  { table: "jobs", col: "created_by" },
  { table: "jobs", col: "customer_contacted_by" },
  { table: "jobs", col: "invoice_skipped_by" },
  { table: "jobs", col: "invoiced_by" },
  { table: "jobs", col: "project_lead_id" },
  { table: "jobs", col: "rejected_by" },
  { table: "jobs", col: "submitted_by" },
  { table: "partner_form_template", col: "draft_updated_by" },
  { table: "partner_form_template", col: "live_published_by" },
  { table: "payroll_defaults", col: "created_by" },
  { table: "permission_audit_log", col: "actor_profile_id" },
  { table: "permission_audit_log", col: "target_profile_id" },
  { table: "profiles", col: "team_lead_id" },
  { table: "project_appointment_notes", col: "created_by" },
  { table: "project_appointments", col: "assigned_to" },
  { table: "project_audit", col: "changed_by" },
  { table: "projects", col: "approved_by" },
  { table: "rental_requests", col: "created_by" },
  { table: "service_reports", col: "created_by" },
  { table: "ticket_attachments", col: "uploaded_by" },
  { table: "tickets", col: "assigned_to" },
  { table: "tickets", col: "created_by" },
  { table: "tickets", col: "filed_by" },
  { table: "tickets", col: "resolved_by" },
  { table: "time_entries", col: "user_id" },
  { table: "time_off", col: "approved_by" },
  { table: "todo_attachments", col: "uploaded_by" },
  { table: "todos", col: "assigned_to" },
  { table: "todos", col: "created_by" },
  { table: "todos", col: "deleted_by" },
  { table: "vertrieb_contacts", col: "assigned_to" },
  { table: "vertrieb_team_goal", col: "created_by" },
  { table: "wage_documents", col: "uploaded_by" },
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json(
      { success: false, error: "Ungültige Profil-ID" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // User laden — impact-Response referenziert full_name/role/is_active
  // damit das UI die Bestaetigung „User X wirklich loeschen?" klar
  // stellen kann.
  const { data: user, error: userErr } = await admin
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", id)
    .maybeSingle();
  if (userErr) {
    logError("admin.users.impact.user", userErr, { userId: id });
    return NextResponse.json({ success: false, error: userErr.message }, { status: 500 });
  }
  if (!user) {
    return NextResponse.json(
      { success: false, error: "Mitarbeiter nicht gefunden" },
      { status: 404 },
    );
  }

  // Alle Counts parallel — head:true holt keine Rows, nur die Zahl.
  // Total ~60 Queries; Promise.all faehrt sie parallel, Postgres-Pool
  // packt das locker (jede ist ein einfaches indexed SELECT count).
  const cascadeCountPromises = CASCADE_DESTRUCTIVE.map(async (c) => {
    const { count, error } = await admin
      .from(c.table)
      .select("*", { count: "exact", head: true })
      .eq(c.col, id);
    if (error) {
      logError("admin.users.impact.cascade", error, { table: c.table, col: c.col, userId: id });
    }
    return {
      table: c.table,
      purpose: c.purpose,
      count: count ?? 0,
      transfer_possible: TRANSFERABLE.has(c.table),
    };
  });

  const setNullCountPromises = SET_NULL_PRESERVE.map(async (s) => {
    const { count, error } = await admin
      .from(s.table)
      .select("*", { count: "exact", head: true })
      .eq(s.col, id);
    if (error) {
      logError("admin.users.impact.setnull", error, { table: s.table, col: s.col, userId: id });
    }
    return {
      table: s.table,
      column: s.col,
      count: count ?? 0,
    };
  });

  const [cascadeResults, setNullResults] = await Promise.all([
    Promise.all(cascadeCountPromises),
    Promise.all(setNullCountPromises),
  ]);

  // Nur die mit tatsaechlichen Zeilen im UI zeigen — leere Zeilen sind
  // fuer den Admin uninteressant und ueberladen die Liste.
  const destructive_cascades = cascadeResults.filter((r) => r.count > 0);
  const set_null_preservation = setNullResults.filter((r) => r.count > 0);

  // can_delete_directly: true wenn keine destruktive Cascade Zeilen hat.
  // Set-NULL ist ok (Namen bleiben via Trigger erhalten), nur echte
  // Datenverluste blockieren den Direkt-Delete.
  const can_delete_directly = destructive_cascades.length === 0;

  return NextResponse.json({
    success: true,
    user,
    destructive_cascades,
    set_null_preservation,
    can_delete_directly,
  });
}
