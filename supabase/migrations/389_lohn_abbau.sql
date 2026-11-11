-- 389: Lohn-Abbau Phase 2 — die Lohn-RECHNUNG des ERP entfernen (Mischa 11.11.2026).
--
-- Der Lohn läuft ab Lohnmonat November 2026 vollständig über Trust flow (Migration 388).
-- Code-Abbau vorher deployt (Lohnlauf/Cron, /lohn/verwaltung, Lohnzeilen, Standardwerte,
-- Zusatzposten, Korrektur-Vorschläge, Ausbezahlt, BVG-Prognose). Diese Migration entfernt,
-- was in der Datenbank nur noch die Lohnrechnung brauchte.
--
-- WEG (vorher vollständig gesichert: projects\_artifacts\db-sicherung-erp\lohn-abbau-2026-11-11\,
-- SQL-Struktur + INSERTs + CSV je Tabelle, README mit Zeilenzahlen/Prüfsummen):
--   Tabellen  employee_compensation (Lohnzeilen), payroll_defaults (Standardwerte),
--             lohn_zusatzposten, lohn_korrektur_vorschlaege, lohn_auszahlungen, lohn_lauf
--             (ihre Trigger fallen mit der Tabelle)
--   Funktionen get_monthly_payroll_stats, get_location_stats, get_current_bvg_threshold,
--             lohn_lauf_starten, lohn_zusatzposten_lauf_bis, payroll_defaults_touch_updated_at,
--             lohn_schutz_firmensaetze, lohn_schutz_lohnzeile, lohn_momentaufnahme_speichern,
--             lohn_dokument_archivieren, lohn_dokument_wiederherstellen, get_my_wage_consent
--             (von keinem Code und keiner anderen Funktion mehr aufgerufen)
--
-- ERSETZT (Trigger auf time_entries/profiles/roles bleiben, nur ohne Bezug auf die Lohnrechnung):
--   lohn_schutz_profil            Person nicht löschbar bei Lohndokumenten/Stempeln/Abwesenheiten
--                                 (ohne «Lohnzeilen» — die Tabelle gibt es nicht mehr)
--   preserve_user_name_history    ohne employee_compensation/payroll_defaults
--   lohn_antrag_spalten           Anträge nur noch für Stempel (time_entries)
--   lohn_ignorierte_felder        nur noch time_entries, lohn_anstellungen
--   lohn_aenderung_betrifft_ab    nur noch time_entries, lohn_anstellungen
--   lohn_tag_gesperrt             ohne payroll_defaults-Sonderfall
--   lohn_aenderungs_antraege.bereich nur noch 'stempel' (0 Anträge anderer Bereiche)
--
-- BLEIBT (Aufbewahrung 10 Jahre bzw. von Trust-flow-Schnittstellen gebraucht): wage_documents +
-- Storage «lohndokumente», lohn_momentaufnahmen, lohn_fassungen_gueltig, lohn_bexio_fassungen,
-- lohn_dokument_protokoll, lohn_dokument_zustellung(+_verlauf), lohn_zustellung_wahl, lohn_dossiers,
-- lohn_aenderungen, lohn_aenderungs_antraege, lohn_anstellungen, lohn_einstellungen, personal_saetze,
-- rechte_antraege, flow_abrufe, Monatssperre/Protokoll/Schutz der Stempel.
--
-- Idempotent. Eingespielt 11.11.2026 nach dem Code-Deploy 4582a71f.
-- Rückweg: supabase/lokal/lohn-abbau/389_rueckweg.sql (+ Sicherung).

begin;

-- 1. Funktionen ersetzen, die eine der wegfallenden Tabellen im Text nennen ------------------

create or replace function public.lohn_schutz_profil()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_grund text;
begin
  if exists (select 1 from public.wage_documents where profile_id = old.id) then
    v_grund := 'Lohndokumente';
  elsif exists (select 1 from public.time_entries where user_id = old.id) then
    v_grund := 'Stempelzeiten';
  elsif exists (select 1 from public.time_off where user_id = old.id and status <> 'beantragt') then
    v_grund := 'Abwesenheiten';
  end if;
  if v_grund is not null then
    raise exception 'profiles: Person hat % (Aufbewahrungspflicht) — nicht löschbar, nur archivieren (deaktivieren)', v_grund
      using errcode = 'P0001';
  end if;
  return old;
end;
$function$;

