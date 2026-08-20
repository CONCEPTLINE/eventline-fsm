-- Projekte-Erweiterung:
-- 1) Admin darf beim Anlegen direkt Status='genehmigt' + Budget setzen
--    (kein Antrag-Loop noetig). RLS-Insert-Check ergaenzt um is_admin()-Bypass.
-- 2) Dokumente an Projekte haengen — bestehende documents-Tabelle bekommt
--    eine project_id-Spalte (FK). Storage-Pfad-Prefix "projekte/" wird
--    in der /api/upload-Route separat freigegeben.

-- 1) RLS Insert lockern fuer Admin.
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (
    -- Admin darf alles beim Insert (Status genehmigt + Budget direkt setzen)
    public.is_admin()
    OR (
      -- Non-Admin: klassischer Antrags-Flow.
      created_by = auth.uid()
      AND assigned_to = auth.uid()
      AND status = 'angefragt'
      AND budget_hours IS NULL
      AND approved_by IS NULL
    )
  );

-- 2) documents.project_id
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS documents_project_idx ON public.documents(project_id) WHERE project_id IS NOT NULL;
