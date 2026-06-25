-- Auftrag: Freitext-Feld Verwaltungsaufwand. Beschreibt aus Sicht der
-- Team-Leitung wie aufwendig der Auftrag administrativ war (Offerten-
-- Iterationen, Telefonate, Sonderwuensche...). Wird im Rapport-PDF
-- separat ausgewiesen damit der Kunde sieht warum ein scheinbar
-- einfacher Termin doch viel Hintergrundarbeit hatte.
--
-- Nur auftraege:edit darf schreiben (UI-Gate). Read ist team-weit
-- offen (selbe RLS wie jobs.notes — gehoert zum Auftrag).

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS verwaltungsaufwand text;

COMMENT ON COLUMN public.jobs.verwaltungsaufwand IS
  'Freitext, beschreibt den administrativen Aufwand. Nur Teamleiter (auftraege:edit) duerfen schreiben — UI-Gate. Wird im Rapport-PDF mit ausgewiesen.';