create or replace function public.preserve_user_name_history()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_name text := COALESCE(OLD.full_name, '');
BEGIN
  IF v_name = '' THEN
    RETURN OLD;
  END IF;
  UPDATE public.bexio_connection          SET connected_by_name          = v_name WHERE connected_by          = OLD.id;
  UPDATE public.calendar_events           SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.calendar_events           SET profile_id_name            = v_name WHERE profile_id            = OLD.id;
  UPDATE public.company_settings          SET updated_by_name            = v_name WHERE updated_by            = OLD.id;
  UPDATE public.documents                 SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;
  UPDATE public.job_appointments          SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.job_draft_notes           SET author_id_name             = v_name WHERE author_id             = OLD.id;
  UPDATE public.job_drafts                SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.job_drafts                SET owner_id_name              = v_name WHERE owner_id              = OLD.id;
  UPDATE public.jobs                      SET accepted_by_name           = v_name WHERE accepted_by           = OLD.id;
  UPDATE public.jobs                      SET cancelled_by_name          = v_name WHERE cancelled_by          = OLD.id;
  UPDATE public.jobs                      SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.jobs                      SET invoice_skipped_by_name    = v_name WHERE invoice_skipped_by    = OLD.id;
  UPDATE public.jobs                      SET invoiced_by_name           = v_name WHERE invoiced_by           = OLD.id;
  UPDATE public.jobs                      SET project_lead_id_name       = v_name WHERE project_lead_id       = OLD.id;
  UPDATE public.jobs                      SET rejected_by_name           = v_name WHERE rejected_by           = OLD.id;
  UPDATE public.jobs                      SET submitted_by_name          = v_name WHERE submitted_by          = OLD.id;
  UPDATE public.partner_form_template     SET draft_updated_by_name      = v_name WHERE draft_updated_by      = OLD.id;
  UPDATE public.partner_form_template     SET live_published_by_name     = v_name WHERE live_published_by     = OLD.id;
  UPDATE public.permission_audit_log      SET actor_profile_id_name      = v_name WHERE actor_profile_id      = OLD.id;
  UPDATE public.permission_audit_log      SET target_profile_id_name     = v_name WHERE target_profile_id     = OLD.id;
  UPDATE public.profiles                  SET team_lead_id_name          = v_name WHERE team_lead_id          = OLD.id;
  UPDATE public.project_appointment_notes SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.project_appointments      SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.project_audit             SET changed_by_name            = v_name WHERE changed_by            = OLD.id;
  UPDATE public.projects                  SET approved_by_name           = v_name WHERE approved_by           = OLD.id;
  UPDATE public.rental_requests           SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.service_reports           SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.ticket_attachments        SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;
  UPDATE public.tickets                   SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.tickets                   SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.tickets                   SET filed_by_name              = v_name WHERE filed_by              = OLD.id;
  UPDATE public.tickets                   SET resolved_by_name           = v_name WHERE resolved_by           = OLD.id;
  UPDATE public.time_entries              SET user_id_name               = v_name WHERE user_id               = OLD.id;
  UPDATE public.time_off                  SET approved_by_name           = v_name WHERE approved_by           = OLD.id;
  UPDATE public.todo_attachments          SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;
  UPDATE public.todos                     SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.todos                     SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.todos                     SET deleted_by_name            = v_name WHERE deleted_by            = OLD.id;
  UPDATE public.vertrieb_contacts         SET assigned_to_name           = v_name WHERE assigned_to           = OLD.id;
  UPDATE public.vertrieb_team_goal        SET created_by_name            = v_name WHERE created_by            = OLD.id;
  UPDATE public.wage_documents            SET uploaded_by_name           = v_name WHERE uploaded_by           = OLD.id;

  RETURN OLD;
END;
$function$;

-- Anträge (Vier Augen nach der Monatssperre) gibt es nur noch für Stempel.
create or replace function public.lohn_antrag_spalten(p_tabelle text)
 returns text[]
 language sql
 immutable
as $function$
  select case p_tabelle
    when 'time_entries' then array['user_id', 'clock_in', 'clock_out', 'lang_begruendung', 'job_id', 'project_id', 'rate_tier_id',
      'description', 'notes']
    end;
$function$;

create or replace function public.lohn_ignorierte_felder(p_tabelle text)
 returns text[]
 language sql
 immutable
as $function$
  select case p_tabelle
    when 'lohn_anstellungen' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name', 'notiz', 'vertragsart', 'befristet_bis', 'pensum_pct']
    when 'time_entries' then array['updated_at', 'created_at', 'notes', 'description', 'job_id', 'project_id', 'rate_tier_id',
      'user_id_name', 'entry_number', 'lang_begruendung', 'geprueft_at', 'geprueft_von', 'geprueft_von_name', 'ueberlappung_altfall']
    else array[]::text[] end;
$function$;

-- Ab welchem Tag betrifft eine Änderung abgerechnete Zeit? Nur noch Stempel und Anstellungen
-- (die Trigger lohn_sperre_pruefen hängen an time_entries und lohn_anstellungen).
create or replace function public.lohn_aenderung_betrifft_ab(p_tabelle text, p_op text, p_alt jsonb, p_neu jsonb)
 returns date
 language plpgsql
 immutable
as $function$
declare
  v_ign text[] := public.lohn_ignorierte_felder(p_tabelle);
  v_felder text[];
  v_von date;
  k text;
  v_a date;
  v_jahre_alt integer[];
  v_jahre_neu integer[];
  v_j integer;
