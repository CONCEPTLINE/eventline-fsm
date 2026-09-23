-- Skalierbarkeits-Audit 2026-09-23, Teil 1 (risikoarm):
--
-- (A) KORREKTHEIT: Der Abrechnungs-Lock auf time_entries (Migration 214,
--     "nach dem 5. des Folgemonats aendert NIEMAND mehr, auch Admins
--     nicht") war durch ZWEI aeltere permissive UPDATE-Policies
--     ausgehebelt: die Ur-Policy "Benutzer koennen eigene Zeiteintraege
--     bearbeiten" (ohne Lock) und time_entries_update_team (Migration
--     208, ohne Lock). Permissive Policies sind OR-verknuepft — eine
--     reicht. Beide bekommen jetzt die Lock-Bedingung bzw. fliegen raus.
--
-- (B) INDIZES: policy-/filterrelevante Spalten ohne Index (verifiziert
--     gegen pg_indexes auf Prod). Ohne sie wird jede RLS-EXISTS-Pruefung
--     und jeder Listen-Filter zum Seq-Scan, sobald die Tabellen wachsen.
--
-- (C) Index-Namenskollision: jobs_unbilled_idx existierte in 079 UND 140
--     mit UNTERSCHIEDLICHER Definition — wegen "if not exists" war die
--     140er-Fassung (Abrechnungs-Liste) auf Prod nie angelegt.

-- ── (A) Abrechnungs-Lock dicht machen ─────────────────────────────
drop policy if exists "Benutzer können eigene Zeiteinträge bearbeiten" on public.time_entries;

drop policy if exists "time_entries_update_team" on public.time_entries;
create policy "time_entries_update_team" on public.time_entries
  for update
  using (sees_user(user_id) and not public.is_time_entry_locked(clock_in))
  with check (sees_user(user_id) and not public.is_time_entry_locked(clock_in));

-- ── (B) Fehlende Indizes ───────────────────────────────────────────
create index if not exists documents_job_idx            on public.documents (job_id) where job_id is not null;
create index if not exists documents_customer_idx       on public.documents (customer_id) where customer_id is not null;
create index if not exists documents_location_idx       on public.documents (location_id) where location_id is not null;
create index if not exists documents_uploaded_by_idx    on public.documents (uploaded_by);
create index if not exists service_reports_job_idx      on public.service_reports (job_id);
create index if not exists service_reports_created_by_idx on public.service_reports (created_by);
create index if not exists service_reports_date_idx     on public.service_reports (report_date);
create index if not exists report_photos_report_idx     on public.report_photos (report_id);
create index if not exists todos_created_by_idx         on public.todos (created_by);
create index if not exists todos_assigned_to_idx        on public.todos (assigned_to);
create index if not exists job_appointments_assigned_job_idx on public.job_appointments (assigned_to, job_id);
create index if not exists job_appointments_start_idx   on public.job_appointments (start_time);
create index if not exists jobs_created_by_idx          on public.jobs (created_by);
create index if not exists projects_created_by_idx      on public.projects (created_by) where not is_deleted;
create index if not exists project_members_pu_idx       on public.project_members (project_id, user_id);
create index if not exists time_entries_user_clock_in_idx on public.time_entries (user_id, clock_in desc);
create index if not exists calendar_events_profile_idx  on public.calendar_events (profile_id);
create index if not exists calendar_events_start_idx    on public.calendar_events (start_time);
create index if not exists job_inbox_items_created_by_idx on public.job_inbox_items (created_by);
create index if not exists vertrieb_contacts_assigned_idx on public.vertrieb_contacts (assigned_to);
create index if not exists locations_archived_idx       on public.locations (archived_at) where archived_at is not null;

-- ── (C) Abrechnungs-Index aus Migration 140 unter neuem Namen ──────
create index if not exists jobs_invoice_state_idx
  on public.jobs (status, invoiced_at, invoice_skipped_at) where is_deleted = false;
