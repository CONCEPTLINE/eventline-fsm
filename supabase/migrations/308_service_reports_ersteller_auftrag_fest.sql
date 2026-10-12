-- 308_service_reports_ersteller_auftrag_fest.sql — Ersteller und Auftrag eines
-- Rapports sind fuer Nicht-Admins unveraenderlich.
--
-- Datum: 2026-10-12. Befund aus dem Review der Handy-Ansicht (Migration 306).
--
-- Luecke: Die Policy «Zugeteilte Techniker können Rapporte bearbeiten» (306)
-- prueft im WITH CHECK nur die Zuteilung zum Auftrag. authenticated hat
-- UPDATE-Recht auf alle Spalten, kein Trigger schuetzt created_by/job_id.
-- Ein zugeteilter Techniker kann so per PostgREST «created_by = ich» auf den
-- Entwurf eines Kollegen setzen. Ab dann greift fuer ihn «Ersteller können
-- Rapporte bearbeiten» (006) — ohne Status-Bedingung: nach dem Abschluss
-- liessen sich time_ranges/Text aendern oder der Status zurueck auf
-- 'entwurf' setzen (damit waeren auch die Fotos wieder beschreibbar). Mit
-- job_id liesse sich ein fremder Entwurf auf einen anderen Auftrag schieben.
--
-- Fix: BEFORE-UPDATE-Trigger. Fuer Aufrufe ueber die API (Rolle anon bzw.
-- authenticated) ohne Admin-Recht bleiben created_by und job_id auf dem
-- alten Wert. Bewusst KEIN Fehler, sondern Beibehalten: der Abschluss am
-- Computer (rapport-form-modal.tsx, finalPayload) schickt created_by =
-- eigener Nutzer und job_id mit. Ein Fehler wuerde den Abschluss fuer jeden
-- zugeteilten Techniker brechen, der den Rapport nicht selbst angelegt hat.
-- So bleibt der Ersteller einfach der, der den Entwurf angelegt hat.
-- Fuer den Ersteller selbst aendert sich nichts (gleiche Werte).
-- Admins (is_admin) duerfen weiter alles — auch den bisherigen Ersteller-
-- Wechsel beim Abschluss am Computer. service_role (API-Routen mit Admin-
-- Client, z. B. /api/reports/[id]/finalize) und Wartung als postgres sind
-- nicht betroffen (current_user ist dort nicht anon/authenticated), ebenso
-- FK-Aktionen (laufen als Tabellen-Eigentuemer).
--
-- Trigger-Name beginnt mit «f»: BEFORE-Trigger laufen alphabetisch, so sieht
-- prevent_dup_abgeschlossen_report_trg (106) schon die festgehaltene job_id.
--
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS. Keine Tabellen-/
-- Spaltenaenderung.
-- EINGESPIELT 2026-10-12 (Mobile-Session), Trigger live geprueft.
--
-- Nachpruefung nach dem Einspielen (read-only):
--   select tgname from pg_trigger
--   where tgrelid = 'public.service_reports'::regclass and not tgisinternal;
--   -- erwartet: fixiere_rapport_ersteller_auftrag_trg, prevent_dup_abgeschlossen_report_trg

CREATE OR REPLACE FUNCTION public.fixiere_rapport_ersteller_auftrag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Bewusst kein SECURITY DEFINER: current_user ist die Rolle des Aufrufers.
  IF current_user IN ('anon', 'authenticated') AND NOT public.is_admin() THEN
    NEW.created_by := OLD.created_by;
    NEW.job_id := OLD.job_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fixiere_rapport_ersteller_auftrag_trg ON public.service_reports;
CREATE TRIGGER fixiere_rapport_ersteller_auftrag_trg
BEFORE UPDATE ON public.service_reports
FOR EACH ROW
EXECUTE FUNCTION public.fixiere_rapport_ersteller_auftrag();