begin
  if p_tabelle = 'time_entries' then
    if p_op = 'INSERT' then return public.lohn_lokaler_tag(p_neu ->> 'clock_in'); end if;
    if p_op = 'DELETE' then return public.lohn_lokaler_tag(p_alt ->> 'clock_in'); end if;
  elsif p_tabelle = 'lohn_anstellungen' then
    if p_op = 'INSERT' then return (p_neu ->> 'eintritt')::date; end if;
    if p_op = 'DELETE' then return (p_alt ->> 'eintritt')::date; end if;
  else
    return null;
  end if;

  select coalesce(array_agg(x), '{}') into v_felder
    from jsonb_object_keys(p_neu) x
   where p_neu -> x is distinct from p_alt -> x and not (x = any (v_ign));
  if coalesce(array_length(v_felder, 1), 0) = 0 then
    return null;
  end if;

  if p_tabelle = 'time_entries' then
    return least(public.lohn_lokaler_tag(p_alt ->> 'clock_in'), public.lohn_lokaler_tag(p_neu ->> 'clock_in'));
  end if;

  -- lohn_anstellungen
  foreach k in array v_felder loop
    v_a := null;
    if k = 'eintritt' or k = 'profile_id' then
      v_a := least((p_alt ->> 'eintritt')::date, (p_neu ->> 'eintritt')::date);
    elsif k = 'austritt' then
      v_a := least(coalesce((p_alt ->> 'austritt')::date, 'infinity'::date),
                   coalesce((p_neu ->> 'austritt')::date, 'infinity'::date));
      if v_a = 'infinity'::date then v_a := null; else v_a := v_a + 1; end if;
    elsif k in ('ruhend_von', 'ruhend_bis') then
      v_a := least(coalesce((p_alt ->> 'ruhend_von')::date, 'infinity'::date),
                   coalesce((p_neu ->> 'ruhend_von')::date, 'infinity'::date));
      if v_a = 'infinity'::date then v_a := null; end if;
    elsif k = 'ahv_verlangt_jahre' then
      select coalesce(array_agg(x::int), '{}') into v_jahre_alt from jsonb_array_elements_text(coalesce(p_alt -> 'ahv_verlangt_jahre', '[]')) x;
      select coalesce(array_agg(x::int), '{}') into v_jahre_neu from jsonb_array_elements_text(coalesce(p_neu -> 'ahv_verlangt_jahre', '[]')) x;
      select min(j) into v_j from (
        select unnest(v_jahre_alt) j except select unnest(v_jahre_neu)
        union
        select unnest(v_jahre_neu) except select unnest(v_jahre_alt)) d;
      if v_j is not null then v_a := make_date(v_j - 1, 12, 1); end if;
    else
      v_a := (p_alt ->> 'eintritt')::date;
    end if;
    if v_a is not null and (v_von is null or v_a < v_von) then v_von := v_a; end if;
  end loop;
  return v_von;
end;
$function$;

create or replace function public.lohn_tag_gesperrt(p_tabelle text, p_tag date)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select public.is_time_entry_locked((p_tag + time '12:00') at time zone 'Europe/Zurich')
      or (p_tabelle <> 'time_entries' and exists (
           select 1 from public.lohn_momentaufnahmen m
            where make_date(m.jahr, m.monat, 1) + interval '1 month' > p_tag));
$function$;

-- 2. Anträge nur noch für Stempel -------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.lohn_aenderungs_antraege where bereich <> 'stempel') then
    raise exception '389: es gibt Anträge anderer Bereiche als «stempel» — Migration abgebrochen, bitte prüfen';
  end if;
end $$;
alter table public.lohn_aenderungs_antraege drop constraint if exists lohn_aenderungs_antraege_bereich_check;
alter table public.lohn_aenderungs_antraege add constraint lohn_aenderungs_antraege_bereich_check check (bereich = 'stempel');

-- 3. Tabellen der Lohnrechnung (Reihenfolge wegen Fremdschlüsseln) ------------------------------
drop table if exists public.lohn_korrektur_vorschlaege;
drop table if exists public.lohn_auszahlungen;
drop table if exists public.lohn_zusatzposten;
drop table if exists public.lohn_lauf;
drop table if exists public.payroll_defaults;
drop table if exists public.employee_compensation;

-- 4. Funktionen ohne Aufrufer ----------------------------------------------------------------
drop function if exists public.get_monthly_payroll_stats(date);
drop function if exists public.get_location_stats(date, date, text);
drop function if exists public.get_current_bvg_threshold(date);
drop function if exists public.lohn_lauf_starten(text);
drop function if exists public.lohn_zusatzposten_lauf_bis();
drop function if exists public.payroll_defaults_touch_updated_at();
drop function if exists public.lohn_schutz_firmensaetze();
drop function if exists public.lohn_schutz_lohnzeile();
drop function if exists public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid);
drop function if exists public.lohn_dokument_archivieren(uuid, uuid, text, text);
drop function if exists public.lohn_dokument_wiederherstellen(uuid, uuid, text, text);
drop function if exists public.get_my_wage_consent();

commit;
