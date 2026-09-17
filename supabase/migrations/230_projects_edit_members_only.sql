-- 230_projects_edit_members_only.sql
-- ============================================================
-- Korrektur zu 229: Leo meinte mit "jeder der sich einloggt" das
-- EINLOGGEN AUF DEM PROJEKT (project_members, der "Einloggen"-Button
-- vor dem Stempeln) — nicht jeden App-Login.
-- Bearbeiten duerfen also: Admin / projekte:approve bzw. see-all /
-- Ersteller / Projektleiter (assigned_to) / eingeloggte MITGLIEDER.
-- Loeschen (is_deleted) bleibt DB-seitig Admin-only, geloeschte
-- Projekte fasst nur ein Admin an. Partner-Portal bleibt aussen vor.
-- Idempotent.
-- ============================================================

-- ── projects: UPDATE fuer Beteiligte ──────────────────────────
drop policy if exists "projects_update" on public.projects;

create policy "projects_update"
  on public.projects for update to authenticated
  using (
    not public.is_partner()
    and (not is_deleted or public.is_admin())
    and (
      public.is_admin()
      or public.has_permission('projekte:approve')
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = projects.id and pm.user_id = auth.uid()
      )
    )
  )
  with check (
    not public.is_partner()
    and (is_deleted = false or public.is_admin())
    and (
      public.is_admin()
      or public.has_permission('projekte:approve')
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = projects.id and pm.user_id = auth.uid()
      )
    )
  );

-- ── project_appointments: Beteiligte sehen + bearbeiten ───────
-- (Mitglieder sahen vor 229 nicht mal die Termine — Mitglied-Klausel
-- bleibt jetzt in allen vier Verben drin.)
drop policy if exists "pa_select" on public.project_appointments;
create policy "pa_select"
  on public.project_appointments for select to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
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

drop policy if exists "pa_insert" on public.project_appointments;
create policy "pa_insert"
  on public.project_appointments for insert to authenticated
  with check (
    not public.is_partner()
    and created_by = auth.uid()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
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

drop policy if exists "pa_update" on public.project_appointments;
create policy "pa_update"
  on public.project_appointments for update to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
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
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
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

drop policy if exists "pa_delete" on public.project_appointments;
create policy "pa_delete"
  on public.project_appointments for delete to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
        and (
          public.is_admin()
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
