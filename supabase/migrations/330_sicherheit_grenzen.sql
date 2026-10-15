-- 330_sicherheit_grenzen.sql — Sicherheit & Datenbank-Grenzen, Teil 2 (restriktiv)
--
-- Datum: 2026-10-15. Voraussetzung: Migration 329 + Code 92f3d036/8552a63a live
-- (Portale lesen Namen ueber portal_personen(), Firmennamen ueber lieferant_firma(),
-- Kalender-Schluessel aus profile_calendar_tokens, Storage-Regeln ohne profiles-Join).
--
--  1) profiles: SELECT nur noch eigene Zeile ODER aktives internes Konto. Bisher galt
--     «Profile sind sichtbar» USING (true) — jedes Konto, auch Partner/Lieferant, las
--     alle Spalten aller Profile (Telefon, Geburtsdatum, Kalender-Schluessel …).
--     INSERT/DELETE fuer Clients explizit gesperrt (lief schon nur ueber Service-Role).
--  2) get_assignable_users() / get_anwesenheit_users() nur noch fuer interne Konten
--     (die Portale nutzen portal_personen()).
--  3) lieferanten: Policy lieferant_sieht_eigene_firma entfernt (gab dem Portal-Konto
--     die ganze Firmenzeile inkl. interner Notizen; Firmenname kommt aus lieferant_firma()).
--  4) Technik- und Plan-Tabellen (263/264/246): bisher durfte jede interne Rolle die
--     Technikplanung ALLER Auftraege lesen/aendern/loeschen, deaktivierte Portal-Konten
--     galten als intern, das Aktivitaetslog war faelschbar. Neu:
--       SELECT  = internes Konto UND Auftrag sichtbar (Muster job_inbox_items)
--       Schreiben = zusaetzlich has_permission('auftraege:edit') (Admins automatisch)
--       job_technik_aktivitaet: Clients nur INSERT mit eigenem Absender (Trigger setzt
--         actor_id/actor_name), kein UPDATE/DELETE
--       lieferant_regeln: interne Konten lesen (Regel-Abgleich im Technik-Tab),
--         Schreiben nur Server (Service-Role, /api/lieferant/wissen)
--     Portal-Konten: kein Direktzugriff (Portal laeuft ueber /api/lieferant/* mit Admin-Client).
--  5) «not is_partner() and not is_lieferant()» -> is_internal_user() in allen uebrigen
--     Policies (Eingang, Verantwortlich-Verlauf, KI-Status, Projekt-Termine/-Dokumente,
--     Projekte bearbeiten): die Negativ-Pruefung liess deaktivierte Portal-Konten (und
--     ab 6 Lieferanten deaktivierter Firmen) als intern durch. Fuer aktive Konten
--     gleichwertig (nur partner/lieferant sind Portal-Rollen).
--  6) is_lieferant(): nur aktives Konto UND aktive Lieferantenfirma.
--  7) Rapporte (service_reports): anlegen/aendern nur interne Konten, die den Auftrag
--     sehen (Ersteller) bzw. zugeteilt sind — bisher konnte jedes Konto (auch Portal)
--     Rapporte zu beliebigen Auftraegen anlegen und damit ueber die Rapport-Routen
--     Auftraege schliessen. Die Admin-Policy bleibt.
--
-- Alle 4 Verben je Tabelle explizit. Idempotent (drop policy if exists / create or replace).
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/330_sicherheit_grenzen.sql
-- Ruecksetzen: supabase/migrations/330_sicherheit_grenzen.sql enthaelt am Ende den
-- Notfall-Block (auskommentiert) mit den bisherigen Policies.

-- ============================================================================
-- 1) profiles
-- ============================================================================
drop policy if exists "Profile sind sichtbar" on public.profiles;
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_internal_user()));

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert to authenticated
  with check (false);

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete to authenticated
  using (false);
-- UPDATE: «Admins können Profile bearbeiten» bleibt unveraendert.

-- ============================================================================
-- 2) Personen-RPCs nur fuer interne Konten
-- ============================================================================
create or replace function public.get_assignable_users()
returns table (id uuid, full_name text, role text, is_active boolean, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.role, p.is_active, p.avatar_url
  from public.profiles p
  where p.is_active = true
    and not public.is_portal_role(p.role)
    and (select public.is_internal_user())
  order by p.full_name;
$$;

create or replace function public.get_anwesenheit_users()
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name
  from public.profiles p
  join public.roles r on r.slug = p.role
  where p.is_active = true
    and not r.is_portal
    and (p.role = 'admin' or r.permissions ? 'anwesenheit:view')
    and (select public.is_internal_user())
  order by p.full_name;
$$;

-- ============================================================================
-- 3) lieferanten: Portal liest die Firmenzeile nicht mehr direkt
-- ============================================================================
drop policy if exists "lieferant_sieht_eigene_firma" on public.lieferanten;

-- ============================================================================
-- 4) Technik- und Plan-Tabellen
-- ============================================================================
-- Auftragsgebundene Tabellen: alte Policies (263: "<t> sehen/anlegen/bearbeiten/loeschen",
-- 246: "Plan-Objekte …") ersetzen.
do $$
declare
  t text;
  alt text;
begin
  foreach t in array array[
    'job_lieferanten', 'job_anforderungen', 'job_technik_positionen',
    'job_technik_reviews', 'job_technik_kommentare', 'job_plan_objekte'
  ] loop
    alt := case when t = 'job_plan_objekte' then 'Plan-Objekte' else t end;
    execute format('drop policy if exists %I on public.%I', alt || ' sehen', t);
    execute format('drop policy if exists %I on public.%I', alt || ' anlegen', t);
    execute format('drop policy if exists %I on public.%I', alt || ' bearbeiten', t);
    execute format('drop policy if exists %I on public.%I', alt || ' loeschen', t);

    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || '(select public.is_internal_user()) '
      || 'and exists (select 1 from public.jobs j where j.id = %I.job_id))',
      t || '_select', t, t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ('
      || '(select public.is_internal_user()) '
      || 'and (select public.has_permission(''auftraege:edit'')) '
      || 'and exists (select 1 from public.jobs j where j.id = %I.job_id))',
      t || '_insert', t, t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using ('
      || '(select public.is_internal_user()) '
      || 'and (select public.has_permission(''auftraege:edit'')) '
      || 'and exists (select 1 from public.jobs j where j.id = %I.job_id)) '
      || 'with check ('
      || '(select public.is_internal_user()) '
      || 'and (select public.has_permission(''auftraege:edit'')) '
      || 'and exists (select 1 from public.jobs j where j.id = %I.job_id))',
      t || '_update', t, t, t);

    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using ('
      || '(select public.is_internal_user()) '
      || 'and (select public.has_permission(''auftraege:edit'')) '
      || 'and exists (select 1 from public.jobs j where j.id = %I.job_id))',
      t || '_delete', t, t);
  end loop;
end $$;

-- Aktivitaetslog: lesen wie oben, Clients nur anfuegen (mit echtem Absender).
drop policy if exists "job_technik_aktivitaet sehen" on public.job_technik_aktivitaet;
drop policy if exists "job_technik_aktivitaet anlegen" on public.job_technik_aktivitaet;
drop policy if exists "job_technik_aktivitaet bearbeiten" on public.job_technik_aktivitaet;
drop policy if exists "job_technik_aktivitaet loeschen" on public.job_technik_aktivitaet;

drop policy if exists "job_technik_aktivitaet_select" on public.job_technik_aktivitaet;
create policy "job_technik_aktivitaet_select" on public.job_technik_aktivitaet
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (select 1 from public.jobs j where j.id = job_technik_aktivitaet.job_id)
  );

drop policy if exists "job_technik_aktivitaet_insert" on public.job_technik_aktivitaet;
create policy "job_technik_aktivitaet_insert" on public.job_technik_aktivitaet
  for insert to authenticated
  with check (
    actor_id = (select auth.uid())
    and (select public.is_internal_user())
    and (select public.has_permission('auftraege:edit'))
    and exists (select 1 from public.jobs j where j.id = job_technik_aktivitaet.job_id)
  );

drop policy if exists "job_technik_aktivitaet_update" on public.job_technik_aktivitaet;
create policy "job_technik_aktivitaet_update" on public.job_technik_aktivitaet
  for update to authenticated
  using (false)
  with check (false);

drop policy if exists "job_technik_aktivitaet_delete" on public.job_technik_aktivitaet;
create policy "job_technik_aktivitaet_delete" on public.job_technik_aktivitaet
  for delete to authenticated
  using (false);

-- Client-Eintraege tragen immer den echten Absender (Name aus dem Profil); Eintraege
-- des Servers (Service-Role, technik-server.ts logTechnik) bleiben unveraendert.
create or replace function public.job_technik_aktivitaet_absender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    new.actor_id := auth.uid();
    new.actor_name := (select p.full_name from public.profiles p where p.id = auth.uid());
  end if;
  return new;
end;
$$;

revoke execute on function public.job_technik_aktivitaet_absender() from public, anon, authenticated;

drop trigger if exists job_technik_aktivitaet_absender on public.job_technik_aktivitaet;
create trigger job_technik_aktivitaet_absender
  before insert on public.job_technik_aktivitaet
  for each row execute function public.job_technik_aktivitaet_absender();

-- Lieferanten-Wissen (Pakete/Hinweise): interne Konten lesen, schreiben nur der Server.
drop policy if exists "lieferant_regeln sehen" on public.lieferant_regeln;
drop policy if exists "lieferant_regeln anlegen" on public.lieferant_regeln;
drop policy if exists "lieferant_regeln bearbeiten" on public.lieferant_regeln;
drop policy if exists "lieferant_regeln loeschen" on public.lieferant_regeln;

drop policy if exists "lieferant_regeln_select" on public.lieferant_regeln;
create policy "lieferant_regeln_select" on public.lieferant_regeln
  for select to authenticated
  using ((select public.is_internal_user()));

drop policy if exists "lieferant_regeln_insert" on public.lieferant_regeln;
create policy "lieferant_regeln_insert" on public.lieferant_regeln
  for insert to authenticated
  with check (false);

drop policy if exists "lieferant_regeln_update" on public.lieferant_regeln;
create policy "lieferant_regeln_update" on public.lieferant_regeln
  for update to authenticated
  using (false)
  with check (false);

drop policy if exists "lieferant_regeln_delete" on public.lieferant_regeln;
create policy "lieferant_regeln_delete" on public.lieferant_regeln
  for delete to authenticated
  using (false);

-- ============================================================================
-- 5) Negativ-Pruefung «not is_partner() and not is_lieferant()» -> is_internal_user()
--    (Rest der Ausdruecke unveraendert)
-- ============================================================================
-- Eingang (job_inbox_items, Migration 232)
drop policy if exists "jii_select" on public.job_inbox_items;
create policy "jii_select" on public.job_inbox_items
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (select 1 from public.jobs j where j.id = job_inbox_items.job_id)
  );

drop policy if exists "jii_insert" on public.job_inbox_items;
create policy "jii_insert" on public.job_inbox_items
  for insert to authenticated
  with check (
    (select public.is_internal_user())
    and created_by = (select auth.uid())
    and exists (select 1 from public.jobs j where j.id = job_inbox_items.job_id)
  );

drop policy if exists "jii_update" on public.job_inbox_items;
create policy "jii_update" on public.job_inbox_items
  for update to authenticated
  using (
    (select public.is_internal_user())
    and (created_by = (select auth.uid()) or (select public.is_admin()))
  )
  with check (
    (select public.is_internal_user())
    and (created_by = (select auth.uid()) or (select public.is_admin()))
  );

drop policy if exists "jii_delete" on public.job_inbox_items;
create policy "jii_delete" on public.job_inbox_items
  for delete to authenticated
  using (
    (select public.is_internal_user())
    and (created_by = (select auth.uid()) or (select public.is_admin()))
  );

-- Verantwortlich-Verlauf
drop policy if exists "job_verantwortlich_verlauf_select" on public.job_verantwortlich_verlauf;
create policy "job_verantwortlich_verlauf_select" on public.job_verantwortlich_verlauf
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (select 1 from public.jobs j where j.id = job_verantwortlich_verlauf.job_id)
  );

-- KI-Status (nur lesen)
drop policy if exists "ki_status_select" on public.ki_status;
create policy "ki_status_select" on public.ki_status
  for select to authenticated
  using ((select public.is_internal_user()));

-- Projekt-Termine
drop policy if exists "pa_select" on public.project_appointments;
create policy "pa_select" on public.project_appointments
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

drop policy if exists "pa_insert" on public.project_appointments;
create policy "pa_insert" on public.project_appointments
  for insert to authenticated
  with check (
    (select public.is_internal_user())
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

drop policy if exists "pa_update" on public.project_appointments;
create policy "pa_update" on public.project_appointments
  for update to authenticated
  using (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  )
  with check (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

drop policy if exists "pa_delete" on public.project_appointments;
create policy "pa_delete" on public.project_appointments
  for delete to authenticated
  using (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_appointments.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

-- Projekt-Dokumente
drop policy if exists "pdocs_select" on public.project_docs;
create policy "pdocs_select" on public.project_docs
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (select 1 from public.projects p where p.id = project_docs.project_id and not p.is_deleted)
  );

drop policy if exists "pdocs_insert" on public.project_docs;
create policy "pdocs_insert" on public.project_docs
  for insert to authenticated
  with check (
    (select public.is_internal_user())
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

drop policy if exists "pdocs_update" on public.project_docs;
create policy "pdocs_update" on public.project_docs
  for update to authenticated
  using (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  )
  with check (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

drop policy if exists "pdocs_delete" on public.project_docs;
create policy "pdocs_delete" on public.project_docs
  for delete to authenticated
  using (
    (select public.is_internal_user())
    and exists (
      select 1 from public.projects p
      where p.id = project_docs.project_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

-- Projekt-Dokument-Versionen (UPDATE/DELETE bleiben admin-only, unveraendert)
drop policy if exists "pdocv_select" on public.project_doc_versions;
create policy "pdocv_select" on public.project_doc_versions
  for select to authenticated
  using (
    (select public.is_internal_user())
    and exists (
      select 1 from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id = project_doc_versions.doc_id and not p.is_deleted
    )
  );

drop policy if exists "pdocv_insert" on public.project_doc_versions;
create policy "pdocv_insert" on public.project_doc_versions
  for insert to authenticated
  with check (
    (select public.is_internal_user())
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.project_docs d
      join public.projects p on p.id = d.project_id
      where d.id = project_doc_versions.doc_id
        and not p.is_deleted
        and ((select public.is_admin())
          or (select public.has_permission('projekte:approve'))
          or (select public.has_permission('projekte:see-all'))
          or p.created_by = (select auth.uid())
          or p.assigned_to = (select auth.uid())
          or exists (select 1 from public.project_members pm
                     where pm.project_id = p.id and pm.user_id = (select auth.uid())))
    )
  );

-- Projekte bearbeiten
drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects
  for update to authenticated
  using (
    (select public.is_internal_user())
    and ((not is_deleted) or (select public.is_admin()))
    and ((select public.is_admin())
      or (select public.has_permission('projekte:approve'))
      or created_by = (select auth.uid())
      or assigned_to = (select auth.uid())
      or exists (select 1 from public.project_members pm
                 where pm.project_id = projects.id and pm.user_id = (select auth.uid())))
  )
  with check (
    (select public.is_internal_user())
    and ((is_deleted = false) or (select public.is_admin()))
    and ((select public.is_admin())
      or (select public.has_permission('projekte:approve'))
      or created_by = (select auth.uid())
      or assigned_to = (select auth.uid())
      or exists (select 1 from public.project_members pm
                 where pm.project_id = projects.id and pm.user_id = (select auth.uid())))
  );

-- ============================================================================
-- 6) is_lieferant(): aktives Konto UND aktive Firma
--    (erst NACH 5 — die Negativ-Pruefungen sind ersetzt)
-- ============================================================================
create or replace function public.is_lieferant()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.lieferanten l on l.id = p.lieferant_id
    where p.id = auth.uid()
      and p.role = 'lieferant'
      and p.is_active = true
      and l.is_active = true
  );
$$;

-- ============================================================================
-- 7) Rapporte: anlegen/aendern nur interne Konten mit Bezug zum Auftrag
-- ============================================================================
drop policy if exists "Benutzer können Rapporte erstellen" on public.service_reports;
create policy "Benutzer können Rapporte erstellen" on public.service_reports
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select public.is_internal_user())
    and exists (select 1 from public.jobs j where j.id = service_reports.job_id)
  );

drop policy if exists "Ersteller können Rapporte bearbeiten" on public.service_reports;
create policy "Ersteller können Rapporte bearbeiten" on public.service_reports
  for update to authenticated
  using (
    created_by = (select auth.uid())
    and (select public.is_internal_user())
  )
  with check (
    created_by = (select auth.uid())
    and (select public.is_internal_user())
    and exists (select 1 from public.jobs j where j.id = service_reports.job_id)
  );

drop policy if exists "Zugeteilte Techniker können Rapporte bearbeiten" on public.service_reports;
create policy "Zugeteilte Techniker können Rapporte bearbeiten" on public.service_reports
  for update to authenticated
  using (
    status = 'entwurf'
    and (select public.is_internal_user())
    and exists (
      select 1 from public.job_appointments a
      where a.job_id = service_reports.job_id and a.assigned_to = (select auth.uid())
    )
  )
  with check (
    (select public.is_internal_user())
    and exists (
      select 1 from public.job_appointments a
      where a.job_id = service_reports.job_id and a.assigned_to = (select auth.uid())
    )
  );

drop policy if exists "service_reports_delete" on public.service_reports;
create policy "service_reports_delete" on public.service_reports
  for delete to authenticated
  using (false);
-- SELECT («Rapporte sind sichtbar») und «Admins können alle Rapporte bearbeiten» bleiben.

-- ============================================================================
-- NOTFALL-RUECKSETZEN (nur bei Problemen, manuell ausfuehren):
--   drop policy if exists "profiles_select" on public.profiles;
--   create policy "Profile sind sichtbar" on public.profiles for select to authenticated using (true);
--   create policy "lieferant_sieht_eigene_firma" on public.lieferanten for select to authenticated
--     using (id = (select profiles.lieferant_id from public.profiles where profiles.id = (select auth.uid())));
--   Technik-/Plan-Tabellen: Policies aus 263 (DO-Block) bzw. 246 neu anlegen; Helfer
--   is_lieferant() aus 254/309 (ohne Firmen-Pruefung); get_assignable_users() ohne
--   is_internal_user()-Bedingung; Rapporte: «Benutzer können Rapporte erstellen»
--   with check (created_by = (select auth.uid())).
-- ============================================================================
