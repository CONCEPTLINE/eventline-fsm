-- Migration 306: Rapport-Rechte fuer zugeteilte Techniker (Mobile-Overhaul,
-- Entscheid Mischa 2026-10-11, README Welle 2 Punkt 1).
--
-- Bisher: service_reports UPDATE nur Ersteller (006) oder Admin; report_photos
-- INSERT nur Ersteller/Admin (069), DELETE nur Admin (006), UPDATE gar nicht.
-- Folge: oeffnet ein zweiter Techniker den Entwurf des Kollegen, aendert sein
-- Autosave 0 Zeilen, Fotos scheitern, Loeschen loescht nur die Datei.
--
-- Neu: Alle Techniker, die ueber job_appointments.assigned_to dem Auftrag
-- zugeteilt sind, duerfen den EINEN Entwurf des Auftrags bearbeiten (UPDATE)
-- und Fotos daran sehen/anlegen/aendern/loeschen (Schreiben nur, solange der
-- Rapport ein Entwurf ist — siehe report_photos unten). Admin wie bisher. service_reports SELECT bleibt (234: alle aktiven Nicht-Portal-
-- Nutzer). report_photos SELECT war nur Ersteller/Admin (069) — ohne
-- Erweiterung verschwaende ein frisch hochgeladenes Foto des zugeteilten
-- Technikers sofort wieder aus seiner Liste. Der Abschluss-Trigger (106) und
-- der Unique-Entwurf-Index (122) bleiben unveraendert.
--
-- Schreibweise wie Migration 305 (RLS-InitPlan): Helfer ohne Zeilenbezug als
-- ( SELECT auth.uid() ) bzw. ( SELECT public.is_admin() ) — Postgres rechnet
-- sie einmal pro Abfrage statt pro Zeile. is_assigned_to_report_job(report_id)
-- haengt von der Zeile ab und bleibt ungewrappt. 305 hat die hier ersetzten
-- Policies bewusst ausgelassen (ausser «Fotos sind sichtbar», das hier ohnehin
-- neu angelegt wird).
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
      AND a.assigned_to = ( SELECT auth.uid() )
  );
$$;

REVOKE ALL ON FUNCTION public.is_assigned_to_report_job(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_assigned_to_report_job(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- service_reports: UPDATE fuer zugeteilte Techniker (zusaetzlich zu
-- "Ersteller können Rapporte bearbeiten" und "Admins können alle Rapporte
-- bearbeiten" aus 006 — die bleiben bestehen). Nur solange der Rapport ein
-- Entwurf ist (USING prueft die alte Zeile); der Abschluss selbst (neue Zeile
-- mit status 'abgeschlossen') bleibt ueber WITH CHECK moeglich.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Zugeteilte Techniker können Rapporte bearbeiten" ON public.service_reports;
CREATE POLICY "Zugeteilte Techniker können Rapporte bearbeiten"
  ON public.service_reports FOR UPDATE TO authenticated
  USING (
    service_reports.status = 'entwurf'
    AND EXISTS (
      SELECT 1 FROM public.job_appointments a
      WHERE a.job_id = service_reports.job_id
        AND a.assigned_to = ( SELECT auth.uid() )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.job_appointments a
      WHERE a.job_id = service_reports.job_id
        AND a.assigned_to = ( SELECT auth.uid() )
    )
  );

-- ---------------------------------------------------------------------------
-- report_photos: alle vier Verben fuer Ersteller des Rapports, zugeteilte
-- Techniker und Admin. Schreiben (INSERT/UPDATE/DELETE) fuer Nicht-Admins nur,
-- solange der Rapport noch status = 'entwurf' hat — ein abgeschlossener
-- Rapport (PDF steht) bekommt keine Fotos mehr dazu und verliert keine
-- (z. B. ein Handy, das nach dem Abschluss am Computer noch Fotos sendet).
-- Gilt bewusst auch fuer den Ersteller: Der Desktop aendert Fotos eines
-- abgeschlossenen Rapports nie (Modal schreibgeschuetzt — kein Hochladen,
-- kein Loeschen, Beschriftung gesperrt), UPDATE/DELETE hatte der Ersteller
-- vor 306 ohnehin nicht, und laufende Uploads/Beschriftungen (800 ms) sind
-- durch die 8-s-Bestaetigung vor dem Abschluss durch. Ohne Ersteller waere
-- gerade der haeufigste Fall (Techniker legt am Handy an, Buero schliesst
-- ab) nicht geschuetzt. Admin darf weiter alles.
-- ---------------------------------------------------------------------------
-- Ersetzt "Fotos sind sichtbar" (069, gewrappt in 305: nur Ersteller/Admin).
DROP POLICY IF EXISTS "Fotos sind sichtbar" ON public.report_photos;
CREATE POLICY "Fotos sind sichtbar"
  ON public.report_photos FOR SELECT TO authenticated
  USING (
    ( SELECT public.is_admin() )
    OR public.is_assigned_to_report_job(report_photos.report_id)
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id AND r.created_by = ( SELECT auth.uid() )
    )
  );

-- Ersetzt "Benutzer können Fotos hochladen" (069: nur Ersteller/Admin).
DROP POLICY IF EXISTS "Benutzer können Fotos hochladen" ON public.report_photos;
CREATE POLICY "Benutzer können Fotos hochladen"
  ON public.report_photos FOR INSERT TO authenticated
  WITH CHECK (
    ( SELECT public.is_admin() )
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id
        AND r.status = 'entwurf'
        AND (r.created_by = ( SELECT auth.uid() ) OR public.is_assigned_to_report_job(r.id))
    )
  );

DROP POLICY IF EXISTS "Rapport-Beteiligte können Fotos ändern" ON public.report_photos;
CREATE POLICY "Rapport-Beteiligte können Fotos ändern"
  ON public.report_photos FOR UPDATE TO authenticated
  USING (
    ( SELECT public.is_admin() )
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id
        AND r.status = 'entwurf'
        AND (r.created_by = ( SELECT auth.uid() ) OR public.is_assigned_to_report_job(r.id))
    )
  )
  WITH CHECK (
    ( SELECT public.is_admin() )
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id
        AND r.status = 'entwurf'
        AND (r.created_by = ( SELECT auth.uid() ) OR public.is_assigned_to_report_job(r.id))
    )
  );

-- Ersetzt "Admins können Fotos löschen" (006) durch die breitere Regel.
DROP POLICY IF EXISTS "Admins können Fotos löschen" ON public.report_photos;
DROP POLICY IF EXISTS "Rapport-Beteiligte können Fotos löschen" ON public.report_photos;
CREATE POLICY "Rapport-Beteiligte können Fotos löschen"
  ON public.report_photos FOR DELETE TO authenticated
  USING (
    ( SELECT public.is_admin() )
    OR EXISTS (
      SELECT 1 FROM public.service_reports r
      WHERE r.id = report_photos.report_id
        AND r.status = 'entwurf'
        AND (r.created_by = ( SELECT auth.uid() ) OR public.is_assigned_to_report_job(r.id))
    )
  );
