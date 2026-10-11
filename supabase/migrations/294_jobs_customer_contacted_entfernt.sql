-- 294: «Kunde kontaktiert»-Flag komplett entfernt (Mischa 2026-10-11: Buttons
-- werden nicht mehr gebraucht). Entfernt Spalten, Index und den Spiegel-Eintrag
-- im Namens-Verlauf (Trigger preserve_user_name_history, Migration 222).
--
-- ERST NACH DEM DEPLOY des Codes ohne customer_contacted_* einspielen — die
-- DB ist localhost+prod geteilt, alter Code wuerde sonst auf fehlende Spalten
-- laufen (Join customer_contacted_by_profile).

-- 1) Trigger-Funktion ohne den customer_contacted_by-Spiegel neu definieren.
--    Vollstaendiger Text wie in 222, nur die eine UPDATE-Zeile fehlt.
CREATE OR REPLACE FUNCTION public.preserve_user_name_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  UPDATE public.maintenance_tasks         SET created_by_name            = v_name WHERE created_by            = OLD.id;
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
$$;

-- 2) Spalten + Index weg.
DROP INDEX IF EXISTS public.jobs_customer_contacted_idx;
ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS customer_contacted_at,
  DROP COLUMN IF EXISTS customer_contacted_by,
  DROP COLUMN IF EXISTS customer_contacted_by_name;
