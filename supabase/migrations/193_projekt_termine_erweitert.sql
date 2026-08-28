-- Projekt-Termine erweitert:
-- 1) Teilnehmer je Termin (Mitarbeiter aus profiles + Kunden aus customers)
--    → project_appointment_participants
-- 2) Gesprächsprotokolle / Notes je Termin (nachtraeglich befuellbar)
--    → project_appointment_notes
--    Speichert freien Text, optional Audio-Storage-Pfad + Transkript
--    fuer spaetere KI-Zusammenfassung.

-- Teilnehmer
CREATE TABLE IF NOT EXISTS public.project_appointment_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.project_appointments(id) ON DELETE CASCADE,
  -- Genau eins von profile_id / customer_id gesetzt (XOR)
  profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pap_one_of_profile_or_customer CHECK (
    (profile_id IS NOT NULL AND customer_id IS NULL)
    OR (profile_id IS NULL AND customer_id IS NOT NULL)
  ),
  CONSTRAINT pap_unique_profile UNIQUE (appointment_id, profile_id),
  CONSTRAINT pap_unique_customer UNIQUE (appointment_id, customer_id)
);
CREATE INDEX IF NOT EXISTS pap_appt_idx ON public.project_appointment_participants(appointment_id);

ALTER TABLE public.project_appointment_participants ENABLE ROW LEVEL SECURITY;

-- Sichtbar / editierbar wenn der Termin sichtbar/editierbar ist (piggyback auf project_appointments-RLS)
CREATE POLICY "pap_select" ON public.project_appointment_participants
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.project_appointments a WHERE a.id = appointment_id));
CREATE POLICY "pap_insert" ON public.project_appointment_participants
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.project_appointments a
    JOIN public.projects p ON p.id = a.project_id
    WHERE a.id = appointment_id
      AND (public.is_admin() OR public.has_permission('projekte:see-all') OR a.created_by = auth.uid() OR p.assigned_to = auth.uid())
  ));
CREATE POLICY "pap_delete" ON public.project_appointment_participants
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.project_appointments a
    JOIN public.projects p ON p.id = a.project_id
    WHERE a.id = appointment_id
      AND (public.is_admin() OR public.has_permission('projekte:see-all') OR a.created_by = auth.uid() OR p.assigned_to = auth.uid())
  ));

-- Gespraechs-Notizen / Protokolle
CREATE TABLE IF NOT EXISTS public.project_appointment_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.project_appointments(id) ON DELETE CASCADE,
  -- Rein textuelles Protokoll (kann per KI-Zusammenfassung entstehen)
  content text NOT NULL,
  -- Optional: Storage-Pfad zur Audio-Aufnahme (kommt in Iteration 2)
  audio_path text,
  -- Optional: Raw-Transkript (aus Whisper o.ae.) vor der KI-Zusammenfassung
  transcript text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pan_appt_idx ON public.project_appointment_notes(appointment_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.pan_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS pan_touch_updated_at ON public.project_appointment_notes;
CREATE TRIGGER pan_touch_updated_at BEFORE UPDATE ON public.project_appointment_notes FOR EACH ROW EXECUTE FUNCTION public.pan_touch_updated_at();

ALTER TABLE public.project_appointment_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pan_select" ON public.project_appointment_notes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.project_appointments a WHERE a.id = appointment_id));
CREATE POLICY "pan_insert" ON public.project_appointment_notes
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.project_appointments a
    JOIN public.projects p ON p.id = a.project_id
    WHERE a.id = appointment_id
      AND (public.is_admin() OR public.has_permission('projekte:see-all') OR a.created_by = auth.uid() OR p.assigned_to = auth.uid()
           OR EXISTS (SELECT 1 FROM public.project_members m WHERE m.project_id = a.project_id AND m.user_id = auth.uid()))
  ));
CREATE POLICY "pan_update" ON public.project_appointment_notes
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR created_by = auth.uid())
  WITH CHECK (public.is_admin() OR created_by = auth.uid());
CREATE POLICY "pan_delete" ON public.project_appointment_notes
  FOR DELETE TO authenticated
  USING (public.is_admin() OR created_by = auth.uid());

COMMENT ON TABLE public.project_appointment_participants IS 'Teilnehmer eines Projekt-Termins (Mitarbeiter ODER Kunde).';
COMMENT ON TABLE public.project_appointment_notes IS 'Gespraechs-Protokolle zu einem Termin (Text + optional Audio-Pfad + Transkript).';
