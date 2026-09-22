-- Fix: Interne Mitarbeiter sahen in Projekten nur selbst hochgeladene
-- Dokumente. Es gab SELECT-Policies fuer eigene Docs, Admins, Partner
-- und Auftrags-Dokumente (via job_id) — aber keine fuer
-- Projekt-Dokumente (project_id). Die UPDATE-Policy hatte den
-- project_id-Zweig bereits; hier zieht SELECT nach: sichtbar, wenn das
-- Projekt selbst fuer den User sichtbar ist (projects-RLS greift im
-- EXISTS). Partner/Lieferanten bleiben aussen vor.

drop policy if exists "documents_select_via_project" on public.documents;
create policy "documents_select_via_project" on public.documents
  for select using (
    (not public.is_partner())
    and (not public.is_lieferant())
    and project_id is not null
    and exists (select 1 from public.projects p where p.id = documents.project_id)
  );
