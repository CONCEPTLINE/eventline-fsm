-- Skalierbarkeits-Audit Teil 3: RLS-Sweep.
--
-- Kernprobleme: (1) Helper-Aufrufe (is_admin, has_permission, …) wurden
-- pro ZEILE ausgewertet — jetzt als (select …) gewrappt = einmal pro
-- Statement (InitPlan). (2) sees_user(spalte) kann nie gecacht werden
-- (zeilenabhaengiges Argument) — expandiert zu einem Array-Vergleich
-- gegen my_team_user_ids(). (3) Redundante Alt-Policies (mehrere
-- permissive SELECT/UPDATE auf derselben Tabelle) konsolidiert.
-- (4) jobs: Grace-Slugs aus Migration 216 abgebaut (Phase 2), alte
-- Slugs aus der Partner-Rolle entfernt. (5) user_can_see_job driftete
-- von jobs_select — jetzt SECURITY INVOKER + exists(jobs) und erbt die
-- Policy fuer immer.
--
-- GEWOLLTE Verhaltensaenderungen (Rest ist semantisch identisch,
-- verifiziert per Rollen-Baseline vorher/nachher):
--   a) projects_select: Portal-User (Partner/Lieferanten) sehen KEINE
--      internen Projekte mehr (sahen bisher alle inkl. Titel).
--   b) time_entries-INSERT: der Abrechnungs-Lock gilt auch beim
--      Anlegen (die Ur-Policy ohne Lock-Check fliegt raus).
--   c) project_audit: nicht mehr USING(true) fuer alle, sondern nur
--      wer das Projekt sieht.

-- ── Helper ─────────────────────────────────────────────────────────
create or replace function public.my_team_user_ids()
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.id), '{}') from public.profiles p where p.team_lead_id = auth.uid();
$$;

-- sees_user-Aequivalent als Statement-cachebares Praedikat existiert
-- damit; sees_user() selbst bleibt fuer App-Code erhalten.

