-- 384: Versteckte Projekte
--
-- Nur Admins können ein Projekt verstecken. Ein verstecktes Projekt sehen nur:
--   * Admins
--   * Personen, die ein Admin eingeladen hat (project_freigaben)
-- Sonst niemand — auch nicht Projektleitung, Mitglieder, Ersteller,
-- projekte:see-all oder projekte:approve (Entscheid 06.11.2026).
--
-- Die Einladung ist eine eigene Liste: Wer sich aus dem Projekt ausloggt,
-- bleibt eingeladen.
--
-- Abhängige Tabellen (Termine, Dokumente, Notizen, Audit, documents, Livedoc)
-- prüfen über EXISTS (select … from projects) und erben die Sperre über die
-- RLS von projects. Hier angepasst werden nur die Stellen, die das nicht tun.
-- Idempotent.

-- 1) Spalte + Freigabe-Liste ------------------------------------------------
alter table public.projects add column if not exists versteckt boolean not null default false;
comment on column public.projects.versteckt is
  'true = nur Admins und eingeladene Personen (project_freigaben) sehen das Projekt (Migration 384).';

create table if not exists public.project_freigaben (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_freigaben_user_idx on public.project_freigaben (user_id);
comment on table public.project_freigaben is
  'Wer ein verstecktes Projekt sehen darf (zusätzlich zu Admins). Pflege nur durch Admins (Migration 384).';
alter table public.project_freigaben enable row level security;
revoke all on public.project_freigaben from anon;
grant select, insert, update, delete on public.project_freigaben to authenticated;

-- 2) Sichtbarkeits-Helfer ----------------------------------------------------
-- security definer: liest projects/project_freigaben ohne RLS,
-- damit die Policies sich nicht gegenseitig aufrufen (keine Rekursion).
create or replace function public.projekt_sichtbar(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = p_id
      and (
        not p.versteckt
        or (select public.is_admin())
        or exists (select 1 from public.project_freigaben f
                   where f.project_id = p.id and f.user_id = (select auth.uid()))
      )
  );
$$;
revoke execute on function public.projekt_sichtbar(uuid) from public, anon;
grant execute on function public.projekt_sichtbar(uuid) to authenticated;

-- 3) Nur Admins dürfen verstecken / sichtbar machen -------------------------
create or replace function public.projects_versteckt_schutz()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server (Service-Rolle) und Systemjobs haben keine auth.uid().
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.versteckt and not public.is_admin() then
      raise exception using errcode = '42501', message = 'Nur Admins können versteckte Projekte anlegen.';
    end if;
  elsif new.versteckt is distinct from old.versteckt and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Nur Admins können ein Projekt verstecken oder wieder sichtbar machen.';
  end if;
  return new;
end;
$$;
revoke execute on function public.projects_versteckt_schutz() from public, anon;

drop trigger if exists projects_versteckt_schutz on public.projects;
create trigger projects_versteckt_schutz
  before insert or update of versteckt on public.projects
  for each row execute function public.projects_versteckt_schutz();

-- 4) projects: alle 4 Verben ------------------------------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (
    (not is_deleted)
    and (not (select public.is_portal_user()))
    and (not versteckt or (select public.is_admin()) or public.projekt_sichtbar(id))
  );

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    (select public.is_internal_user())
    and (not versteckt or (select public.is_admin()))
    and (
      (select public.has_permission('projekte:approve'))
      or (
        created_by = (select auth.uid())
        and assigned_to = (select auth.uid())
        and status = any (array['entwurf'::text, 'angefragt'::text])
        and budget_hours is null
        and approved_by is null
      )
    )
  );

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (
    (select public.is_internal_user())
    and (not is_deleted)
    and (not versteckt or (select public.is_admin()) or public.projekt_sichtbar(id))
    and (
      (select public.has_permission('projekte:approve'))
      or created_by = (select auth.uid())
      or assigned_to = (select auth.uid())
      or exists (select 1 from public.project_members pm
                 where pm.project_id = projects.id and pm.user_id = (select auth.uid()))
    )
  )
  with check (
    (select public.is_internal_user())
    and (is_deleted = false)
    and (
      (select public.has_permission('projekte:approve'))
      or created_by = (select auth.uid())
      or assigned_to = (select auth.uid())
      or exists (select 1 from public.project_members pm
                 where pm.project_id = projects.id and pm.user_id = (select auth.uid()))
    )
  );

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated
  using (
    (select public.is_internal_user())
    and (select public.has_permission('projekte:approve'))
    and (not versteckt or (select public.is_admin()) or public.projekt_sichtbar(id))
    and (status <> all (array['abgeschlossen'::text, 'abgelehnt'::text, 'storniert'::text]))
  );

-- 5) project_freigaben: alle 4 Verben ---------------------------------------
drop policy if exists pf_select on public.project_freigaben;
create policy pf_select on public.project_freigaben
  for select to authenticated
  using ((select public.is_internal_user()) and public.projekt_sichtbar(project_id));

drop policy if exists pf_insert on public.project_freigaben;
create policy pf_insert on public.project_freigaben
  for insert to authenticated
  with check ((select public.is_admin()));

