-- Vertrieb-Folders: is_shared-Flag fuer team-weit sichtbare Ordner.
-- Nur Admins koennen shared Folders anlegen/umbenennen/loeschen/faerben.
-- Assignments in shared Folders duerfen ALLE authenticated Nutzer setzen/entfernen.
--
-- Junction-PK von (lead_id, owner_id) auf (lead_id, folder_id) wechseln —
-- damit ein Lead in mehreren Foldern gleichzeitig sein kann (z.B. mein
-- privater "Wichtig" + team-shared "Winter-Aktion"). Die alte "1 Lead pro
-- Owner in max 1 privatem Folder"-Regel bleibt im App-Layer erhalten (der
-- Folder-Picker/Verschiebe-Handler loeschen die alte Zuweisung explizit).

-- 1) is_shared-Spalte
ALTER TABLE public.vertrieb_folders
  ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS vertrieb_folders_shared_idx
  ON public.vertrieb_folders(is_shared) WHERE is_shared = true;

COMMENT ON COLUMN public.vertrieb_folders.is_shared IS
  'true = team-shared Ordner (fuer alle sichtbar, nur Admin verwaltbar). false = privater Ordner (nur Owner sichtbar).';

-- 2) Junction-PK wechseln.
-- Bestehende Zeilen sind unter dem alten PK (lead_id, owner_id) unique;
-- unter dem neuen PK (lead_id, folder_id) auch, weil pro (lead, folder,
-- owner) hoechstens ein Eintrag existierte und pro (lead, owner) genau
-- ein folder_id assigned war.
DO $$
DECLARE
  pk_cols text[];
BEGIN
  SELECT array_agg(kcu.column_name ORDER BY kcu.ordinal_position)
    INTO pk_cols
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
   WHERE tc.table_schema = 'public'
     AND tc.table_name = 'vertrieb_lead_folders'
     AND tc.constraint_type = 'PRIMARY KEY';

  IF pk_cols IS NOT NULL AND pk_cols <> ARRAY['lead_id', 'folder_id']::text[] THEN
    ALTER TABLE public.vertrieb_lead_folders
      DROP CONSTRAINT vertrieb_lead_folders_pkey;
    ALTER TABLE public.vertrieb_lead_folders
      ADD CONSTRAINT vertrieb_lead_folders_pkey PRIMARY KEY (lead_id, folder_id);
  END IF;
END $$;

-- 3) RLS: vertrieb_folders
DROP POLICY IF EXISTS vertrieb_folders_owner_select ON public.vertrieb_folders;
CREATE POLICY vertrieb_folders_owner_select
  ON public.vertrieb_folders FOR SELECT
  TO authenticated
  USING (is_shared = true OR owner_id = auth.uid());

DROP POLICY IF EXISTS vertrieb_folders_owner_insert ON public.vertrieb_folders;
CREATE POLICY vertrieb_folders_owner_insert
  ON public.vertrieb_folders FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Privater Folder: nur fuer sich selbst.
    (is_shared = false AND owner_id = auth.uid())
    -- Shared Folder: nur Admin darf anlegen.
    OR (is_shared = true AND public.is_admin())
  );

DROP POLICY IF EXISTS vertrieb_folders_owner_update ON public.vertrieb_folders;
CREATE POLICY vertrieb_folders_owner_update
  ON public.vertrieb_folders FOR UPDATE
  TO authenticated
  USING (
    (is_shared = false AND owner_id = auth.uid())
    OR (is_shared = true AND public.is_admin())
  )
  WITH CHECK (
    (is_shared = false AND owner_id = auth.uid())
    OR (is_shared = true AND public.is_admin())
  );

DROP POLICY IF EXISTS vertrieb_folders_owner_delete ON public.vertrieb_folders;
CREATE POLICY vertrieb_folders_owner_delete
  ON public.vertrieb_folders FOR DELETE
  TO authenticated
  USING (
    (is_shared = false AND owner_id = auth.uid())
    OR (is_shared = true AND public.is_admin())
  );

-- 4) RLS: vertrieb_lead_folders (via folder-Join gaten)
DROP POLICY IF EXISTS vertrieb_lead_folders_owner_all ON public.vertrieb_lead_folders;

DROP POLICY IF EXISTS vertrieb_lead_folders_select ON public.vertrieb_lead_folders;
CREATE POLICY vertrieb_lead_folders_select
  ON public.vertrieb_lead_folders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vertrieb_folders f
      WHERE f.id = vertrieb_lead_folders.folder_id
        AND (f.is_shared = true OR f.owner_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS vertrieb_lead_folders_insert ON public.vertrieb_lead_folders;
CREATE POLICY vertrieb_lead_folders_insert
  ON public.vertrieb_lead_folders FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.vertrieb_folders f
      WHERE f.id = vertrieb_lead_folders.folder_id
        AND (
          -- Privater Folder: nur der Owner selbst.
          (f.is_shared = false AND f.owner_id = auth.uid() AND vertrieb_lead_folders.owner_id = auth.uid())
          -- Shared Folder: alle authenticated. owner_id = wer's zugewiesen hat.
          OR (f.is_shared = true AND vertrieb_lead_folders.owner_id = auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS vertrieb_lead_folders_delete ON public.vertrieb_lead_folders;
CREATE POLICY vertrieb_lead_folders_delete
  ON public.vertrieb_lead_folders FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vertrieb_folders f
      WHERE f.id = vertrieb_lead_folders.folder_id
        AND (
          (f.is_shared = false AND f.owner_id = auth.uid())
          OR (f.is_shared = true)
        )
    )
  );

COMMENT ON TABLE public.vertrieb_lead_folders IS
  'Junction Lead<->Folder. PK(lead_id, folder_id): ein Lead kann in mehreren Foldern gleichzeitig sein (privat + shared). owner_id = wer die Zuweisung erstellt hat.';
