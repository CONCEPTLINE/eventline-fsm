-- Projekte: interne Zeit-Budget-Kontrolle. Ein Mitarbeiter (z.B. freier
-- Akquisiteur) legt ein Projekt an mit einer Wunsch-Stundenzahl. Admin
-- prueft und setzt ein verbindliches Stunden-Budget (genehmigt). Erst
-- danach kann der MA Zeit auf das Projekt stempeln. So bleiben die
-- Lohnkosten kontrollierbar — ohne freigegebenes Budget, keine bezahlte
-- Zeit.
--
-- Bewusst getrennt von jobs (= externe Auftraege mit Kunden/Locations)
-- und time_entries (= Stempeln pro Job). Ein Projekt hat keinen Kunden;
-- es ist ein interner Zeit-Topf.
--
-- Status-Fluss:
--   angefragt -> genehmigt -> abgeschlossen
--                  \-> abgelehnt (Endzustand)
--
-- deleted-Spalte: Soft-Delete, damit Zeit-Historie erhalten bleibt wenn
-- ein Projekt "geloescht" wird.

CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'angefragt'
    CHECK (status IN ('angefragt', 'genehmigt', 'abgelehnt', 'abgeschlossen')),
  -- Was der MA beim Anlegen vorgeschlagen hat.
  proposed_hours numeric(6, 2),
  -- Was der Admin genehmigt hat. NULL solange nicht genehmigt.
  budget_hours numeric(6, 2),
  -- Wer arbeitet daran (in der Regel = created_by). Admin kann jemand
  -- anderes zuweisen wenn noetig.
  assigned_to uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  -- Kommentar bei Genehmigung/Ablehnung (z.B. "Budget reduziert weil ...")
  decision_note text,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_assigned_idx ON public.projects(assigned_to) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS projects_status_idx   ON public.projects(status)      WHERE NOT is_deleted;

-- Zeit-Eintraege auf Projekte. Minuten weil Stempel-UX oft in Minuten
-- gerechnet wird (z.B. 45 min). Bei Anzeige umrechnen in h:mm.
CREATE TABLE IF NOT EXISTS public.project_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  entry_date date NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_time_entries_project_idx ON public.project_time_entries(project_id);
CREATE INDEX IF NOT EXISTS project_time_entries_user_date_idx ON public.project_time_entries(user_id, entry_date DESC);

-- updated_at auto-touch bei UPDATE.
CREATE OR REPLACE FUNCTION public.projects_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS projects_touch_updated_at ON public.projects;
CREATE TRIGGER projects_touch_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.projects_touch_updated_at();

-- RLS: MA sieht/aendert nur eigene (assigned_to = self, oder created_by = self).
-- Admin darf alles.
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_select" ON public.projects
  FOR SELECT TO authenticated
  USING (
    NOT is_deleted
    AND (assigned_to = auth.uid() OR created_by = auth.uid() OR public.is_admin())
  );

-- Insert: authenticated User (nicht Partner). Setzt sich selber als
-- created_by und assigned_to. Status wird vom Trigger/Default auf
-- 'angefragt' geklemmt.
CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (assigned_to = auth.uid() OR public.is_admin())
    AND status = 'angefragt'
    AND budget_hours IS NULL
    AND approved_by IS NULL
  );

-- Update: eigenes Projekt bearbeiten solange 'angefragt' (Titel/Beschreibung/proposed_hours),
-- oder Admin darf immer alles.
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR (assigned_to = auth.uid() AND status = 'angefragt'))
  WITH CHECK (public.is_admin() OR (assigned_to = auth.uid() AND status = 'angefragt'));

-- Delete via is_deleted-Flag — direkter DELETE nur fuer Admin.
CREATE POLICY "projects_delete" ON public.projects
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- Time-Entries RLS: MA sieht/erstellt eigene, Admin sieht/aendert alle.
ALTER TABLE public.project_time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pte_select" ON public.project_time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin() OR EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = project_id AND (p.assigned_to = auth.uid() OR p.created_by = auth.uid())
  ));

-- Insert: nur wenn Projekt genehmigt UND User dem Projekt zugewiesen ist.
-- Admin kann fuer beliebige User buchen (z.B. Nach-Korrektur).
CREATE POLICY "pte_insert" ON public.project_time_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      user_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = project_id
          AND p.assigned_to = auth.uid()
          AND p.status = 'genehmigt'
          AND NOT p.is_deleted
      )
    )
  );

-- Update/Delete: eigenen Eintrag am selben Tag korrigieren, sonst Admin.
CREATE POLICY "pte_update" ON public.project_time_entries
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR (user_id = auth.uid() AND created_at > now() - interval '24 hours'))
  WITH CHECK (public.is_admin() OR (user_id = auth.uid() AND created_at > now() - interval '24 hours'));

CREATE POLICY "pte_delete" ON public.project_time_entries
  FOR DELETE TO authenticated
  USING (public.is_admin() OR (user_id = auth.uid() AND created_at > now() - interval '24 hours'));

COMMENT ON TABLE public.projects IS 'Interne Projekte mit Stunden-Budget (Genehmigung durch Admin). MA fragt an, Admin genehmigt Budget, dann darf gestempelt werden.';
COMMENT ON TABLE public.project_time_entries IS 'Zeit-Stempel auf ein Projekt. Nur moeglich wenn Projekt-Status = genehmigt.';