drop policy if exists pf_update on public.project_freigaben;
create policy pf_update on public.project_freigaben
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists pf_delete on public.project_freigaben;
create policy pf_delete on public.project_freigaben
  for delete to authenticated
  using ((select public.is_admin()));

-- 6) project_members: Mitgliedschaften versteckter Projekte nicht verraten,
--    Selbst-Einloggen nur in Projekte, die man sehen darf.
drop policy if exists pm_select on public.project_members;
create policy pm_select on public.project_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.projekt_sichtbar(project_id));

drop policy if exists pm_insert on public.project_members;
create policy pm_insert on public.project_members
  for insert to authenticated
  with check (
    (select public.is_admin())
    or (user_id = (select auth.uid()) and public.projekt_sichtbar(project_id))
  );
-- pm_delete (selbst ausloggen oder Admin) bleibt unverändert.

-- 7) project_time_entries: «alle Projekte sehen» gilt nicht für versteckte.
drop policy if exists pte_select on public.project_time_entries;
create policy pte_select on public.project_time_entries
  for select to public
  using (
    user_id = (select auth.uid())
    or (select public.is_admin())
    or ((select public.has_permission('projekte:see-all')) and public.projekt_sichtbar(project_id))
    or exists (
      select 1 from public.projects p
      where p.id = project_time_entries.project_id
        and (p.assigned_to = (select auth.uid()) or p.created_by = (select auth.uid()))
    )
  );
-- pte_select_team (Teamleitung sieht die Zeiten ihres Teams) bleibt: dort
-- geht es um Arbeitszeit, Projektname/-inhalt bleibt über projects gesperrt.

-- 8) security-definer-Funktionen, die projects ohne RLS lesen ---------------
create or replace function public.livedoc_bearbeitbar(p_thema text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_thema like 'livedoc:%', false)
    and (select public.is_internal_user())
    and exists (
      select 1
      from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id::text = substr(p_thema, 9)
        and not p.is_deleted
        and public.projekt_sichtbar(p.id)
        and (
          (select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (
            select 1 from public.project_members pm
            where pm.project_id = p.id and pm.user_id = (select auth.uid())
          )
        )
    );
$$;

create or replace function public.cancel_project(p_project_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Begruendung ist Pflicht';
  end if;

  select * into v_project from public.projects where id = p_project_id;
  if v_project.id is null or not public.projekt_sichtbar(p_project_id) then
    raise exception 'Projekt nicht gefunden';
  end if;

  if v_project.is_deleted then
    raise exception 'Projekt bereits geloescht';
  end if;

  if v_project.status in ('abgeschlossen', 'abgelehnt', 'storniert') then
    raise exception 'Projekt ist bereits im Endzustand (%)', v_project.status;
  end if;

  -- Berechtigt: Admin, has_permission approve, oder der Assignee selbst.
  if not (
    public.is_admin()
    or public.has_permission('projekte:approve')
    or v_project.assigned_to = v_uid
    or v_project.created_by = v_uid
  ) then
    raise exception 'Nicht berechtigt';
  end if;

  update public.projects
    set status = 'storniert',
        decision_note = btrim(p_reason),
        approved_by = v_uid,
        approved_at = now()
    where id = p_project_id;
end $$;

create or replace function public.projekt_loeschen(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    text;
  v_geloescht boolean;
begin
  if not (public.is_internal_user() and public.has_permission('projekte:approve')) then
    raise exception using errcode = '42501', message = 'Keine Berechtigung, Projekte zu löschen.';
  end if;

  select p.status, p.is_deleted into v_status, v_geloescht
    from public.projects p
   where p.id = p_project_id
     for update;
  if not found or v_geloescht or not public.projekt_sichtbar(p_project_id) then
    raise exception using errcode = 'PT404', message = 'Projekt nicht gefunden.';
  end if;

  -- Archiv = nur lesen (Migration 342) — gleiche Meldung wie die DB-Sperre.
  if v_status in ('abgeschlossen', 'abgelehnt', 'storniert') then
    raise exception using errcode = 'PT409',
      message = 'Das Projekt ist archiviert (abgeschlossen, abgelehnt oder storniert) und kann nur noch gelesen werden.';
  end if;

  update public.projects set is_deleted = true where id = p_project_id;
end;
$$;

-- 9) Archiv-Sperre (Migration 342): Verstecken/Sichtbar machen ist auch bei
--    archivierten Projekten erlaubt — Sichtbarkeit ist kein Projektinhalt.
create or replace function public.archiv_schutz_projekte()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c_meldung constant text :=
    'Das Projekt ist archiviert (abgeschlossen, abgelehnt oder storniert) und kann nur noch gelesen werden.';
  c_frei constant text[] := array['updated_at', 'is_deleted', 'versteckt'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.status not in ('abgeschlossen', 'abgelehnt', 'storniert') then
    return new;
  end if;
  if (to_jsonb(new) - c_frei) is distinct from (to_jsonb(old) - c_frei) then
    raise exception using errcode = 'PT409', message = c_meldung;
  end if;
  return new;
end;
$$;
