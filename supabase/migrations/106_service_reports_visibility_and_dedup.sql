-- Migration 106: service_reports SELECT-RLS oeffnen + Doppel-Schutz
--
-- Hintergrund: INT-26239 hatte zwei abgeschlossene Rapporte. Ursache:
-- Mathis hatte Rapport-1 abgeschlossen; Tim sah ihn am naechsten Morgen
-- via stale UI und oeffnete das Rapport-Modal nochmal. Der Modal-Loader
-- prueft per RLS-SELECT ob schon ein Rapport existiert — die SELECT-
-- Policy beschraenkte aber auf created_by = self ODER is_admin. Tim sah
-- damit Mathis' Rapport nicht, Modal blieb editierbar, ein 2. Rapport
-- wurde angelegt.
--
-- Fix:
-- 1) SELECT-Policy oeffnet sich fuer alle aktiven EVENTLINE-User
--    (non-partner). Rapporte sind interne Dokumente — wer den Job sehen
--    darf, darf auch die Rapporte sehen.
-- 2) BEFORE-INSERT/UPDATE-Trigger blockiert weitere Writes sobald ein
--    abgeschlossener Rapport existiert — Defense-in-Depth, falls die UI
--    den Stale-State-Race trotzdem mal verliert. Existierende Doppel
--    (z.B. INT-26239) bleiben unangetastet — Trigger feuert nur auf
--    neuen Writes. Bewusst KEIN partial unique index, weil der die
--    bestehenden Duplikate sofort blockieren wuerde.

DROP POLICY IF EXISTS "Rapporte sind sichtbar" ON public.service_reports;
CREATE POLICY "Rapporte sind sichtbar" ON public.service_reports
FOR SELECT
USING (
  is_admin()
  OR created_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
      AND p.role <> 'partner'
  )
);

CREATE OR REPLACE FUNCTION public.prevent_duplicate_abgeschlossen_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Wenn fuer denselben Job bereits ein abgeschlossener Rapport existiert
  -- (und es NICHT die eigene Row ist, die geupdated wird), blockieren.
  -- Gilt fuer Entwurfs-INSERT genauso wie fuer Status-Wechsel-UPDATE —
  -- ein abgeschlossener Rapport schliesst weitere Rapport-Aktivitaet ab.
  IF EXISTS (
    SELECT 1 FROM public.service_reports
    WHERE job_id = NEW.job_id
      AND status = 'abgeschlossen'
      AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Für diesen Auftrag existiert bereits ein abgeschlossener Rapport — bitte Seite neu laden.'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_dup_abgeschlossen_report_trg ON public.service_reports;
CREATE TRIGGER prevent_dup_abgeschlossen_report_trg
BEFORE INSERT OR UPDATE ON public.service_reports
FOR EACH ROW
EXECUTE FUNCTION public.prevent_duplicate_abgeschlossen_report();
