-- Verwaltungsaufwand bekommt eine Zeit-Komponente in Minuten — Teamleiter
-- kann damit den administrativen Aufwand quantifizieren. Das Beschreibungs-
-- Freitext-Feld (verwaltungsaufwand) bleibt fuer Was/Wie, die neue Spalte
-- fuer das Wie-lange.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS verwaltungsaufwand_minutes integer;

COMMENT ON COLUMN public.jobs.verwaltungsaufwand_minutes IS
  'Aufwand in Minuten fuer die Verwaltungs-Taetigkeiten. Wird im Rapport-PDF als h/m formatiert ausgewiesen.';
