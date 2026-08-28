-- Projekte: Zeitraum, Termine und Notizbloecke.
--
-- Drei Erweiterungen am Projekt-Modul:
--
--   1) Zeitraum (start_date/end_date) — bisher hatte ein Projekt nur
--      created_at. Damit war nicht sichtbar, ueber welchen Zeitraum es
--      laeuft. Der Status-Fluss (angefragt/genehmigt/...) bleibt davon
--      unberuehrt: die Daten sind reine Planung, kein zweiter Status.
--
--   2) Termine am Projekt — bewusst KEINE neue Tabelle. Der Kalender
--      liest job_appointments; eine zweite Termin-Quelle muesste dort
--      per UNION zusammengefuehrt werden und wuerde bei jeder Aenderung
--      (Zeitzonen, iCal-Feed, BVG-Forecast) auseinanderlaufen. Statt
--      dessen bekommt job_appointments ein optionales project_id —
--      analog zum bereits optionalen job_id (Migration 015).
--
--   3) project_notes — mehrere benannte Notizbloecke pro Projekt statt
--      eines einzigen Textfelds. Erlaubt gezielte Suche ueber alle
--      Projekte und haelt fest, wer welchen Block zuletzt geaendert hat.
--
-- Nicht enthalten: Angebot/Rechnung als Folgeobjekt. Ein Projekt ist
-- laut 186 ein INTERNER Zeit-Topf ohne Kunden — fuer Kundendokumente
-- ist jobs zustaendig. Stattdessen: duplicate_project() weiter unten.

-- Alles in EINER Transaktion: Abschnitt 3 ersetzt die RLS-Policies auf
-- job_appointments. Bricht die Migration zwischen DROP und CREATE ab,
-- waeren die Termine fuer alle Nutzer unsichtbar. Entweder komplett
-- oder gar nicht.
BEGIN;

-- =====================================================================
-- 1. Zeitraum
-- =====================================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date   date;

-- Beide Felder duerfen leer sein (Projekt ohne feste Planung). Nur wenn
-- beide gesetzt sind, muss das Ende nach dem Start liegen.
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_dates_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_dates_check
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);

CREATE INDEX IF NOT EXISTS projects_start_date_idx
  ON public.projects(start_date) WHERE NOT is_deleted;

COMMENT ON COLUMN public.projects.start_date IS 'Geplanter Projektbeginn. Optional — rein planerisch, beeinflusst den Status-Fluss nicht.';
COMMENT ON COLUMN public.projects.end_date   IS 'Geplantes Projektende. Optional (= offenes Ende).';

-- =====================================================================
-- 2. Zugriffs-Helper
--
-- Wird von den RLS-Policies auf job_appointments und project_notes
-- gebraucht. SECURITY DEFINER, damit die Abfrage auf projects nicht
-- selbst wieder durch die projects-RLS laeuft (Rekursion) — gleiches
-- Muster wie cancel_project() in 189.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.can_access_project(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_admin()
      OR EXISTS (
           SELECT 1 FROM public.projects p
           WHERE p.id = p_project_id
             AND NOT p.is_deleted
             AND (p.assigned_to = auth.uid() OR p.created_by = auth.uid())
         );
$$;

COMMENT ON FUNCTION public.can_access_project IS 'True wenn der aktuelle User das Projekt sehen/bearbeiten darf (Assignee, Ersteller oder Admin). Basis fuer die RLS auf Projekt-Terminen und -Notizen.';

GRANT EXECUTE ON FUNCTION public.can_access_project(uuid) TO authenticated;

-- =====================================================================
-- 3. Termine am Projekt
-- =====================================================================
ALTER TABLE public.job_appointments
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;

-- Partial-Index: die grosse Mehrheit der Termine haengt an einem Job,
-- nicht an einem Projekt. Nur die Projekt-Zeilen indizieren.
CREATE INDEX IF NOT EXISTS job_appointments_project_idx
  ON public.job_appointments(project_id) WHERE project_id IS NOT NULL;

COMMENT ON COLUMN public.job_appointments.project_id IS 'Optionaler Bezug zu einem internen Projekt. Analog zu job_id — ein Termin haengt an einem Auftrag, an einem Projekt oder an keinem von beiden.';

-- RLS erweitern: bisher haengt alles an den kalender:*-Permissions.
-- Ein Mitarbeiter mit eigenem Projekt hat die aber typischerweise nicht
-- und koennte damit auf seinem eigenen Projekt keinen Termin anlegen.
-- Deshalb zusaetzlich: wer das Projekt sehen darf, darf dessen Termine
-- verwalten. Auftrags- und freie Termine bleiben unveraendert.
DROP POLICY IF EXISTS "Termine sehen" ON public.job_appointments;
CREATE POLICY "Termine sehen"
  ON public.job_appointments FOR SELECT TO authenticated
  USING (
    public.has_permission('kalender:view')
    OR assigned_to = auth.uid()
    OR public.is_admin()
    OR (project_id IS NOT NULL AND public.can_access_project(project_id))
  );

DROP POLICY IF EXISTS "Termine anlegen" ON public.job_appointments;
CREATE POLICY "Termine anlegen"
  ON public.job_appointments FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission('kalender:create')
    OR (project_id IS NOT NULL AND public.can_access_project(project_id))
  );

