-- Projekte stornieren:
-- Neuer Status 'storniert'. Muss mit Begruendung (decision_note) gesetzt
-- werden, deswegen via RPC-Function statt direktem UPDATE — die Function
-- validiert den Grund und die Berechtigung (Admin ODER Assignee).
--
-- Stornierte Projekte gehen ins Archiv (Filter in der Liste): zusammen
-- mit 'abgeschlossen' und 'abgelehnt' sind sie Endzustaende.

-- 1) Status-Check erweitern
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_status_check
  CHECK (status IN ('angefragt', 'genehmigt', 'abgelehnt', 'abgeschlossen', 'storniert'));

-- 2) RPC-Function zum Stornieren mit Pflicht-Grund
CREATE OR REPLACE FUNCTION public.cancel_project(p_project_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_project public.projects;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Begruendung ist Pflicht';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = p_project_id;
  IF v_project.id IS NULL THEN
    RAISE EXCEPTION 'Projekt nicht gefunden';
  END IF;

  IF v_project.is_deleted THEN
    RAISE EXCEPTION 'Projekt bereits geloescht';
  END IF;

  IF v_project.status IN ('abgeschlossen', 'abgelehnt', 'storniert') THEN
    RAISE EXCEPTION 'Projekt ist bereits im Endzustand (%)', v_project.status;
  END IF;

  -- Berechtigt: Admin, has_permission approve, oder der Assignee selbst.
  IF NOT (
    public.is_admin()
    OR public.has_permission('projekte:approve')
    OR v_project.assigned_to = v_uid
    OR v_project.created_by = v_uid
  ) THEN
    RAISE EXCEPTION 'Nicht berechtigt';
  END IF;

  UPDATE public.projects
    SET status = 'storniert',
        decision_note = btrim(p_reason),
        approved_by = v_uid,
        approved_at = now()
    WHERE id = p_project_id;
END $$;

COMMENT ON FUNCTION public.cancel_project IS 'Projekt stornieren mit obligatorischer Begruendung. Setzt Status auf storniert und speichert Grund in decision_note. Berechtigt: Admin, Rollen mit projekte:approve, Assignee oder Ersteller.';

-- Grant Ausfuehrungsrecht.
GRANT EXECUTE ON FUNCTION public.cancel_project(uuid, text) TO authenticated;
