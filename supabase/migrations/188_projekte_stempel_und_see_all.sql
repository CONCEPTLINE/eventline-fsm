-- Projekte-Erweiterung 2:
-- 1) Einstempeln/Ausstempeln statt manueller Minuten-Buchung.
--    project_time_entries bekommt clock_in/clock_out (timestamptz),
--    minutes wird nullable und via Trigger aus (clock_out - clock_in)
--    gefuellt beim Ausstempeln. Ein offener Stempel = clock_out NULL.
--    Pro User max 1 offener Projekt-Stempel gleichzeitig (Partial UNIQUE).
-- 2) RLS see-all: bisher gate via is_admin(). Neu: has_permission()
--    'projekte:see-all' oeffnet die Sicht/Update auch fuer Rollen wie
--    Objektleiter/Projektleiter (konfigurierbar unter /einstellungen/rollen).

-- 1) Spalten
ALTER TABLE public.project_time_entries
  ADD COLUMN IF NOT EXISTS clock_in  timestamptz,
  ADD COLUMN IF NOT EXISTS clock_out timestamptz;

-- minutes darf NULL sein solange der Stempel offen ist (clock_in gesetzt,
-- clock_out noch nicht). Der Constraint minutes > 0 aus Migration 186
-- laesst NULL bereits durch (CHECK ignoriert NULL). Nichts anpassen.

-- Konsistenz-Check: entweder minutes gesetzt (Legacy/Admin-Korrektur) ODER
-- ein Stempel-Paar. Beim offenen Stempel gilt clock_in NOT NULL AND
-- clock_out NULL AND minutes NULL.
ALTER TABLE public.project_time_entries
  DROP CONSTRAINT IF EXISTS pte_shape;
ALTER TABLE public.project_time_entries
  ADD CONSTRAINT pte_shape CHECK (
    -- geschlossener Stempel: clock_in + clock_out + minutes stimmt
    (clock_in IS NOT NULL AND clock_out IS NOT NULL AND minutes IS NOT NULL AND clock_out > clock_in)
    -- offener Stempel
    OR (clock_in IS NOT NULL AND clock_out IS NULL AND minutes IS NULL)
    -- Legacy: nur minutes (falls jemand manuell nachtraegt)
    OR (clock_in IS NULL AND clock_out IS NULL AND minutes IS NOT NULL)
  );

-- Pro User nur 1 offener Projekt-Stempel gleichzeitig — verhindert
-- versehentlich mehrfach Einstempeln auf verschiedene Projekte.
CREATE UNIQUE INDEX IF NOT EXISTS project_time_entries_open_stamp_unique
  ON public.project_time_entries (user_id)
  WHERE clock_out IS NULL AND clock_in IS NOT NULL;

-- Trigger: beim Ausstempeln (clock_out gesetzt) minutes berechnen.
CREATE OR REPLACE FUNCTION public.project_time_entries_derive_minutes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.clock_in IS NOT NULL AND NEW.clock_out IS NOT NULL THEN
    NEW.minutes := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 60.0)::int);
    IF NEW.minutes > 1440 THEN NEW.minutes := 1440; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS project_time_entries_derive_minutes ON public.project_time_entries;
CREATE TRIGGER project_time_entries_derive_minutes
  BEFORE INSERT OR UPDATE ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.project_time_entries_derive_minutes();

-- Als entry_date gilt der lokale Tag des clock_in (ZRH). Beim Insert nicht
-- setzen, wenn nur clock_in dabei ist — wir setzen ihn im Trigger auf CURRENT_DATE
-- falls leer.
CREATE OR REPLACE FUNCTION public.project_time_entries_default_date()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entry_date IS NULL AND NEW.clock_in IS NOT NULL THEN
    NEW.entry_date := (NEW.clock_in AT TIME ZONE 'Europe/Zurich')::date;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS project_time_entries_default_date ON public.project_time_entries;
CREATE TRIGGER project_time_entries_default_date
  BEFORE INSERT ON public.project_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.project_time_entries_default_date();

-- 2) RLS see-all
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects
  FOR SELECT TO authenticated
  USING (
    NOT is_deleted
    AND (
      assigned_to = auth.uid()
      OR created_by = auth.uid()
      OR public.is_admin()
      OR public.has_permission('projekte:see-all')
    )
  );

DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.has_permission('projekte:approve')
    OR (assigned_to = auth.uid() AND status = 'angefragt')
  )
  WITH CHECK (
    public.is_admin()
    OR public.has_permission('projekte:approve')
    OR (assigned_to = auth.uid() AND status = 'angefragt')
  );

-- pte-Select analog: see-all-Perm sieht alle Eintraege
DROP POLICY IF EXISTS "pte_select" ON public.project_time_entries;
CREATE POLICY "pte_select" ON public.project_time_entries
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin()
    OR public.has_permission('projekte:see-all')
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_id
        AND (p.assigned_to = auth.uid() OR p.created_by = auth.uid())
    )
  );

-- pte-Insert: eingestempelte darf man auch mit clock_in only inserten;
-- keine Minuten-Voraussetzung mehr.
DROP POLICY IF EXISTS "pte_insert" ON public.project_time_entries;
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

-- pte-Update: eigener Eintrag im 24h-Fenster ODER Admin (Legacy) ODER
-- eigenen offenen Stempel schliessen (jederzeit erlaubt, auch nach 24h).
DROP POLICY IF EXISTS "pte_update" ON public.project_time_entries;
CREATE POLICY "pte_update" ON public.project_time_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (user_id = auth.uid())
  )
  WITH CHECK (
    public.is_admin()
    OR (user_id = auth.uid())
  );
