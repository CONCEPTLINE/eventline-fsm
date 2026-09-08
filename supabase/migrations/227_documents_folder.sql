-- 227_documents_folder.sql
-- ============================================================
-- Ordner fuer hochgeladene Dokumente (Auftrag + Projekt).
-- Bewusst simpel ("less but intuitive"): EINE Ordner-Ebene als
-- Text-Attribut pro Dokument. NULL = Hauptordner. Keine eigene
-- Ordner-Tabelle, kein FK — ein Ordner existiert, solange
-- Dokumente ihn tragen (frisch angelegte leere Ordner leben bis
-- zum ersten Upload nur im Client-State).
-- Standort-Dokumente brauchen KEINE Migration — dort liegen die
-- Docs als JSON-Array in locations.technical_details und tragen
-- den Ordner als optionales JSON-Property `folder`.
-- Idempotent.
-- ============================================================

alter table public.documents
  add column if not exists folder text;

comment on column public.documents.folder is
  'Ordner-Name (eine Ebene, frei benannt, z.B. "Pläne"). NULL = Hauptordner. Kein FK — Ordner existiert solange Dokumente ihn tragen.';

-- ------------------------------------------------------------
-- UPDATE-Policy: documents hatte bis jetzt nur select/insert/delete-
-- Policies — ein update({folder}) vom Client wuerde unter RLS still
-- 0 Zeilen treffen ("Verschieben" ohne Wirkung). Staff darf Dokumente
-- verschieben, die er sehen/bearbeiten kann; Partner-Portal-User
-- explizit NICHT (die Verschieben-UI existiert nur im Staff-Bereich).
-- Die EXISTS-Subqueries stehen selbst unter jobs-/projects-RLS und
-- erben damit die Auftrag-/Projekt-Sichtbarkeit (Muster Migration 126).
-- Hinweis: RLS ist nicht spaltengenau — die App aendert nur `folder`;
-- wer hier matcht, sieht/bearbeitet das Dokument ohnehin schon.
-- ------------------------------------------------------------

drop policy if exists "documents_update_folder_staff" on public.documents;

create policy "documents_update_folder_staff"
  on public.documents for update to authenticated
  using (
    not public.is_partner()
    and (
      uploaded_by = auth.uid()
      or public.is_admin()
      or (job_id is not null and exists (
        select 1 from public.jobs j where j.id = documents.job_id
      ))
      or (project_id is not null and exists (
        select 1 from public.projects p where p.id = documents.project_id
      ))
    )
  )
  with check (
    not public.is_partner()
    and (
      uploaded_by = auth.uid()
      or public.is_admin()
      or (job_id is not null and exists (
        select 1 from public.jobs j where j.id = documents.job_id
      ))
      or (project_id is not null and exists (
        select 1 from public.projects p where p.id = documents.project_id
      ))
    )
  );