create or replace function public.user_can_see_job(job_uuid uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (select 1 from public.jobs where id = job_uuid);
$$;

-- ── customers ──────────────────────────────────────────────────────
drop policy if exists "Admins können Kunden erstellen" on public.customers;
drop policy if exists "Admins können Kunden bearbeiten" on public.customers;
drop policy if exists "customers_select" on public.customers;
create policy "customers_select" on public.customers for select using (
  (select public.is_admin_or_lead())
  or (select public.has_permission('kunden:view'))
  or exists (select 1 from public.jobs j where j.customer_id = customers.id)
);

-- ── documents: 4 SELECT-Policies -> 1, 2 DELETE -> 1 ───────────────
drop policy if exists "Dokumente sind sichtbar" on public.documents;
drop policy if exists "documents_select_partner" on public.documents;
drop policy if exists "documents_select_via_job" on public.documents;
drop policy if exists "documents_select_via_project" on public.documents;
create policy "documents_select" on public.documents for select using (
  uploaded_by = (select auth.uid())
  or (select public.is_admin())
  or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
  or (project_id is not null
      and not (select public.is_portal_user())
      and exists (select 1 from public.projects p where p.id = documents.project_id))
);
drop policy if exists "Admins können Dokumente löschen" on public.documents;
drop policy if exists "documents_delete_partner" on public.documents;
create policy "documents_delete" on public.documents for delete using (
  (select public.is_admin_or_lead())
  or (uploaded_by = (select auth.uid()) and (select public.is_partner())
      and exists (select 1 from public.jobs j join public.profiles p on p.id = (select auth.uid())
                  where j.id = documents.job_id
                    and j.status in ('partner_anfrage', 'partner_entwurf')
                    and p.partner_location_id is not null
                    and p.partner_location_id = j.location_id)
      and (select public.has_permission('partner:anfragen:delete')))
);
drop policy if exists "documents_insert_partner" on public.documents;
create policy "documents_insert_partner" on public.documents for insert with check (
  (select public.is_admin_or_lead())
  or (uploaded_by = (select auth.uid()) and (select public.is_partner())
      and exists (select 1 from public.jobs j join public.profiles p on p.id = (select auth.uid())
                  where j.id = documents.job_id
                    and j.status in ('partner_anfrage', 'partner_entwurf', 'offen')
                    and p.partner_location_id is not null
                    and p.partner_location_id = j.location_id)
      and (select public.has_permission('partner:anfragen:edit')))
);
drop policy if exists "documents_update_folder_staff" on public.documents;
create policy "documents_update_folder_staff" on public.documents for update
using (
  not (select public.is_portal_user())
  and (uploaded_by = (select auth.uid()) or (select public.is_admin())
       or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
       or (project_id is not null and exists (select 1 from public.projects p where p.id = documents.project_id)))
)
with check (
  not (select public.is_portal_user())
  and (uploaded_by = (select auth.uid()) or (select public.is_admin())
       or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
       or (project_id is not null and exists (select 1 from public.projects p where p.id = documents.project_id)))
);

-- ── jobs ───────────────────────────────────────────────────────────
drop policy if exists "Admins können Aufträge erstellen" on public.jobs;
drop policy if exists "Admins können Aufträge bearbeiten" on public.jobs;
drop policy if exists "jobs_select" on public.jobs;
create policy "jobs_select" on public.jobs for select using (
  (select public.is_admin_or_lead())
  or project_lead_id = (select auth.uid())
  or exists (select 1 from public.job_appointments a
             where a.job_id = jobs.id and a.assigned_to = (select auth.uid()))
  or ((select public.is_partner())
      and exists (select 1 from public.profiles p
                  where p.id = (select auth.uid())
                    and p.partner_location_id is not null
                    and p.partner_location_id = jobs.location_id)
      and ((select public.has_permission('partner:auftraege:view'))
           or (select public.has_permission('partner:belegungsplan:view'))))
);
drop policy if exists "jobs_insert_partner" on public.jobs;
create policy "jobs_insert_partner" on public.jobs for insert with check (
  (select public.is_admin_or_lead())
  or (status in ('partner_anfrage', 'partner_entwurf')
      and created_by = (select auth.uid())
      and (select public.is_partner())
      and exists (select 1 from public.profiles p
                  where p.id = (select auth.uid())
                    and p.partner_location_id is not null
                    and p.partner_location_id = jobs.location_id)
      and (select public.has_permission('partner:anfragen:create')))
);
drop policy if exists "jobs_update_partner" on public.jobs;
create policy "jobs_update_partner" on public.jobs for update
using (
  (select public.is_admin_or_lead())
  or (status in ('partner_anfrage', 'partner_entwurf')
      and (select public.is_partner())
      and exists (select 1 from public.profiles p
                  where p.id = (select auth.uid())
                    and p.partner_location_id is not null
                    and p.partner_location_id = jobs.location_id)
      and (select public.has_permission('partner:anfragen:edit')))
)
with check (
  (select public.is_admin_or_lead())
  or (status in ('partner_anfrage', 'partner_entwurf')
      and (select public.is_partner())
      and exists (select 1 from public.profiles p
                  where p.id = (select auth.uid())
                    and p.partner_location_id is not null
                    and p.partner_location_id = jobs.location_id)
      and (select public.has_permission('partner:anfragen:edit')))
);
drop policy if exists "jobs_delete_partner" on public.jobs;
create policy "jobs_delete_partner" on public.jobs for delete using (
  (select public.is_admin_or_lead())
  or (status = 'partner_anfrage' and created_by = (select auth.uid()) and (select public.is_partner()))
);

-- ── job_appointments ───────────────────────────────────────────────
drop policy if exists "appointments_select" on public.job_appointments;
create policy "appointments_select" on public.job_appointments for select using (
  (select public.is_admin_or_lead())
  or assigned_to = (select auth.uid())
  or (job_id is not null and exists (select 1 from public.jobs j where j.id = job_appointments.job_id))
);
drop policy if exists "job_appointments_select_team" on public.job_appointments;
create policy "job_appointments_select_team" on public.job_appointments for select using (
  assigned_to = (select auth.uid())
  or (select public.is_admin())
  or (select public.get_my_scope()) = 'all'
  or assigned_to = any ((select public.my_team_user_ids())::uuid[])
);
drop policy if exists "appointments_delete_partner" on public.job_appointments;
create policy "appointments_delete_partner" on public.job_appointments for delete using (
  (select public.is_admin_or_lead())
  or (job_id is not null and (select public.is_partner())
      and exists (select 1 from public.jobs j join public.profiles p on p.id = (select auth.uid())
                  where j.id = job_appointments.job_id
                    and j.status in ('partner_anfrage', 'partner_entwurf')
                    and p.partner_location_id is not null
                    and p.partner_location_id = j.location_id)
      and (select public.has_permission('partner:anfragen:edit')))
);
drop policy if exists "appointments_insert_partner" on public.job_appointments;
create policy "appointments_insert_partner" on public.job_appointments for insert with check (
  (select public.is_admin_or_lead())
  or (job_id is not null and (select public.is_partner())
      and exists (select 1 from public.jobs j join public.profiles p on p.id = (select auth.uid())
                  where j.id = job_appointments.job_id
                    and j.status in ('partner_anfrage', 'partner_entwurf')
                    and p.partner_location_id is not null
                    and p.partner_location_id = j.location_id)
      and (select public.has_permission('partner:anfragen:edit')))
);

-- ── time_entries ───────────────────────────────────────────────────
drop policy if exists "Admins sehen alle Zeiteinträge" on public.time_entries;
drop policy if exists "Benutzer sehen eigene Zeiteinträge" on public.time_entries;
drop policy if exists "Benutzer können eigene Zeiteinträge erstellen" on public.time_entries;
drop policy if exists "time_entries_select" on public.time_entries;
create policy "time_entries_select" on public.time_entries for select using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.has_permission('stempelzeiten:see-all'))
);
drop policy if exists "time_entries_select_team" on public.time_entries;
create policy "time_entries_select_team" on public.time_entries for select using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.get_my_scope()) = 'all'
  or user_id = any ((select public.my_team_user_ids())::uuid[])
);
drop policy if exists "time_entries_update" on public.time_entries;
create policy "time_entries_update" on public.time_entries for update
using (
  (user_id = (select auth.uid()) or (select public.is_admin()) or (select public.has_permission('stempelzeiten:edit-all')))
  and not public.is_time_entry_locked(clock_in)
)
with check (
  (user_id = (select auth.uid()) or (select public.is_admin()) or (select public.has_permission('stempelzeiten:edit-all')))
  and not public.is_time_entry_locked(clock_in)
);
drop policy if exists "time_entries_update_team" on public.time_entries;
create policy "time_entries_update_team" on public.time_entries for update
using (
  (user_id = (select auth.uid()) or (select public.is_admin()) or (select public.get_my_scope()) = 'all'
   or user_id = any ((select public.my_team_user_ids())::uuid[]))
  and not public.is_time_entry_locked(clock_in)
)
with check (
  (user_id = (select auth.uid()) or (select public.is_admin()) or (select public.get_my_scope()) = 'all'
   or user_id = any ((select public.my_team_user_ids())::uuid[]))
  and not public.is_time_entry_locked(clock_in)
);
drop policy if exists "time_entries_delete" on public.time_entries;
create policy "time_entries_delete" on public.time_entries for delete using (
  (user_id = (select auth.uid()) or (select public.is_admin()) or (select public.has_permission('stempelzeiten:edit-all')))
  and not public.is_time_entry_locked(clock_in)
);

