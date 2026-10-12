-- Migration 311: «Benutzer löschen» repariert — Trigger preserve_user_name_history
-- schrieb noch in die Tabelle maintenance_tasks, die Migration 224 entfernt hat.
--
-- Folge bisher: Jedes Loeschen eines Profils mit Namen scheiterte mit
-- «relation public.maintenance_tasks does not exist» — auch «Benutzer löschen»
-- in den Einstellungen. Gefunden im Mobile-Overhaul (Welle 4, 2026-10-11),
-- Auftrag Leo/Mischa 2026-10-12 («mache»).
--
-- Fix: Funktion aus der LIVE-Definition (pg_get_functiondef, 2026-10-12) neu
-- angelegt, nur die eine maintenance_tasks-Zeile entfernt. Alle anderen 44
-- Namens-Sicherungen unveraendert (live geprueft: alle Tabellen/Spalten
-- vorhanden). Der Trigger preserve_user_name_history_trigger auf profiles
-- bleibt bestehen und nutzt die neue Fassung.
--
-- Idempotent: CREATE OR REPLACE.
-- EINGESPIELT 2026-10-12 (Mobile-Session). Geprueft mit Test-Nutzer (example.com,
-- mit Namen): Auth-Konto + Profil loeschen klappt, keine Reste.

CREATE OR REPLACE FUNCTION public.preserve_user_name_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name text := COALESCE(OLD.full_name, '');
BEGIN
  IF v_name = '' THEN
    RETURN OLD;
  END IF;
  UPDATE public.bexio_connection          SET connected_by_name          = v_name WHERE connected_by          = OLD.id;
  UPDATE public.calendar_events           SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.calendar_events           SET profile_id_name            = v_name WHERE profile_id            = OLD.id;
  UPDATE public.company_settings          SET updated_by_name            = v_name WHERE updated_by            = OLD.id;
  UPDATE public.documents                 SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;
  UPDATE public.employee_compensation     SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.job_appointments          SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.job_draft_notes           SET author_id_name             = v_name WHERE author_id             = OLD.id;
  UPDATE public.job_drafts                SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.job_drafts                SET owner_id_name              = v_name WHERE owner_id              = OLD.id;
  UPDATE public.jobs                      SET accepted_by_name           = v_name WHERE accepted_by           = OLD.id;
  UPDATE public.jobs                      SET cancelled_by_name          = v_name WHERE cancelled_by          = OLD.id;
  UPDATE public.jobs                      SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.jobs                      SET invoice_skipped_by_name    = v_name WHERE invoice_skipped_by    = OLD.id;
  UPDATE public.jobs                      SET invoiced_by_name           = v_name WHERE invoiced_by           = OLD.id;
  UPDATE public.jobs                      SET project_lead_id_name       = v_name WHERE project_lead_id       = OLD.id;
  UPDATE public.jobs                      SET rejected_by_name           = v_name WHERE rejected_by           = OLD.id;
  UPDATE public.jobs                      SET submitted_by_name          = v_name WHERE submitted_by          = OLD.id;
  UPDATE public.partner_form_template     SET draft_updated_by_name      = v_name WHERE draft_updated_by      = OLD.id;
  UPDATE public.partner_form_template     SET live_published_by_name     = v_name WHERE live_published_by     = OLD.id;
  UPDATE public.payroll_defaults          SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.permission_audit_log      SET actor_profile_id_name      = v_name WHERE actor_profile_id      = OLD.id;
  UPDATE public.permission_audit_log      SET target_profile_id_name     = v_name WHERE target_profile_id     = OLD.id;
  UPDATE public.profiles                  SET team_lead_id_name          = v_name WHERE team_lead_id          = OLD.id;
  UPDATE public.project_appointment_notes SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.project_appointments      SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.project_audit             SET changed_by_name            = v_name WHERE changed_by            = OLD.id;
  UPDATE public.projects                  SET approved_by_name           = v_name WHERE approved_by           = OLD.id;
  UPDATE public.rental_requests           SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.service_reports           SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.ticket_attachments        SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;
  UPDATE public.tickets                   SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.tickets                   SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.tickets                   SET filed_by_name              = v_name WHERE filed_by              = OLD.id;
  UPDATE public.tickets                   SET resolved_by_name           = v_name WHERE resolved_by           = OLD.id;
  UPDATE public.time_entries              SET user_id_name               = v_name WHERE user_id               = OLD.id;
  UPDATE public.time_off                  SET approved_by_name           = v_name WHERE approved_by           = OLD.id;
  UPDATE public.todo_attachments          SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;
  UPDATE public.todos                     SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.todos                     SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.todos                     SET deleted_by_name            = v_name WHERE deleted_by            = OLD.id;
  UPDATE public.vertrieb_contacts         SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.vertrieb_team_goal        SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.wage_documents            SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;

  RETURN OLD;
END;
$function$;
