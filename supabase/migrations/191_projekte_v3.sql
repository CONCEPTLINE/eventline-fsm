-- Projekte v3 — Members, Audit, Entwurf-Flow:
-- 1) project_members: "Einloggen" auf ein Projekt (analog conceptline).
--    Nur eingeloggte Mitglieder duerfen Zeit stempeln. Zeigt "wer arbeitet
--    aktiv am Projekt" (Avatare).
-- 2) project_audit: Budget-Aenderungen mit Begruendung + wer/wann.
-- 3) Neuer Status "entwurf": MA legt Projekt zunaechst als Entwurf an,
--    kann noch bearbeiten, drueckt dann "Einreichen" -> "angefragt".
--    Admin-Anlegen springt "entwurf" ueber (direkt "genehmigt").
-- 4) RLS projects.select lockern: alle authenticated sehen alle nicht-
--    geloeschten Projekte (Team-weit sichtbar wie in conceptline).

-- 1) Status-Constraint um "entwurf" erweitern
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_status_check
  CHECK (status IN ('entwurf', 'angefragt', 'genehmigt', 'abgelehnt', 'abgeschlossen', 'storniert'));

-- 2) project_members: "eingeloggt" auf ein Projekt
CREATE TABLE IF NOT EXISTS public.project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_project_idx ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS project_members_user_idx    ON public.project_members(user_id);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pm_select" ON public.project_members
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "pm_insert" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "pm_delete" ON public.project_members
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

-- 3) project_audit: Historie fuer Budget-Aenderungen (spaeter erweiterbar
--    auf Status/Assignment/etc.)
CREATE TABLE IF NOT EXISTS public.project_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('budget', 'status', 'assignment')),
  old_value text,
  new_value text,
  reason text,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_audit_project_idx ON public.project_audit(project_id, created_at DESC);

ALTER TABLE public.project_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pa_audit_select" ON public.project_audit
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "pa_audit_insert" ON public.project_audit
  FOR INSERT TO authenticated
  WITH CHECK (changed_by = auth.uid());

-- 4) projects RLS: alle authenticated sehen alle nicht-geloeschten
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects
  FOR SELECT TO authenticated
  USING (NOT is_deleted);

-- Insert-Policy anpassen: 'entwurf' erlaubt fuer Non-Admin (statt 'angefragt')
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      created_by = auth.uid()
      AND assigned_to = auth.uid()
      AND status IN ('entwurf', 'angefragt')
      AND budget_hours IS NULL
      AND approved_by IS NULL
    )
  );

-- Update: Owner darf 'entwurf' + 'angefragt' bearbeiten (inkl. status-Wechsel
-- entwurf -> angefragt = Einreichen). Admin unrestricted wie zuvor.
DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.has_permission('projekte:approve')
    OR (created_by = auth.uid() AND status IN ('entwurf', 'angefragt'))
    OR (assigned_to = auth.uid() AND status IN ('entwurf', 'angefragt'))
  )
  WITH CHECK (
    public.is_admin()
    OR public.has_permission('projekte:approve')
    OR (created_by = auth.uid() AND status IN ('entwurf', 'angefragt'))
    OR (assigned_to = auth.uid() AND status IN ('entwurf', 'angefragt'))
  );

-- pte-Insert: Stempeln braucht Membership (nicht mehr nur assigned_to)
DROP POLICY IF EXISTS "pte_insert" ON public.project_time_entries;
CREATE POLICY "pte_insert" ON public.project_time_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      user_id = auth.uid()
      AND EXISTS (
        SELECT 1
        FROM public.projects p
        JOIN public.project_members m ON m.project_id = p.id AND m.user_id = auth.uid()
        WHERE p.id = project_id
          AND p.status = 'genehmigt'
          AND NOT p.is_deleted
      )
    )
  );

COMMENT ON TABLE public.project_members IS 'Eingeloggte Mitglieder eines Projekts. Nur Members duerfen Zeit stempeln.';
COMMENT ON TABLE public.project_audit IS 'Historie fuer Budget-/Status-/Assignment-Aenderungen mit Begruendung.';
