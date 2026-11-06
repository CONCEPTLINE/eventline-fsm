-- 386: Ordner im Projekt-Reiter «Dokumente & Historie» speichern
--
-- Bisher lebte ein Ordner nur, solange ein Dokument ihn trug (documents.folder);
-- leere, frisch angelegte Ordner waren nach dem Neuladen weg. Hier werden die
-- Ordner je Projekt gespeichert. Die Zuordnung der Dateien bleibt documents.folder.
--
-- Sehen: wer das Projekt sieht (EXISTS über projects → erbt RLS inkl.
-- versteckter Projekte, Migration 384). Anlegen/Ändern/Löschen: wer im Projekt
-- Inhalte pflegen darf (projekt_pflegbar, Migration 385; nicht im Archiv).
-- Idempotent.

create table if not exists public.project_doc_ordner (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40 and lower(btrim(name)) not in ('alle', 'hauptordner')),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists project_doc_ordner_name_uidx on public.project_doc_ordner (project_id, lower(name));
comment on table public.project_doc_ordner is 'Dokument-Ordner je Projekt, auch leere (Migration 386). Dateien tragen den Namen in documents.folder.';

alter table public.project_doc_ordner enable row level security;
revoke all on public.project_doc_ordner from anon;
grant select, insert, update, delete on public.project_doc_ordner to authenticated;

drop policy if exists pdo_select on public.project_doc_ordner;
create policy pdo_select on public.project_doc_ordner
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (select 1 from public.projects p where p.id = project_doc_ordner.project_id)
  );

drop policy if exists pdo_insert on public.project_doc_ordner;
create policy pdo_insert on public.project_doc_ordner
  for insert to authenticated
  with check (created_by = (select auth.uid()) and public.projekt_pflegbar(project_id));

drop policy if exists pdo_update on public.project_doc_ordner;
create policy pdo_update on public.project_doc_ordner
  for update to authenticated
  using (public.projekt_pflegbar(project_id))
  with check (public.projekt_pflegbar(project_id));

drop policy if exists pdo_delete on public.project_doc_ordner;
create policy pdo_delete on public.project_doc_ordner
  for delete to authenticated
  using (public.projekt_pflegbar(project_id));

-- Bestehende Ordner (aus documents.folder) übernehmen, damit die Liste vollständig ist.
insert into public.project_doc_ordner (project_id, name, created_by)
select distinct on (d.project_id, lower(btrim(d.folder))) d.project_id, btrim(d.folder), null::uuid
from public.documents d
where d.project_id is not null
  and d.folder is not null
  and length(btrim(d.folder)) between 1 and 40
  and lower(btrim(d.folder)) not in ('alle', 'hauptordner')
on conflict do nothing;