-- ── todos ──────────────────────────────────────────────────────────
drop policy if exists "todos_select" on public.todos;
create policy "todos_select" on public.todos for select using (
  created_by = (select auth.uid())
  or assigned_to = (select auth.uid())
  or (select public.is_admin())
  or (select public.has_permission('todos:see-all'))
);
drop policy if exists "todos_select_team" on public.todos;
create policy "todos_select_team" on public.todos for select using (
  (select public.is_admin())
  or (select public.get_my_scope()) = 'all'
  or created_by = (select auth.uid()) or assigned_to = (select auth.uid())
  or created_by = any ((select public.my_team_user_ids())::uuid[])
  or assigned_to = any ((select public.my_team_user_ids())::uuid[])
);
drop policy if exists "todos_update" on public.todos;
create policy "todos_update" on public.todos for update using (
  created_by = (select auth.uid())
  or assigned_to = (select auth.uid())
  or (select public.is_admin())
  or (select public.has_permission('todos:edit-all'))
);
drop policy if exists "todos_update_team" on public.todos;
create policy "todos_update_team" on public.todos for update
using (
  (select public.is_admin()) or (select public.get_my_scope()) = 'all'
  or created_by = (select auth.uid()) or assigned_to = (select auth.uid())
  or created_by = any ((select public.my_team_user_ids())::uuid[])
  or assigned_to = any ((select public.my_team_user_ids())::uuid[])
)
with check (
  (select public.is_admin()) or (select public.get_my_scope()) = 'all'
  or created_by = (select auth.uid()) or assigned_to = (select auth.uid())
  or created_by = any ((select public.my_team_user_ids())::uuid[])
  or assigned_to = any ((select public.my_team_user_ids())::uuid[])
);
drop policy if exists "todos_delete" on public.todos;
create policy "todos_delete" on public.todos for delete using (
  created_by = (select auth.uid())
  or (select public.is_admin())
  or (select public.has_permission('todos:edit-all'))
);

