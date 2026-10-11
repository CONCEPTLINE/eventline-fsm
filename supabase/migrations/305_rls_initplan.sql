-- 305_rls_initplan.sql — RLS-Performance-Sweep (InitPlan-Wraps)
--
-- Datum: 2026-10-11. Bezug: Skalierbarkeits-Audit vom 2026-09-23, offener
-- Punkt «RLS-Sweep» (Fortsetzung von Migration 257).
--
-- Zweck: Rechte-Helfer OHNE Zeilenbezug — auth.uid(), is_admin(),
-- is_admin_or_lead(), is_partner(), is_lieferant(), has_permission('<konstante>')
-- — werden in den Policies als ( SELECT f() ) gewrappt. Postgres rechnet
-- sie dann EINMAL pro Abfrage (InitPlan) statt pro Zeile. Alle Helfer sind
-- STABLE (gleiches Ergebnis innerhalb einer Abfrage) -> semantisch identisch.
-- Aufrufe mit Zeilen-Argument (is_time_entry_locked(clock_in)) bleiben unveraendert.
--
-- Nur USING / WITH CHECK per ALTER POLICY; Namen, Rollen, Befehl, permissive
-- bleiben. Keine Policy wird zusammengelegt oder umbenannt.
-- 196 Policies auf 63 Tabellen.
--
-- Bewusst NICHT angefasst:
--   * vertrieb_* / akquise_* (Vertriebs-/Akquise-Session, Migrationen 295–301)
--   * service_reports «Zugeteilte Techniker können Rapporte bearbeiten» und
--     report_photos «Benutzer können Fotos hochladen», «Rapport-Beteiligte können
--     Fotos ändern», «Admins können Fotos löschen», «Rapport-Beteiligte können
--     Fotos löschen» (werden von Migration 301 auf Branch mobile ersetzt)
--   * ki_auftraege_select (wird von Migration 302 ersetzt)
--   * storage-Schema
--
-- Robust/idempotent: je Policy wird nur geaendert, wenn sie exakt dem
-- erwarteten Vorher-Ausdruck entspricht. Bereits gewrappt -> uebersprungen;
-- fehlt (frische DB) oder inzwischen anders geaendert -> NOTICE + uebersprungen.
-- Verifiziert vor dem Einspielen (Probelauf 2026-10-11): fuer alle 11 Nutzer
-- aller Rollen + anon liefert jede Policy alt vs. neu identische Zeilenmengen
-- (count FILTER im selben Schnappschuss); Server-Deparse der neuen Ausdruecke
-- ist textgleich mit dieser Datei.

set lock_timeout = '3s';

do $mig305$
declare
  -- Zielschema (fest public; nur fuer den Trockentest auf TEMP-Kopien umstellbar)
  s     text := 'public';
  r     record;
  cur   record;
  stmt  text;
  n_neu int := 0; n_schon int := 0; n_fehlt int := 0; n_abw int := 0;
