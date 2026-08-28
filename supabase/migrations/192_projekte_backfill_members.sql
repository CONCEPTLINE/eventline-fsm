-- Backfill: fuer alle genehmigten Projekte, wo der Assignee noch NICHT
-- in project_members ist, den Assignee als Member ergaenzen. Damit
-- taucht sein Avatar in der Card auf und er kann direkt stempeln —
-- ohne extra "Einloggen"-Klick.
--
-- Neu-angelegte Projekte kriegen das ueber die Application-Logik
-- (neu/page.tsx) automatisch; diese Migration deckt nur Alt-Bestand.

INSERT INTO public.project_members (project_id, user_id)
SELECT p.id, p.assigned_to
FROM public.projects p
WHERE p.status = 'genehmigt'
  AND NOT p.is_deleted
  AND NOT EXISTS (
    SELECT 1 FROM public.project_members m
    WHERE m.project_id = p.id AND m.user_id = p.assigned_to
  );