DROP POLICY IF EXISTS "Termine bearbeiten" ON public.job_appointments;
CREATE POLICY "Termine bearbeiten"
  ON public.job_appointments FOR UPDATE TO authenticated
  USING (
    public.has_permission('kalender:edit')
    OR (project_id IS NOT NULL AND public.can_access_project(project_id))
  )
  WITH CHECK (
    public.has_permission('kalender:edit')
    OR (project_id IS NOT NULL AND public.can_access_project(project_id))
  );

DROP POLICY IF EXISTS "Termine löschen" ON public.job_appointments;
CREATE POLICY "Termine löschen"
  ON public.job_appointments FOR DELETE TO authenticated
  USING (
    public.has_permission('kalender:delete')
    OR (project_id IS NOT NULL AND public.can_access_project(project_id))
  );

-- =====================================================================
-- 4. Notizbloecke
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.project_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Notiz',
  body text NOT NULL DEFAULT '',
  -- Reihenfolge in der UI. Luecken sind erlaubt; sortiert wird nach
  -- (position, created_at) damit gleiche Positionen stabil bleiben.
  position integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_notes_project_idx
  ON public.project_notes(project_id, position, created_at);

DROP TRIGGER IF EXISTS project_notes_updated_at ON public.project_notes;
CREATE TRIGGER project_notes_updated_at
  BEFORE UPDATE ON public.project_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.project_notes ENABLE ROW LEVEL SECURITY;

-- DROP davor, damit die Migration wiederholbar ist: bricht sie mittendrin
-- ab, laesst sich die Datei unveraendert nochmal laufen.
DROP POLICY IF EXISTS "project_notes_select" ON public.project_notes;
CREATE POLICY "project_notes_select" ON public.project_notes
  FOR SELECT TO authenticated
  USING (public.can_access_project(project_id));

DROP POLICY IF EXISTS "project_notes_insert" ON public.project_notes;
CREATE POLICY "project_notes_insert" ON public.project_notes
  FOR INSERT TO authenticated
  WITH CHECK (public.can_access_project(project_id));

DROP POLICY IF EXISTS "project_notes_update" ON public.project_notes;
CREATE POLICY "project_notes_update" ON public.project_notes
  FOR UPDATE TO authenticated
  USING (public.can_access_project(project_id))
  WITH CHECK (public.can_access_project(project_id));

DROP POLICY IF EXISTS "project_notes_delete" ON public.project_notes;
CREATE POLICY "project_notes_delete" ON public.project_notes
  FOR DELETE TO authenticated
  USING (public.can_access_project(project_id));

