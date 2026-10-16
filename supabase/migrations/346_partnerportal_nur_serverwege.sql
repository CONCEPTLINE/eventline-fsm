-- 346 — Partnerportal: Partner-Konten lesen und schreiben NICHTS mehr direkt
-- in jobs / customers / job_appointments / documents / Storage (Leo
-- 2026-10-15: Partner sehen nur noch ihre EIGENEN Anfragen, mit genau den
-- Angaben, die ihr Portal anzeigt; interne Angaben und fremde Aufträge sind
-- nicht mehr abrufbar).
--
-- Seit dem Code-Stand mit Migration 345 läuft das Partnerportal komplett über
-- Server-Routen unter /api/partner/** (Admin-Client NACH Prüfung von Konto,
-- Standort, Recht und «eigener Anfrage», feste Feld-Liste; Downloads und
-- Uploads über signierte URLs). Diese Migration entzieht die alten direkten
-- Wege — erst NACH der Live-Prüfung des Codes eingespielt.
--
-- Vorher (live gemessen 2026-10-16, RLS als Partner): Barakuba 39 Aufträge /
-- 42 Termine / 61 Dokumente / 61 Storage-Objekte / 1 Kunde, Theater BAU3 15 /
-- 14 / 27 / 27 / 2 — jeweils inkl. EVENTLINE-eigener Aufträge am Standort mit
-- allen Spalten (Storno-Grund, Rechnung, KI-Felder …). Dazu konnte ein
-- Partner per RPC partner_update_notes Notizen EVENTLINE-eigener, offener
-- Aufträge an seinem Standort überschreiben.
--
-- Änderungen (alle Verben bewusst, nur positive Prüfung is_internal_user()):
--   jobs              SELECT  nur interne Konten (Partner-Zweig entfernt)
--                     INSERT/UPDATE/DELETE: *_partner-Policies entfernt; deren
--                     interner Zweig (is_admin_or_lead) bleibt als *_leitung
--                     unverändert erhalten (z. B. darf die Team-Leitung
--                     Aufträge löschen — Verhalten für Interne gleich).
--   job_appointments  SELECT  nur interne Konten (auch die Team-Sicht)
--                     INSERT/DELETE: *_partner → *_leitung (wie oben);
--                     UPDATE unverändert (Termine bearbeiten = kalender:edit)
--   documents         SELECT  nur interne Konten (Partner-Zweig und
--                             «eigener Upload» für Portal-Konten entfernt)
--                     INSERT  documents_insert_partner → *_leitung
--                     DELETE  Partner-Teil entfernt
--                     UPDATE  unverändert (schon nur Interne)
--   customers         SELECT  nur interne Konten (der EXISTS-Zweig liess
--                             Partner Kunden-Stammdaten aller Aufträge an
--                             ihrem Standort lesen)
--   storage.objects   Bucket documents nur für interne Konten (Partner-Zweige
--                     in storage_documents_select und der Grenze entfernt;
--                     Partner laden über signierte URLs vom Server)
--   RPCs              partner_update_notes, partner_update_termin und
--                     portal_personen entfernt (ersetzt durch die Server-
--                     Routen, ohne Aufrufer). partner_update_title,
--                     partner_submit_anfrage und partner_withdraw_anfrage
--                     bleiben als Logik der Server-Wege (Migration 345), sind
--                     aber für Browser-Rollen nicht mehr ausführbar.
-- Unverändert bleiben die übrigen Schreib-Policies, die interne Rechte
-- verlangen (jobs_insert / jobs_update_perm / jobs_delete, «Termine anlegen /
-- bearbeiten / löschen», customers_insert/update/delete, documents_update_
-- folder_staff …) — die Partner-Rolle hat nur partner:*-Rechte — sowie
-- jobs_update_assigned (nur Termin-Zugeteilte; Partner werden nie zugeteilt).
-- Idempotent: drop … if exists / create.

-- ─── jobs ───────────────────────────────────────────────────────────────────
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select to authenticated
  using (
    (select public.is_internal_user())
    and (
      (select public.is_admin_or_lead())
      or project_lead_id = (select auth.uid())
      or id = any ((select public.my_assigned_job_ids())::uuid[])
    )
  );

drop policy if exists jobs_insert_partner on public.jobs;
drop policy if exists jobs_update_partner on public.jobs;
drop policy if exists jobs_delete_partner on public.jobs;

drop policy if exists jobs_insert_leitung on public.jobs;
create policy jobs_insert_leitung on public.jobs
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

drop policy if exists jobs_update_leitung on public.jobs;
create policy jobs_update_leitung on public.jobs
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin_or_lead()))
  with check ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

drop policy if exists jobs_delete_leitung on public.jobs;
create policy jobs_delete_leitung on public.jobs
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

-- ─── job_appointments ───────────────────────────────────────────────────────
drop policy if exists appointments_select on public.job_appointments;
create policy appointments_select on public.job_appointments
  for select to authenticated
  using (
    (select public.is_internal_user())
    and (
      (select public.is_admin_or_lead())
      or assigned_to = (select auth.uid())
      or (job_id is not null and exists (select 1 from public.jobs j where j.id = job_appointments.job_id))
    )
  );

drop policy if exists job_appointments_select_team on public.job_appointments;
create policy job_appointments_select_team on public.job_appointments
  for select to authenticated
  using (
    (select public.is_internal_user())
    and (
      assigned_to = (select auth.uid())
      or (select public.is_admin())
      or (select public.get_my_scope()) = 'all'
      or assigned_to = any ((select public.my_team_user_ids())::uuid[])
    )
  );

drop policy if exists appointments_insert_partner on public.job_appointments;
drop policy if exists appointments_delete_partner on public.job_appointments;

drop policy if exists appointments_insert_leitung on public.job_appointments;
create policy appointments_insert_leitung on public.job_appointments
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

drop policy if exists appointments_delete_leitung on public.job_appointments;
create policy appointments_delete_leitung on public.job_appointments
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

-- ─── documents ──────────────────────────────────────────────────────────────
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select to authenticated
  using (
    (select public.is_internal_user())
    and (
      uploaded_by = (select auth.uid())
      or (select public.is_admin())
      or (job_id is not null and exists (select 1 from public.jobs j where j.id = documents.job_id))
      or (project_id is not null and exists (select 1 from public.projects p where p.id = documents.project_id))
      or (location_id is not null and exists (select 1 from public.locations l where l.id = documents.location_id))
    )
  );

drop policy if exists documents_insert_partner on public.documents;
drop policy if exists documents_insert_leitung on public.documents;
create policy documents_insert_leitung on public.documents
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin_or_lead()));

-- ─── customers ──────────────────────────────────────────────────────────────
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select to authenticated
  using (
    (select public.is_internal_user())
    and (
      (select public.is_admin_or_lead())
      or (select public.has_permission('kunden:view'))
      or exists (select 1 from public.jobs j where j.customer_id = customers.id)
    )
  );

-- ─── Storage: Bucket documents nur für interne Konten ───────────────────────
drop policy if exists storage_documents_select on storage.objects;
create policy storage_documents_select on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (select public.is_internal_user()));

-- Grenze (RESTRICTIVE): jeder Zugriff auf den Bucket documents nur intern.
drop policy if exists storage_documents_grenze on storage.objects;
create policy storage_documents_grenze on storage.objects
  as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'documents' or (select public.is_internal_user()))
  with check (bucket_id <> 'documents' or (select public.is_internal_user()));

-- ─── RPCs ───────────────────────────────────────────────────────────────────
drop function if exists public.partner_update_notes(uuid, text);
drop function if exists public.partner_update_termin(uuid, text, timestamptz, timestamptz, text, text);
drop function if exists public.portal_personen();

revoke execute on function public.partner_update_title(uuid, text) from public, anon, authenticated;
revoke execute on function public.partner_submit_anfrage(uuid) from public, anon, authenticated;
revoke execute on function public.partner_withdraw_anfrage(uuid) from public, anon, authenticated;
