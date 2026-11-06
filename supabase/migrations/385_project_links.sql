-- 385: Links mit Titel im Projekt-Reiter «Dokumente & Historie»
--
-- Sehen: wer das Projekt sieht (EXISTS über projects → erbt RLS inkl.
-- versteckter Projekte, Migration 384).
-- Anlegen/Ändern: wie Projekt-Dokumente (project_docs): Admin, projekte:approve,
-- projekte:see-all, Ersteller, Projektleitung, Mitglieder — nicht im Archiv.
-- Löschen: Admin, projekte:approve oder wer den Link angelegt hat — nicht im Archiv.
-- Nur http(s)-Adressen (kein javascript: o. ä.). Idempotent.

create table if not exists public.project_links (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  titel      text not null check (length(btrim(titel)) between 1 and 200),
  url        text not null check (url ~* '^https?://[^\s]+$' and length(url) <= 2000),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists project_links_project_idx on public.project_links (project_id, created_at);
comment on table public.project_links is 'Links mit Titel je Projekt (Reiter Dokumente & Historie, Migration 385).';

alter table public.project_links enable row level security;
revoke all on public.project_links from anon;
grant select, insert, update, delete on public.project_links to authenticated;

-- Wer darf im Projekt Inhalte pflegen (gleiche Regel wie project_docs).
-- Läuft unter RLS des Aufrufers: unsichtbare Projekte liefern false.
create or replace function public.projekt_pflegbar(p_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = p_id
        and not p.is_deleted
        and p.status not in ('abgeschlossen', 'abgelehnt', 'storniert')
        and (
          (select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid()))
        )
    );
$$;
revoke execute on function public.projekt_pflegbar(uuid) from public, anon;
grant execute on function public.projekt_pflegbar(uuid) to authenticated;

drop policy if exists plinks_select on public.project_links;
create policy plinks_select on public.project_links
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (select 1 from public.projects p where p.id = project_links.project_id)
  );

drop policy if exists plinks_insert on public.project_links;
create policy plinks_insert on public.project_links
  for insert to authenticated
  with check (created_by = (select auth.uid()) and public.projekt_pflegbar(project_id));

drop policy if exists plinks_update on public.project_links;
create policy plinks_update on public.project_links
  for update to authenticated
  using (public.projekt_pflegbar(project_id))
  with check (public.projekt_pflegbar(project_id));

drop policy if exists plinks_delete on public.project_links;
create policy plinks_delete on public.project_links
  for delete to authenticated
  using (
    public.projekt_pflegbar(project_id)
    and (
      created_by = (select auth.uid())
      or (select public.is_admin())
      or (select public.has_permission('projekte:approve'))
    )
  );