begin
  -- Ausdruecke unten sind im Deparse-Format mit public im Suchpfad
  -- (unqualifizierte Helfer/Tabellen) -> Suchpfad transaktionslokal festlegen.
  perform set_config('search_path', 'public, extensions', true);
  for r in
    select * from (values
      ($x$app_settings$x$, $x$Admins lesen app_settings$x$,
       $x$has_permission('admin:settings'::text)$x$,
       $x$( SELECT has_permission('admin:settings'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$app_settings$x$, $x$Admins updaten app_settings$x$,
       $x$has_permission('admin:settings'::text)$x$,
       $x$( SELECT has_permission('admin:settings'::text) AS has_permission)$x$,
       $x$has_permission('admin:settings'::text)$x$,
       $x$( SELECT has_permission('admin:settings'::text) AS has_permission)$x$),
      ($x$calendar_events$x$, $x$Kalendereinträge anlegen$x$,
       null::text,
       null::text,
       $x$has_permission('kalender:create'::text)$x$,
       $x$( SELECT has_permission('kalender:create'::text) AS has_permission)$x$),
      ($x$calendar_events$x$, $x$Kalendereinträge bearbeiten$x$,
       $x$has_permission('kalender:edit'::text)$x$,
       $x$( SELECT has_permission('kalender:edit'::text) AS has_permission)$x$,
       $x$has_permission('kalender:edit'::text)$x$,
       $x$( SELECT has_permission('kalender:edit'::text) AS has_permission)$x$),
      ($x$calendar_events$x$, $x$Kalendereinträge löschen$x$,
       $x$has_permission('kalender:delete'::text)$x$,
       $x$( SELECT has_permission('kalender:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$calendar_events$x$, $x$Kalendereinträge sind sichtbar$x$,
       $x$((profile_id = auth.uid()) OR (created_by = auth.uid()) OR is_admin())$x$,
       $x$((profile_id = ( SELECT auth.uid() AS uid)) OR (created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text),
      ($x$company_settings$x$, $x$company_settings_admin_write$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$customers$x$, $x$customers_delete$x$,
       $x$has_permission('kunden:delete'::text)$x$,
       $x$( SELECT has_permission('kunden:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$customers$x$, $x$customers_insert$x$,
       null::text,
       null::text,
       $x$has_permission('kunden:create'::text)$x$,
       $x$( SELECT has_permission('kunden:create'::text) AS has_permission)$x$),
      ($x$customers$x$, $x$customers_update$x$,
       $x$has_permission('kunden:edit'::text)$x$,
       $x$( SELECT has_permission('kunden:edit'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$documents$x$, $x$Benutzer können Dokumente hochladen$x$,
       null::text,
       null::text,
       $x$(uploaded_by = auth.uid())$x$,
       $x$(uploaded_by = ( SELECT auth.uid() AS uid))$x$),
      ($x$email_log$x$, $x$E-Mail Log ist für Admins sichtbar$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$email_templates$x$, $x$Admins können Vorlagen bearbeiten$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$email_templates$x$, $x$Admins können Vorlagen erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$email_templates$x$, $x$Vorlagen sind für Admins sichtbar$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$employee_compensation$x$, $x$emp_comp_delete$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$employee_compensation$x$, $x$emp_comp_insert$x$,
       null::text,
       null::text,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$),
      ($x$employee_compensation$x$, $x$emp_comp_select$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$employee_compensation$x$, $x$emp_comp_update$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$job_anforderungen$x$, $x$job_anforderungen anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_anforderungen$x$, $x$job_anforderungen bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_anforderungen$x$, $x$job_anforderungen loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_anforderungen$x$, $x$job_anforderungen sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_appointments$x$, $x$Termine anlegen$x$,
       null::text,
       null::text,
       $x$has_permission('kalender:create'::text)$x$,
       $x$( SELECT has_permission('kalender:create'::text) AS has_permission)$x$),
      ($x$job_appointments$x$, $x$Termine bearbeiten$x$,
       $x$has_permission('kalender:edit'::text)$x$,
       $x$( SELECT has_permission('kalender:edit'::text) AS has_permission)$x$,
       $x$has_permission('kalender:edit'::text)$x$,
       $x$( SELECT has_permission('kalender:edit'::text) AS has_permission)$x$),
      ($x$job_appointments$x$, $x$Termine löschen$x$,
       $x$has_permission('kalender:delete'::text)$x$,
       $x$( SELECT has_permission('kalender:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$job_draft_notes$x$, $x$job_draft_notes_delete$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$job_draft_notes$x$, $x$job_draft_notes_insert$x$,
       null::text,
       null::text,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$),
      ($x$job_draft_notes$x$, $x$job_draft_notes_select$x$,
       $x$has_permission('auftraege:view'::text)$x$,
       $x$( SELECT has_permission('auftraege:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$job_draft_notes$x$, $x$job_draft_notes_update$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$),
      ($x$job_drafts$x$, $x$job_drafts_delete$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$job_drafts$x$, $x$job_drafts_insert$x$,
       null::text,
       null::text,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$),
      ($x$job_drafts$x$, $x$job_drafts_select$x$,
       $x$has_permission('auftraege:view'::text)$x$,
       $x$( SELECT has_permission('auftraege:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$job_drafts$x$, $x$job_drafts_update$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$),
      ($x$job_inbox_items$x$, $x$jii_delete$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND ((created_by = auth.uid()) OR is_admin()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))$x$,
       null::text,
       null::text),
      ($x$job_inbox_items$x$, $x$jii_insert$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (j.id = job_inbox_items.job_id))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (j.id = job_inbox_items.job_id))))$x$),
      ($x$job_inbox_items$x$, $x$jii_select$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (j.id = job_inbox_items.job_id))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (j.id = job_inbox_items.job_id))))$x$,
       null::text,
       null::text),
      ($x$job_inbox_items$x$, $x$jii_update$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND ((created_by = auth.uid()) OR is_admin()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND ((created_by = auth.uid()) OR is_admin()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))$x$),
      ($x$job_lieferanten$x$, $x$job_lieferanten anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_lieferanten$x$, $x$job_lieferanten bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_lieferanten$x$, $x$job_lieferanten loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_lieferanten$x$, $x$job_lieferanten sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_overdue_reminders$x$, $x$job_overdue_reminders_select_admin$x$,
       $x$(EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text))))$x$,
       null::text,
       null::text),
      ($x$job_plan_objekte$x$, $x$Plan-Objekte anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_plan_objekte$x$, $x$Plan-Objekte bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_plan_objekte$x$, $x$Plan-Objekte loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_plan_objekte$x$, $x$Plan-Objekte sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_aktivitaet$x$, $x$job_technik_aktivitaet anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_aktivitaet$x$, $x$job_technik_aktivitaet bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_aktivitaet$x$, $x$job_technik_aktivitaet loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_aktivitaet$x$, $x$job_technik_aktivitaet sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_kommentare$x$, $x$job_technik_kommentare anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_kommentare$x$, $x$job_technik_kommentare bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_kommentare$x$, $x$job_technik_kommentare loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_kommentare$x$, $x$job_technik_kommentare sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_positionen$x$, $x$job_technik_positionen anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_positionen$x$, $x$job_technik_positionen bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_positionen$x$, $x$job_technik_positionen loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_positionen$x$, $x$job_technik_positionen sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_reviews$x$, $x$job_technik_reviews anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_reviews$x$, $x$job_technik_reviews bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$job_technik_reviews$x$, $x$job_technik_reviews loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_technik_reviews$x$, $x$job_technik_reviews sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$job_verantwortlich_verlauf$x$, $x$job_verantwortlich_verlauf_select$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (j.id = job_verantwortlich_verlauf.job_id))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (j.id = job_verantwortlich_verlauf.job_id))))$x$,
       null::text,
       null::text),
      ($x$jobs$x$, $x$jobs_delete$x$,
       $x$has_permission('auftraege:delete'::text)$x$,
       $x$( SELECT has_permission('auftraege:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$jobs$x$, $x$jobs_insert$x$,
       null::text,
       null::text,
       $x$has_permission('auftraege:create'::text)$x$,
       $x$( SELECT has_permission('auftraege:create'::text) AS has_permission)$x$),
      ($x$jobs$x$, $x$jobs_update_perm$x$,
       $x$has_permission('auftraege:edit'::text)$x$,
       $x$( SELECT has_permission('auftraege:edit'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$lieferant_katalog_artikel$x$, $x$lka_delete$x$,
       $x$(has_permission('lieferanten:edit'::text) OR is_admin())$x$,
       $x$(( SELECT has_permission('lieferanten:edit'::text) AS has_permission) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text),
      ($x$lieferant_katalog_artikel$x$, $x$lka_insert$x$,
       null::text,
       null::text,
       $x$(has_permission('lieferanten:edit'::text) OR is_admin())$x$,
       $x$(( SELECT has_permission('lieferanten:edit'::text) AS has_permission) OR ( SELECT is_admin() AS is_admin))$x$),
      ($x$lieferant_katalog_artikel$x$, $x$lka_select$x$,
       $x$(has_permission('lieferanten:view'::text) OR is_admin() OR (is_lieferant() AND (lieferant_id = ( SELECT profiles.lieferant_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))))$x$,
       $x$(( SELECT has_permission('lieferanten:view'::text) AS has_permission) OR ( SELECT is_admin() AS is_admin) OR (( SELECT is_lieferant() AS is_lieferant) AND (lieferant_id = ( SELECT profiles.lieferant_id
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))))))$x$,
       null::text,
       null::text),
      ($x$lieferant_katalog_artikel$x$, $x$lka_update$x$,
       $x$(has_permission('lieferanten:edit'::text) OR is_admin())$x$,
       $x$(( SELECT has_permission('lieferanten:edit'::text) AS has_permission) OR ( SELECT is_admin() AS is_admin))$x$,
       $x$(has_permission('lieferanten:edit'::text) OR is_admin())$x$,
       $x$(( SELECT has_permission('lieferanten:edit'::text) AS has_permission) OR ( SELECT is_admin() AS is_admin))$x$),
      ($x$lieferant_regeln$x$, $x$lieferant_regeln anlegen$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$lieferant_regeln$x$, $x$lieferant_regeln bearbeiten$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$),
      ($x$lieferant_regeln$x$, $x$lieferant_regeln loeschen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$lieferant_regeln$x$, $x$lieferant_regeln sehen$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)))$x$,
       null::text,
       null::text),
      ($x$lieferanten$x$, $x$Lieferanten anlegen$x$,
       null::text,
       null::text,
       $x$has_permission('lieferanten:create'::text)$x$,
       $x$( SELECT has_permission('lieferanten:create'::text) AS has_permission)$x$),
      ($x$lieferanten$x$, $x$Lieferanten bearbeiten$x$,
       $x$has_permission('lieferanten:edit'::text)$x$,
       $x$( SELECT has_permission('lieferanten:edit'::text) AS has_permission)$x$,
       $x$has_permission('lieferanten:edit'::text)$x$,
       $x$( SELECT has_permission('lieferanten:edit'::text) AS has_permission)$x$),
      ($x$lieferanten$x$, $x$Lieferanten löschen$x$,
       $x$has_permission('lieferanten:delete'::text)$x$,
       $x$( SELECT has_permission('lieferanten:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$lieferanten$x$, $x$Lieferanten sehen$x$,
       $x$has_permission('lieferanten:view'::text)$x$,
       $x$( SELECT has_permission('lieferanten:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$lieferanten$x$, $x$lieferant_sieht_eigene_firma$x$,
       $x$(id = ( SELECT profiles.lieferant_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))$x$,
       $x$(id = ( SELECT profiles.lieferant_id
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))))$x$,
       null::text,
       null::text),
      ($x$location_contacts$x$, $x$Admins können Kontakte bearbeiten$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$location_contacts$x$, $x$Admins können Kontakte erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$location_contacts$x$, $x$Admins können Kontakte löschen$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$location_contacts$x$, $x$Standort-Kontakte sehen$x$,
       $x$has_permission('locations:view'::text)$x$,
       $x$( SELECT has_permission('locations:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$location_rate_tier_prices$x$, $x$rate_prices_write_admin$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$location_rate_tiers$x$, $x$rate_tiers_write_admin$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$locations$x$, $x$Admins können Standorte bearbeiten$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$locations$x$, $x$Admins können Standorte erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$locations$x$, $x$locations_delete$x$,
       $x$has_permission('locations:delete'::text)$x$,
       $x$( SELECT has_permission('locations:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$locations$x$, $x$locations_insert$x$,
       null::text,
       null::text,
       $x$has_permission('locations:create'::text)$x$,
       $x$( SELECT has_permission('locations:create'::text) AS has_permission)$x$),
      ($x$locations$x$, $x$locations_select$x$,
       $x$has_permission('locations:view'::text)$x$,
       $x$( SELECT has_permission('locations:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$locations$x$, $x$locations_update$x$,
       $x$(has_permission('locations:edit'::text) OR has_permission('locations:archive'::text))$x$,
       $x$(( SELECT has_permission('locations:edit'::text) AS has_permission) OR ( SELECT has_permission('locations:archive'::text) AS has_permission))$x$,
       $x$(has_permission('locations:edit'::text) OR has_permission('locations:archive'::text))$x$,
       $x$(( SELECT has_permission('locations:edit'::text) AS has_permission) OR ( SELECT has_permission('locations:archive'::text) AS has_permission))$x$),
      ($x$notifications$x$, $x$Eigene Notifications löschen$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$notifications$x$, $x$Eigene Notifications sehen$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$notifications$x$, $x$Eigene Notifications updaten$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$notifications$x$, $x$Notifications erstellen$x$,
       null::text,
       null::text,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$),
      ($x$office_attendance$x$, $x$anwesenheit_delete_own$x$,
       $x$(((user_id = auth.uid()) OR is_admin()) AND has_permission('anwesenheit:view'::text))$x$,
       $x$(((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)) AND ( SELECT has_permission('anwesenheit:view'::text) AS has_permission))$x$,
       null::text,
       null::text),
      ($x$office_attendance$x$, $x$anwesenheit_insert_own$x$,
       null::text,
       null::text,
       $x$((user_id = auth.uid()) AND has_permission('anwesenheit:view'::text))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT has_permission('anwesenheit:view'::text) AS has_permission))$x$),
      ($x$office_attendance$x$, $x$anwesenheit_select$x$,
       $x$has_permission('anwesenheit:view'::text)$x$,
       $x$( SELECT has_permission('anwesenheit:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$office_attendance$x$, $x$anwesenheit_update_own$x$,
       $x$((user_id = auth.uid()) AND has_permission('anwesenheit:view'::text))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT has_permission('anwesenheit:view'::text) AS has_permission))$x$,
       $x$((user_id = auth.uid()) AND has_permission('anwesenheit:view'::text))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND ( SELECT has_permission('anwesenheit:view'::text) AS has_permission))$x$),
      ($x$partner_form_template$x$, $x$partner_form_template_admin_write$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$partner_form_template$x$, $x$partner_form_template_select$x$,
       $x$(is_admin_or_lead() OR ((scope = 'global'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'partner'::text))))) OR ((scope = 'location'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'partner'::text) AND (p.partner_location_id = partner_form_template.location_id))))))$x$,
       $x$(( SELECT is_admin_or_lead() AS is_admin_or_lead) OR ((scope = 'global'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'partner'::text))))) OR ((scope = 'location'::text) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'partner'::text) AND (p.partner_location_id = partner_form_template.location_id))))))$x$,
       null::text,
       null::text),
      ($x$payroll_defaults$x$, $x$payroll_defaults_delete$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$payroll_defaults$x$, $x$payroll_defaults_insert$x$,
       null::text,
       null::text,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$),
      ($x$payroll_defaults$x$, $x$payroll_defaults_select$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$payroll_defaults$x$, $x$payroll_defaults_update$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$,
       $x$has_permission('lohn:manage'::text)$x$,
       $x$( SELECT has_permission('lohn:manage'::text) AS has_permission)$x$),
      ($x$permission_audit_log$x$, $x$permission_audit_select_admin$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       null::text,
       null::text),
      ($x$profiles$x$, $x$Admins können Profile bearbeiten$x$,
       $x$(( SELECT profiles_1.role
   FROM profiles profiles_1
  WHERE (profiles_1.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles_1.role
   FROM profiles profiles_1
  WHERE (profiles_1.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$project_appointment_notes$x$, $x$pan_delete$x$,
       $x$(is_admin() OR (created_by = auth.uid()))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR (created_by = ( SELECT auth.uid() AS uid)))$x$,
       null::text,
       null::text),
      ($x$project_appointment_notes$x$, $x$pan_insert$x$,
       null::text,
       null::text,
       $x$((created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (project_appointments a
     JOIN projects p ON ((p.id = a.project_id)))
  WHERE ((a.id = project_appointment_notes.appointment_id) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (a.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members m
          WHERE ((m.project_id = a.project_id) AND (m.user_id = auth.uid())))))))))$x$,
       $x$((created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM (project_appointments a
     JOIN projects p ON ((p.id = a.project_id)))
  WHERE ((a.id = project_appointment_notes.appointment_id) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (a.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members m
          WHERE ((m.project_id = a.project_id) AND (m.user_id = ( SELECT auth.uid() AS uid))))))))))$x$),
      ($x$project_appointment_notes$x$, $x$pan_update$x$,
       $x$(is_admin() OR (created_by = auth.uid()))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR (created_by = ( SELECT auth.uid() AS uid)))$x$,
       $x$(is_admin() OR (created_by = auth.uid()))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR (created_by = ( SELECT auth.uid() AS uid)))$x$),
      ($x$project_appointment_participants$x$, $x$pap_delete$x$,
       $x$(EXISTS ( SELECT 1
   FROM (project_appointments a
     JOIN projects p ON ((p.id = a.project_id)))
  WHERE ((a.id = project_appointment_participants.appointment_id) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (a.created_by = auth.uid()) OR (p.assigned_to = auth.uid())))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM (project_appointments a
     JOIN projects p ON ((p.id = a.project_id)))
  WHERE ((a.id = project_appointment_participants.appointment_id) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (a.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid))))))$x$,
       null::text,
       null::text),
      ($x$project_appointment_participants$x$, $x$pap_insert$x$,
       null::text,
       null::text,
       $x$(EXISTS ( SELECT 1
   FROM (project_appointments a
     JOIN projects p ON ((p.id = a.project_id)))
  WHERE ((a.id = project_appointment_participants.appointment_id) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (a.created_by = auth.uid()) OR (p.assigned_to = auth.uid())))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM (project_appointments a
     JOIN projects p ON ((p.id = a.project_id)))
  WHERE ((a.id = project_appointment_participants.appointment_id) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (a.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid))))))$x$),
      ($x$project_appointments$x$, $x$pa_delete$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$,
       null::text,
       null::text),
      ($x$project_appointments$x$, $x$pa_insert$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$),
      ($x$project_appointments$x$, $x$pa_select$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$,
       null::text,
       null::text),
      ($x$project_appointments$x$, $x$pa_update$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_appointments.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$),
      ($x$project_audit$x$, $x$pa_audit_insert$x$,
       null::text,
       null::text,
       $x$(changed_by = auth.uid())$x$,
       $x$(changed_by = ( SELECT auth.uid() AS uid))$x$),
      ($x$project_doc_versions$x$, $x$pdocv_delete$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       null::text,
       null::text),
      ($x$project_doc_versions$x$, $x$pdocv_insert$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (project_docs d
     JOIN projects p ON ((p.id = d.project_id)))
  WHERE ((d.id = project_doc_versions.doc_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:approve'::text) OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM (project_docs d
     JOIN projects p ON ((p.id = d.project_id)))
  WHERE ((d.id = project_doc_versions.doc_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$),
      ($x$project_doc_versions$x$, $x$pdocv_select$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM (project_docs d
     JOIN projects p ON ((p.id = d.project_id)))
  WHERE ((d.id = project_doc_versions.doc_id) AND (NOT p.is_deleted)))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM (project_docs d
     JOIN projects p ON ((p.id = d.project_id)))
  WHERE ((d.id = project_doc_versions.doc_id) AND (NOT p.is_deleted)))))$x$,
       null::text,
       null::text),
      ($x$project_doc_versions$x$, $x$pdocv_update$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$project_docs$x$, $x$pdocs_delete$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:approve'::text) OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$,
       null::text,
       null::text),
      ($x$project_docs$x$, $x$pdocs_insert$x$,
       null::text,
       null::text,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:approve'::text) OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (created_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$),
      ($x$project_docs$x$, $x$pdocs_select$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted)))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted)))))$x$,
       null::text,
       null::text),
      ($x$project_docs$x$, $x$pdocs_update$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:approve'::text) OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (is_admin() OR has_permission('projekte:approve'::text) OR has_permission('projekte:see-all'::text) OR (p.created_by = auth.uid()) OR (p.assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = auth.uid())))))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_docs.project_id) AND (NOT p.is_deleted) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR ( SELECT has_permission('projekte:see-all'::text) AS has_permission) OR (p.created_by = ( SELECT auth.uid() AS uid)) OR (p.assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members pm
          WHERE ((pm.project_id = p.id) AND (pm.user_id = ( SELECT auth.uid() AS uid))))))))))$x$),
      ($x$project_members$x$, $x$pm_delete$x$,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text),
      ($x$project_members$x$, $x$pm_insert$x$,
       null::text,
       null::text,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$),
      ($x$project_time_entries$x$, $x$pte_delete$x$,
       $x$(is_admin() OR ((user_id = auth.uid()) AND (created_at > (now() - '24:00:00'::interval))))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (created_at > (now() - '24:00:00'::interval))))$x$,
       null::text,
       null::text),
      ($x$project_time_entries$x$, $x$pte_insert$x$,
       null::text,
       null::text,
       $x$(is_admin() OR ((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (projects p
     JOIN project_members m ON (((m.project_id = p.id) AND (m.user_id = auth.uid()))))
  WHERE ((p.id = m.project_id) AND (p.status = 'genehmigt'::text) AND (NOT p.is_deleted))))))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM (projects p
     JOIN project_members m ON (((m.project_id = p.id) AND (m.user_id = ( SELECT auth.uid() AS uid)))))
  WHERE ((p.id = m.project_id) AND (p.status = 'genehmigt'::text) AND (NOT p.is_deleted))))))$x$),
      ($x$project_time_entries$x$, $x$pte_update$x$,
       $x$(is_admin() OR (user_id = auth.uid()))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR (user_id = ( SELECT auth.uid() AS uid)))$x$,
       $x$(is_admin() OR (user_id = auth.uid()))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR (user_id = ( SELECT auth.uid() AS uid)))$x$),
      ($x$projects$x$, $x$projects_delete$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       null::text,
       null::text),
      ($x$projects$x$, $x$projects_insert$x$,
       null::text,
       null::text,
       $x$(is_admin() OR ((created_by = auth.uid()) AND (assigned_to = auth.uid()) AND (status = ANY (ARRAY['entwurf'::text, 'angefragt'::text])) AND (budget_hours IS NULL) AND (approved_by IS NULL)))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR ((created_by = ( SELECT auth.uid() AS uid)) AND (assigned_to = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['entwurf'::text, 'angefragt'::text])) AND (budget_hours IS NULL) AND (approved_by IS NULL)))$x$),
      ($x$projects$x$, $x$projects_update$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND ((NOT is_deleted) OR is_admin()) AND (is_admin() OR has_permission('projekte:approve'::text) OR (created_by = auth.uid()) OR (assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
   FROM project_members pm
  WHERE ((pm.project_id = projects.id) AND (pm.user_id = auth.uid()))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND ((NOT is_deleted) OR ( SELECT is_admin() AS is_admin)) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR (created_by = ( SELECT auth.uid() AS uid)) OR (assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM project_members pm
  WHERE ((pm.project_id = projects.id) AND (pm.user_id = ( SELECT auth.uid() AS uid)))))))$x$,
       $x$((NOT is_partner()) AND (NOT is_lieferant()) AND ((is_deleted = false) OR is_admin()) AND (is_admin() OR has_permission('projekte:approve'::text) OR (created_by = auth.uid()) OR (assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
   FROM project_members pm
  WHERE ((pm.project_id = projects.id) AND (pm.user_id = auth.uid()))))))$x$,
       $x$((NOT ( SELECT is_partner() AS is_partner)) AND (NOT ( SELECT is_lieferant() AS is_lieferant)) AND ((is_deleted = false) OR ( SELECT is_admin() AS is_admin)) AND (( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('projekte:approve'::text) AS has_permission) OR (created_by = ( SELECT auth.uid() AS uid)) OR (assigned_to = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM project_members pm
  WHERE ((pm.project_id = projects.id) AND (pm.user_id = ( SELECT auth.uid() AS uid)))))))$x$),
      ($x$push_subscriptions$x$, $x$push_delete_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$push_subscriptions$x$, $x$push_insert_own$x$,
       null::text,
       null::text,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$push_subscriptions$x$, $x$push_select_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$rental_requests$x$, $x$Admins können Anfragen bearbeiten$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$rental_requests$x$, $x$Admins können Anfragen erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$report_photos$x$, $x$Fotos sind sichtbar$x$,
       $x$(EXISTS ( SELECT 1
   FROM service_reports r
  WHERE ((r.id = report_photos.report_id) AND ((r.created_by = auth.uid()) OR is_admin()))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM service_reports r
  WHERE ((r.id = report_photos.report_id) AND ((r.created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))))$x$,
       null::text,
       null::text),
      ($x$roles$x$, $x$Rollen anlegen$x$,
       null::text,
       null::text,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$roles$x$, $x$Rollen bearbeiten$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$roles$x$, $x$Rollen loeschen$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       null::text,
       null::text),
      ($x$roles$x$, $x$Rollen sehen$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       null::text,
       null::text),
      ($x$room_contacts$x$, $x$Admins können Raum-Kontakte bearbeiten$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$room_contacts$x$, $x$Admins können Raum-Kontakte erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$room_contacts$x$, $x$Admins können Raum-Kontakte löschen$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$room_contacts$x$, $x$Raum-Kontakte sehen$x$,
       $x$has_permission('locations:view'::text)$x$,
       $x$( SELECT has_permission('locations:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$room_prices$x$, $x$Admins können Raum-Preise bearbeiten$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$room_prices$x$, $x$Admins können Raum-Preise erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$room_prices$x$, $x$Admins können Raum-Preise löschen$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$room_prices$x$, $x$Raum-Preise sehen$x$,
       $x$has_permission('locations:view'::text)$x$,
       $x$( SELECT has_permission('locations:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$rooms$x$, $x$Admins können Räume bearbeiten$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$rooms$x$, $x$Admins können Räume erstellen$x$,
       null::text,
       null::text,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$),
      ($x$rooms$x$, $x$Admins können Räume löschen$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$rooms$x$, $x$rooms_delete$x$,
       $x$has_permission('locations:delete'::text)$x$,
       $x$( SELECT has_permission('locations:delete'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$rooms$x$, $x$rooms_insert$x$,
       null::text,
       null::text,
       $x$has_permission('locations:create'::text)$x$,
       $x$( SELECT has_permission('locations:create'::text) AS has_permission)$x$),
      ($x$rooms$x$, $x$rooms_select$x$,
       $x$has_permission('locations:view'::text)$x$,
       $x$( SELECT has_permission('locations:view'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$rooms$x$, $x$rooms_update$x$,
       $x$has_permission('locations:edit'::text)$x$,
       $x$( SELECT has_permission('locations:edit'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$service_reports$x$, $x$Admins können alle Rapporte bearbeiten$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)$x$,
       $x$(( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text)$x$,
       null::text,
       null::text),
      ($x$service_reports$x$, $x$Benutzer können Rapporte erstellen$x$,
       null::text,
       null::text,
       $x$(created_by = auth.uid())$x$,
       $x$(created_by = ( SELECT auth.uid() AS uid))$x$),
      ($x$service_reports$x$, $x$Ersteller können Rapporte bearbeiten$x$,
       $x$(created_by = auth.uid())$x$,
       $x$(created_by = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$service_reports$x$, $x$Rapporte sind sichtbar$x$,
       $x$(is_admin() OR (created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.is_active = true) AND (p.role <> ALL (ARRAY['partner'::text, 'lieferant'::text]))))))$x$,
       $x$(( SELECT is_admin() AS is_admin) OR (created_by = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_active = true) AND (p.role <> ALL (ARRAY['partner'::text, 'lieferant'::text]))))))$x$,
       null::text,
       null::text),
      ($x$ticket_attachments$x$, $x$ticket_attachments_delete$x$,
       $x$((uploaded_by = auth.uid()) OR is_admin() OR has_permission('tickets:manage'::text))$x$,
       $x$((uploaded_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('tickets:manage'::text) AS has_permission))$x$,
       null::text,
       null::text),
      ($x$ticket_attachments$x$, $x$ticket_attachments_insert$x$,
       null::text,
       null::text,
       $x$((uploaded_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_attachments.ticket_id) AND ((t.created_by = auth.uid()) OR is_admin() OR has_permission('tickets:manage'::text))))))$x$,
       $x$((uploaded_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_attachments.ticket_id) AND ((t.created_by = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('tickets:manage'::text) AS has_permission))))))$x$),
      ($x$ticket_attachments$x$, $x$ticket_attachments_select$x$,
       $x$(EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_attachments.ticket_id) AND ((t.created_by = auth.uid()) OR (t.assigned_to = auth.uid()) OR is_admin() OR has_permission('tickets:manage'::text)))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_attachments.ticket_id) AND ((t.created_by = ( SELECT auth.uid() AS uid)) OR (t.assigned_to = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin) OR ( SELECT has_permission('tickets:manage'::text) AS has_permission)))))$x$,
       null::text,
       null::text),
      ($x$tickets$x$, $x$tickets_delete_admin$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       null::text,
       null::text),
      ($x$tickets$x$, $x$tickets_insert_self$x$,
       null::text,
       null::text,
       $x$(created_by = auth.uid())$x$,
       $x$(created_by = ( SELECT auth.uid() AS uid))$x$),
      ($x$tickets$x$, $x$tickets_update_own_open$x$,
       $x$((created_by = auth.uid()) AND (status = 'offen'::ticket_status))$x$,
       $x$((created_by = ( SELECT auth.uid() AS uid)) AND (status = 'offen'::ticket_status))$x$,
       $x$((created_by = auth.uid()) AND (status = 'offen'::ticket_status))$x$,
       $x$((created_by = ( SELECT auth.uid() AS uid)) AND (status = 'offen'::ticket_status))$x$),
      ($x$time_entries$x$, $x$time_entries_insert_own$x$,
       null::text,
       null::text,
       $x$((user_id = auth.uid()) AND (NOT is_time_entry_locked(clock_in)))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND (NOT is_time_entry_locked(clock_in)))$x$),
      ($x$time_off$x$, $x$Eigene Ferien aendern wenn beantragt$x$,
       $x$((user_id = auth.uid()) AND (status = 'beantragt'::text))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND (status = 'beantragt'::text))$x$,
       $x$((user_id = auth.uid()) AND (status = 'beantragt'::text) AND (approved_by IS NULL) AND (approved_at IS NULL) AND (decision_note IS NULL))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND (status = 'beantragt'::text) AND (approved_by IS NULL) AND (approved_at IS NULL) AND (decision_note IS NULL))$x$),
      ($x$time_off$x$, $x$Eigene Ferien anlegen$x$,
       null::text,
       null::text,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$time_off$x$, $x$Eigene Ferien loeschen wenn beantragt$x$,
       $x$((user_id = auth.uid()) AND (status = 'beantragt'::text))$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) AND (status = 'beantragt'::text))$x$,
       null::text,
       null::text),
      ($x$time_off$x$, $x$Eigene Ferien sehen$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$todo_attachments$x$, $x$Eigene Todo-Anhaenge erstellen$x$,
       null::text,
       null::text,
       $x$(EXISTS ( SELECT 1
   FROM todos t
  WHERE ((t.id = todo_attachments.todo_id) AND ((t.created_by = auth.uid()) OR (t.assigned_to = auth.uid())))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM todos t
  WHERE ((t.id = todo_attachments.todo_id) AND ((t.created_by = ( SELECT auth.uid() AS uid)) OR (t.assigned_to = ( SELECT auth.uid() AS uid))))))$x$),
      ($x$todo_attachments$x$, $x$Eigene Todo-Anhaenge loeschen$x$,
       $x$(EXISTS ( SELECT 1
   FROM todos t
  WHERE ((t.id = todo_attachments.todo_id) AND ((t.created_by = auth.uid()) OR (t.assigned_to = auth.uid()) OR is_admin()))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM todos t
  WHERE ((t.id = todo_attachments.todo_id) AND ((t.created_by = ( SELECT auth.uid() AS uid)) OR (t.assigned_to = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))))$x$,
       null::text,
       null::text),
      ($x$todo_attachments$x$, $x$Eigene Todo-Anhaenge sichtbar$x$,
       $x$(EXISTS ( SELECT 1
   FROM todos t
  WHERE ((t.id = todo_attachments.todo_id) AND ((t.created_by = auth.uid()) OR (t.assigned_to = auth.uid()) OR is_admin()))))$x$,
       $x$(EXISTS ( SELECT 1
   FROM todos t
  WHERE ((t.id = todo_attachments.todo_id) AND ((t.created_by = ( SELECT auth.uid() AS uid)) OR (t.assigned_to = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin)))))$x$,
       null::text,
       null::text),
      ($x$todos$x$, $x$Eigene Todos erstellen$x$,
       null::text,
       null::text,
       $x$(created_by = auth.uid())$x$,
       $x$(created_by = ( SELECT auth.uid() AS uid))$x$),
      ($x$trusted_devices$x$, $x$trusted_devices_self_delete$x$,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text),
      ($x$trusted_devices$x$, $x$trusted_devices_self_insert$x$,
       null::text,
       null::text,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$trusted_devices$x$, $x$trusted_devices_self_revoke$x$,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$),
      ($x$trusted_devices$x$, $x$trusted_devices_self_select$x$,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text),
      ($x$user_notification_settings$x$, $x$uns_delete_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$user_notification_settings$x$, $x$uns_insert_own$x$,
       null::text,
       null::text,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$user_notification_settings$x$, $x$uns_select_own_or_admin$x$,
       $x$((user_id = auth.uid()) OR is_admin())$x$,
       $x$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text),
      ($x$user_notification_settings$x$, $x$uns_update_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$user_passkeys$x$, $x$passkeys_delete_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$user_passkeys$x$, $x$passkeys_insert_own$x$,
       null::text,
       null::text,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$user_passkeys$x$, $x$passkeys_select_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$user_passkeys$x$, $x$passkeys_update_own$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$user_sessions$x$, $x$Admins sehen alle Sessions$x$,
       $x$has_permission('admin:activity'::text)$x$,
       $x$( SELECT has_permission('admin:activity'::text) AS has_permission)$x$,
       null::text,
       null::text),
      ($x$user_sessions$x$, $x$Eigene Sessions anlegen$x$,
       null::text,
       null::text,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$user_sessions$x$, $x$Eigene Sessions sehen$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       null::text,
       null::text),
      ($x$user_sessions$x$, $x$Eigene Sessions updaten$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$,
       $x$(user_id = auth.uid())$x$,
       $x$(user_id = ( SELECT auth.uid() AS uid))$x$),
      ($x$wage_documents$x$, $x$wage_documents_admin_write$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$,
       $x$is_admin()$x$,
       $x$( SELECT is_admin() AS is_admin)$x$),
      ($x$wage_documents$x$, $x$wage_documents_select$x$,
       $x$((profile_id = auth.uid()) OR is_admin())$x$,
       $x$((profile_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_admin() AS is_admin))$x$,
       null::text,
       null::text)
    ) as v(tab, pol, von_using, nach_using, von_check, nach_check)
  loop
    select p.qual, p.with_check into cur
      from pg_policies p
     where p.schemaname = s and p.tablename = r.tab and p.policyname = r.pol;
    if not found then
      -- Policy existiert (noch) nicht, z. B. frische DB ohne diese Tabelle
      n_fehlt := n_fehlt + 1;
      raise notice '305 rls_initplan: Policy fehlt, uebersprungen: %.%', r.tab, r.pol;
      continue;
    end if;
    if cur.qual is not distinct from r.nach_using and cur.with_check is not distinct from r.nach_check then
      n_schon := n_schon + 1;   -- bereits auf Zielstand (idempotent)
      continue;
    end if;
    if cur.qual is distinct from r.von_using or cur.with_check is distinct from r.von_check then
      -- Policy wurde inzwischen anders geaendert -> nicht ueberschreiben
      n_abw := n_abw + 1;
      raise notice '305 rls_initplan: Policy weicht vom erwarteten Stand ab, uebersprungen: %.%', r.tab, r.pol;
      continue;
    end if;
    stmt := format('alter policy %I on %I.%I', r.pol, s, r.tab);
    if r.nach_using is not null then stmt := stmt || ' using (' || r.nach_using || ')'; end if;
    if r.nach_check is not null then stmt := stmt || ' with check (' || r.nach_check || ')'; end if;
    execute stmt;
    n_neu := n_neu + 1;
  end loop;
  raise notice '305 rls_initplan: % geaendert, % bereits auf Zielstand, % fehlen, % abweichend (von 196)',
    n_neu, n_schon, n_fehlt, n_abw;
end
$mig305$;
