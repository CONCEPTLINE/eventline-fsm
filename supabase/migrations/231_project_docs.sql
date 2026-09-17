-- 231_project_docs.sql
-- ============================================================
-- Live-Dokumente in Projekten ("Sharepoint"-Idee, Leo 2026-09-17):
-- gemeinsame, gleichzeitig bearbeitbare Dokumente direkt in der App —
-- kein Hin- und Herschicken von Dateien.
--  - project_docs: ein Live-Dokument pro Zeile. ydoc_state = kompletter
--    Kollaborations-Zustand (Yjs, base64), content_html = letzter
--    HTML-Schnappschuss (Versionen/Vorschau).
--  - project_doc_versions: Verlaufs-Schnappschuesse (alle ~10 Min beim
--    aktiven Schreiben), fuer "Verlauf ansehen + wiederherstellen".
-- Live-Sync laeuft ueber Supabase Realtime BROADCAST (kein Table-
-- Replication-Setup noetig).
-- Rechte wie Migration 230: LESEN alle Mitarbeiter (kein Partner),
-- SCHREIBEN Admin / projekte:approve / projekte:see-all / Ersteller /
-- Projektleiter / eingeloggte Mitglieder. Loeschen von Dokumenten:
-- gleiche Schreib-Gruppe; Versionen loescht nur ein Admin.
-- Idempotent.
-- ============================================================

create table if not exists public.project_docs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null default 'Neues Dokument',
  ydoc_state text,
  content_html text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

create index if not exists project_docs_project_idx
  on public.project_docs (project_id, updated_at desc);

create table if not exists public.project_doc_versions (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.project_docs(id) on delete cascade,
  content_html text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists project_doc_versions_doc_idx
  on public.project_doc_versions (doc_id, created_at desc);

alter table public.project_docs enable row level security;
alter table public.project_doc_versions enable row level security;

-- Schreib-Klausel (Beteiligte) als wiederverwendbares Muster:
-- is_admin / projekte:approve / projekte:see-all / Ersteller / Projekt-
-- leiter / Mitglied — identisch zu Migration 230.

drop policy if exists "pdocs_select" on public.project_docs;
create policy "pdocs_select"
  on public.project_docs for select to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
    )
  );

drop policy if exists "pdocs_insert" on public.project_docs;
create policy "pdocs_insert"
  on public.project_docs for insert to authenticated
  with check (
    not public.is_partner()
    and created_by = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pdocs_update" on public.project_docs;
create policy "pdocs_update"
  on public.project_docs for update to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  )
  with check (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pdocs_delete" on public.project_docs;
create policy "pdocs_delete"
  on public.project_docs for delete to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

-- Versionen: lesen wie Doks; anlegen durch Schreibberechtigte (eigener
-- Stempel); loeschen nur Admin (Verlauf soll nicht verschwinden).
drop policy if exists "pdocv_select" on public.project_doc_versions;
create policy "pdocv_select"
  on public.project_doc_versions for select to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id = project_doc_versions.doc_id and not p.is_deleted
    )
  );

drop policy if exists "pdocv_insert" on public.project_doc_versions;
create policy "pdocv_insert"
  on public.project_doc_versions for insert to authenticated
  with check (
    not public.is_partner()
    and created_by = auth.uid()
    and exists (
      select 1 from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id = project_doc_versions.doc_id and not p.is_deleted
        and (
          public.is_admin()
          or public.has_permission('projekte:approve')
          or public.has_permission('projekte:see-all')
          or p.created_by = auth.uid()
          or p.assigned_to = auth.uid()
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists "pdocv_update" on public.project_doc_versions;
create policy "pdocv_update"
  on public.project_doc_versions for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "pdocv_delete" on public.project_doc_versions;
create policy "pdocv_delete"
  on public.project_doc_versions for delete to authenticated
  using (public.is_admin());
