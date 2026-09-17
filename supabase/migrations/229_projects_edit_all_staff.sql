-- 229_projects_edit_all_staff.sql
-- ============================================================
-- Projekte: jeder eingeloggte MITARBEITER darf bearbeiten (Leo 2026-09-17,
-- "mach, dass jeder der sich einloggt soll bearbeiten koennen").
-- Vorher durften nur Admin / projekte:approve / Ersteller / Projektleiter
-- aendern — Projekt-Mitglieder sahen z.T. nicht mal die Termine (pa_select).
--
-- Bewusst NICHT geoeffnet:
--  - Partner-Portal-User (public.is_partner()) — Projekte sind intern.
--  - Loeschen: is_deleted darf weiterhin nur ein Admin setzen (with_check),
--    und geloeschte Projekte kann nur ein Admin anfassen (using).
--  - projects_insert/projects_delete/pm_*-Policies bleiben unveraendert.
-- Statuswechsel (genehmigen/abschliessen) bleiben UI-seitig Admin-gegated.
-- Idempotent.
-- ============================================================

-- ── projects: UPDATE fuer alle Mitarbeiter ────────────────────
drop policy if exists "projects_update" on public.projects;

create policy "projects_update"
  on public.projects for update to authenticated
  using (
    not public.is_partner()
    and (not is_deleted or public.is_admin())
  )
  with check (
    not public.is_partner()
    and (is_deleted = false or public.is_admin())
  );

-- ── project_appointments: sehen + bearbeiten fuer alle Mitarbeiter ──
-- (pa_select war auf Projektleiter/Ersteller/Admin/see-all begrenzt —
-- damit haetten "alle duerfen bearbeiten" nichts zu sehen bekommen.)
drop policy if exists "pa_select" on public.project_appointments;
create policy "pa_select"
  on public.project_appointments for select to authenticated
  using (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
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
    )
  )
  with check (
    not public.is_partner()
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id and not p.is_deleted
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
    )
  );