-- ── tickets ────────────────────────────────────────────────────────
drop policy if exists "tickets_select_own_or_admin" on public.tickets;
create policy "tickets_select_own_or_admin" on public.tickets for select using (
  created_by = (select auth.uid())
  or assigned_to = (select auth.uid())
  or (select public.is_admin())
  or (select public.has_permission('tickets:manage'))
);
drop policy if exists "tickets_select_team" on public.tickets;
create policy "tickets_select_team" on public.tickets for select using (
  (select public.is_admin())
  or (select public.get_my_scope()) = 'all'
  or created_by = (select auth.uid()) or assigned_to = (select auth.uid())
  or created_by = any ((select public.my_team_user_ids())::uuid[])
  or assigned_to = any ((select public.my_team_user_ids())::uuid[])
);
drop policy if exists "tickets_update_admin" on public.tickets;
create policy "tickets_update_admin" on public.tickets for update using (
  (select public.is_admin()) or (select public.has_permission('tickets:manage'))
);

-- ── time_off ───────────────────────────────────────────────────────
drop policy if exists "time_off_select_team" on public.time_off;
create policy "time_off_select_team" on public.time_off for select using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.get_my_scope()) = 'all'
  or user_id = any ((select public.my_team_user_ids())::uuid[])
);
drop policy if exists "Genehmiger sieht alle Ferien" on public.time_off;
create policy "Genehmiger sieht alle Ferien" on public.time_off for select using (
  (select public.has_permission('ferien:approve'))
);
drop policy if exists "Genehmiger entscheidet" on public.time_off;
create policy "Genehmiger entscheidet" on public.time_off for update
using ((select public.has_permission('ferien:approve')))
with check ((select public.has_permission('ferien:approve')));

-- ── project_time_entries ───────────────────────────────────────────
drop policy if exists "pte_select" on public.project_time_entries;
create policy "pte_select" on public.project_time_entries for select using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.has_permission('projekte:see-all'))
  or exists (select 1 from public.projects p
             where p.id = project_time_entries.project_id
               and (p.assigned_to = (select auth.uid()) or p.created_by = (select auth.uid())))
);
drop policy if exists "pte_select_team" on public.project_time_entries;
create policy "pte_select_team" on public.project_time_entries for select using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or (select public.get_my_scope()) = 'all'
  or user_id = any ((select public.my_team_user_ids())::uuid[])
);

-- ── projects (GEWOLLT: Portal-User raus) ───────────────────────────
drop policy if exists "projects_select" on public.projects;
create policy "projects_select" on public.projects for select using (
  (not is_deleted) and not (select public.is_portal_user())
);

-- ── project_audit (GEWOLLT: statt USING true) ──────────────────────
drop policy if exists "pa_audit_select" on public.project_audit;
create policy "pa_audit_select" on public.project_audit for select using (
  exists (select 1 from public.projects p where p.id = project_audit.project_id)
);

-- ── Partner-Rolle: tote Grace-Slugs entfernen ──────────────────────
update public.roles
set permissions = (
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from jsonb_array_elements_text(permissions) as t(p)
  where p not like 'partner-anfragen:%' and p not like 'partner-belegungsplan:%'
)
where slug = 'partner';
