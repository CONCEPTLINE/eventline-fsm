-- Projekte v2 — grosses Rework:
-- 1) Projektnummer (PRJ-100…) analog job_number-Sequenz
-- 2) Klares Ziel: goal_text + goal_date (Deadline)
-- 3) Notizen: freies Notizfeld, edit-in-place auf Detail-Seite
-- 4) Abschluss: success/misserfolg + Abschluss-Notiz
-- 5) Historie: parent_project_id fuer Folgeprojekte (Kette Vorgaenger→Nachfolger)
-- 6) Termine: eigene Tabelle project_appointments, greift im Kalender

CREATE SEQUENCE IF NOT EXISTS public.project_number_seq START WITH 100;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS project_number integer UNIQUE DEFAULT nextval('public.project_number_seq'),
  ADD COLUMN IF NOT EXISTS goal_text  text,
  ADD COLUMN IF NOT EXISTS goal_date  date,
  ADD COLUMN IF NOT EXISTS notes      text,
  ADD COLUMN IF NOT EXISTS completion_success boolean,
  ADD COLUMN IF NOT EXISTS completion_note    text,
  ADD COLUMN IF NOT EXISTS parent_project_id  uuid REFERENCES public.projects(id) ON DELETE SET NULL;

-- Alte Projekte (die vor der Migration existierten) bekommen jetzt eine Nummer.
UPDATE public.projects SET project_number = nextval('public.project_number_seq') WHERE project_number IS NULL;

CREATE INDEX IF NOT EXISTS projects_parent_idx ON public.projects(parent_project_id) WHERE parent_project_id IS NOT NULL;

-- Termine an einem Projekt. Einfaches Modell — Titel + Zeitraum + Notiz;
-- optional zugewiesener User. Wird im Kalender neben Job-Terminen gezeigt.
CREATE TABLE IF NOT EXISTS public.project_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_appointments_time_check CHECK (end_time IS NULL OR end_time > start_time)
);

CREATE INDEX IF NOT EXISTS project_appointments_project_idx ON public.project_appointments(project_id);
CREATE INDEX IF NOT EXISTS project_appointments_start_idx ON public.project_appointments(start_time);

ALTER TABLE public.project_appointments ENABLE ROW LEVEL SECURITY;

-- Sichtbar wenn Projekt sichtbar ist. Insert/Update/Delete: Admin, see-all-Perm,
-- Assignee des Projekts oder Ersteller.
CREATE POLICY "pa_select" ON public.project_appointments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_id
        AND NOT p.is_deleted
        AND (
          p.assigned_to = auth.uid()
          OR p.created_by = auth.uid()
          OR public.is_admin()
          OR public.has_permission('projekte:see-all')
        )
    )
  );

CREATE POLICY "pa_insert" ON public.project_appointments
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_id
        AND NOT p.is_deleted
        AND (
          p.assigned_to = auth.uid()
          OR p.created_by = auth.uid()
          OR public.is_admin()
          OR public.has_permission('projekte:see-all')
        )
    )
  );

CREATE POLICY "pa_update" ON public.project_appointments
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.has_permission('projekte:see-all')
    OR created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.assigned_to = auth.uid())
  )
  WITH CHECK (
    public.is_admin()
    OR public.has_permission('projekte:see-all')
    OR created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.assigned_to = auth.uid())
  );

CREATE POLICY "pa_delete" ON public.project_appointments
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR public.has_permission('projekte:see-all')
    OR created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.assigned_to = auth.uid())
  );

COMMENT ON TABLE public.project_appointments IS 'Termine an einem Projekt — erscheinen im Kalender neben Job-Terminen.';
COMMENT ON COLUMN public.projects.parent_project_id IS 'Vorgaenger-Projekt (Folgeprojekt-Kette). Bei erfolgreichem/nicht-erfolgreichem Abschluss kann ein neues angelegt werden das hierher zurueckzeigt.';
COMMENT ON COLUMN public.projects.goal_text IS 'Klares Ziel: was soll konkret erreicht werden?';
COMMENT ON COLUMN public.projects.goal_date IS 'Deadline: bis wann soll das Ziel erreicht sein?';
COMMENT ON COLUMN public.projects.completion_success IS 'true = erfolgreich, false = nicht erfolgreich, NULL = nicht abgeschlossen';
