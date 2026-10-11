-- Migration 301: Rapport-Rechte fuer zugeteilte Techniker (Mobile-Overhaul,
-- Entscheid Mischa 2026-10-11, README Welle 2 Punkt 1).
--
-- Bisher: service_reports UPDATE nur Ersteller (006) oder Admin; report_photos
-- INSERT nur Ersteller/Admin (069), DELETE nur Admin (006), UPDATE gar nicht.
-- Folge: oeffnet ein zweiter Techniker den Entwurf des Kollegen, aendert sein
-- Autosave 0 Zeilen, Fotos scheitern, Loeschen loescht nur die Datei.
--
-- Neu: Alle Techniker, die ueber job_appointments.assigned_to dem Auftrag
-- zugeteilt sind, duerfen den EINEN Entwurf des Auftrags bearbeiten (UPDATE)
-- und Fotos daran anlegen/aendern/loeschen. Ersteller und Admin wie bisher.
-- SELECT bleibt (234: alle aktiven Nicht-Portal-Nutzer). Der Abschluss-
-- Trigger (106) und der Unique-Entwurf-Index (122) bleiben unveraendert.
--
-- Idempotent: Policies werden ersetzt (DROP IF EXISTS + CREATE). Nur
-- additiv — keine Tabellen-/Spaltenaenderung.

-- Hilfsfunktion: ist der aufrufende Nutzer dem Auftrag des Rapports zugeteilt?
-- SECURITY DEFINER, damit die RLS auf job_appointments die Pruefung nicht
-- selbst wieder einschraenkt. STABLE: innerhalb einer Abfrage konstant.
CREATE OR REPLACE FUNCTION public.is_assigned_to_report_job(p_report_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.service_reports r
    JOIN public.job_appointments a ON a.job_id = r.job_id
    WHERE r.id = p_report_id
      AND a.assigned_to = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_assigned_to_report_job(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_report_job(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- service_reports: UPDATE fuer zugeteilte Techniker (zusaetzlich zu
-- "Ersteller können Rapporte bearbeiten" und "Admins können alle Rapporte
-- bearbeiten" aus 006 — die bleiben bestehen).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Zugeteilte Techniker können Rapporte bearbeiten" ON public.service_reports;
CREATE POLICY "Zugeteilte Techniker können Rapporte bearbeiten"
  ON public.service_reports FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.job_appointments a
      WHERE a.job_id = service_reports.job_id
        AND a.assigned_to = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.job_appointments a
      WHERE a.job_id = service_reports.job_id
        AND a.assigned_to = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- report_photos: INSERT / UPDATE / DELETE fuer Ersteller des Rapports,
-- zugeteilte Techniker und Admin. SELECT (069/234-Stand) bleibt.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Benutzer können Fotos hochladen" ON public.report_photos;
CREATE POLICY "Benutzer können Fotos hochladen"
  ON public.report_photos FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR public.is_assigned_to_report_job(report_photos.report_id)
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id AND r.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Rapport-Beteiligte können Fotos ändern" ON public.report_photos;
CREATE POLICY "Rapport-Beteiligte können Fotos ändern"
  ON public.report_photos FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR public.is_assigned_to_report_job(report_photos.report_id)
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id AND r.created_by = auth.uid()
    )
  )
  WITH CHECK (
    public.is_admin()
    OR public.is_assigned_to_report_job(report_photos.report_id)
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id AND r.created_by = auth.uid()
    )
  );

-- Ersetzt "Admins können Fotos löschen" (006) durch die breitere Regel.
DROP POLICY IF EXISTS "Admins können Fotos löschen" ON public.report_photos;
DROP POLICY IF EXISTS "Rapport-Beteiligte können Fotos löschen" ON public.report_photos;
CREATE POLICY "Rapport-Beteiligte können Fotos löschen"
  ON public.report_photos FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR public.is_assigned_to_report_job(report_photos.report_id)
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id AND r.created_by = auth.uid()
    )
  );