COMMENT ON TABLE public.project_notes IS 'Benannte Notizbloecke pro Projekt. Mehrere Bloecke statt einem Textfeld, damit pro Thema getrennt gesucht und nachvollzogen werden kann wer zuletzt geaendert hat.';

-- Standard-Bloecke beim Anlegen eines Projekts. Bewusst als Trigger und
-- nicht im Frontend: so hat auch ein per API/Import angelegtes Projekt
-- dieselbe Struktur. Bloecke sind loeschbar — wer sie nicht braucht,
-- raeumt sie weg.
CREATE OR REPLACE FUNCTION public.projects_seed_notes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.project_notes (project_id, title, position, created_by)
  VALUES
    (NEW.id, 'Absprachen',     0, NEW.created_by),
    (NEW.id, 'Material',       1, NEW.created_by),
    (NEW.id, 'Offene Punkte',  2, NEW.created_by),
    (NEW.id, 'Intern',         3, NEW.created_by);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS projects_seed_notes ON public.projects;
CREATE TRIGGER projects_seed_notes
  AFTER INSERT ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.projects_seed_notes();

-- =====================================================================
-- 5. Folgeprojekt
--
-- Dupliziert ein Projekt als Vorlage: Titel, Beschreibung, Zuweisung
-- und die Notizblock-STRUKTUR (Titel, Reihenfolge) — aber ohne Inhalte,
-- ohne Zeit-Eintraege, ohne Termine und ohne Budget. Das neue Projekt
-- startet wieder bei 'angefragt' und muss regulaer genehmigt werden;
-- sonst waere das Duplizieren ein Weg, die Budget-Freigabe zu umgehen.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.duplicate_project(
  p_project_id uuid,
  p_title text DEFAULT NULL,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_src public.projects;
  v_new_id uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet';
  END IF;

  SELECT * INTO v_src FROM public.projects WHERE id = p_project_id;
  IF v_src.id IS NULL OR v_src.is_deleted THEN
    RAISE EXCEPTION 'Projekt nicht gefunden';
  END IF;

  IF NOT public.can_access_project(p_project_id) THEN
    RAISE EXCEPTION 'Nicht berechtigt';
  END IF;

  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL AND p_end_date < p_start_date THEN
    RAISE EXCEPTION 'Ende liegt vor dem Start';
  END IF;

  INSERT INTO public.projects (
    title, description, status, proposed_hours, budget_hours,
    assigned_to, created_by, start_date, end_date
  ) VALUES (
    COALESCE(NULLIF(btrim(p_title), ''), v_src.title || ' (Kopie)'),
    v_src.description,
    'angefragt',
    -- Das genehmigte Budget des Originals ist der beste Schaetzwert fuer
    -- den neuen Vorschlag; faellt zurueck auf dessen Vorschlag.
    COALESCE(v_src.budget_hours, v_src.proposed_hours),
    NULL,
    v_src.assigned_to,
    v_uid,
    p_start_date,
    p_end_date
  ) RETURNING id INTO v_new_id;

  -- Der Seed-Trigger hat bereits die Standard-Bloecke angelegt. Die
  -- werden verworfen und durch die Struktur des Originals ersetzt.
  DELETE FROM public.project_notes WHERE project_id = v_new_id;

  INSERT INTO public.project_notes (project_id, title, body, position, created_by)
  SELECT v_new_id, n.title, '', n.position, v_uid
  FROM public.project_notes n
  WHERE n.project_id = p_project_id
  ORDER BY n.position, n.created_at;

  RETURN v_new_id;
END $$;

COMMENT ON FUNCTION public.duplicate_project IS 'Legt ein neues Projekt auf Basis eines bestehenden an (Titel, Beschreibung, Zuweisung, Notizblock-Struktur). Ohne Inhalte, Zeit-Eintraege, Termine und Budget; Status startet bei angefragt.';

GRANT EXECUTE ON FUNCTION public.duplicate_project(uuid, text, date, date) TO authenticated;

COMMIT;
