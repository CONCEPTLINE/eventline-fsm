-- 265: Zweiter RLS-Rekursions-Fix jobs <-> job_appointments.
--
-- Migration 258 hat nur jobs_SELECT auf my_assigned_job_ids() umgestellt —
-- jobs_update_assigned (aus dem Sweep 257) behielt das direkte
-- EXISTS(job_appointments). Da Policy-USING-Klauseln bei JEDEM
-- jobs-UPDATE expandiert werden, entstand der Zyklus
--   jobs(update) -> job_appointments -> appointments_select -> jobs
-- => "infinite recursion detected in policy for relation jobs" bei allen
-- client-seitigen jobs-Updates (Vorfall: Termin-Vorschlag anpassen/
-- verwerfen auf der Auftrags-Uebersicht, INT-26316, 2026-09-24).
--
-- Fix wie in 258: SECURITY-DEFINER-Funktion my_assigned_job_ids() bricht
-- den Kreis. Vor dem Einspielen in Transaktion reproduziert + getestet.

drop policy "jobs_update_assigned" on public.jobs;
create policy "jobs_update_assigned" on public.jobs for update to authenticated
  using (id = any((select public.my_assigned_job_ids())::uuid[]))
  with check (id = any((select public.my_assigned_job_ids())::uuid[]));
