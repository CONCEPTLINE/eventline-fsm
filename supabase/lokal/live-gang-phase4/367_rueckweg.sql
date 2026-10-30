-- Rückweg Migration 367 (Lohn-Umbau Phase 4, Teil 1) — nur wenn 367 selbst stört.
--
-- Vorher IMMER zuerst 368_rueckweg.sql (falls 368 eingespielt ist).
-- Der Phase-2-Code (heute live) läuft auch MIT 367; ein Code-Rückweg (Vercel
-- «Promote») braucht diesen Rückweg also nicht. Er entfernt die neuen Trigger
-- auf time_entries (Sperre/Protokoll/Feldschutz) und stellt die Funktionen aus
-- 364 (bzw. lohn_schutz_stempel aus 360) Wort für Wort wieder her.
-- Tabellen, Spalten und Daten BLEIBEN (Zusatzposten, Auszahlungen, Zustellung,
-- time_entries-Spalten, lauf_bis) — nichts wird gelöscht. Die erweiterten
-- Prüfregeln (Antrags-Bereiche, Lauf-Status «blockiert») bleiben, weil es
-- Zeilen mit den neuen Werten geben kann. Erneutes Einspielen von 367 stellt
-- alles wieder her (idempotent, lokal geprüft).

drop trigger if exists time_entries_lohn_felder on public.time_entries;
drop trigger if exists time_entries_lohn_sperre on public.time_entries;
drop trigger if exists time_entries_lohn_protokoll on public.time_entries;
drop trigger if exists lohn_zusatzposten_lohn_sperre on public.lohn_zusatzposten;
drop trigger if exists lohn_zusatzposten_lohn_protokoll on public.lohn_zusatzposten;
drop trigger if exists lohn_zusatzposten_lauf_bis on public.lohn_zusatzposten;
drop trigger if exists lohn_dokument_zustellung_fassung on public.lohn_dokument_zustellung;

-- lohn_ignorierte_felder wie Migration 364
create or replace function public.lohn_ignorierte_felder(p_tabelle text)
returns text[]
language sql
immutable
as $$
  select case p_tabelle
    when 'employee_compensation' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'notes', 'auto_lohnabrechnung']
    when 'payroll_defaults' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'notes']
    when 'lohn_anstellungen' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name', 'notiz', 'vertragsart', 'befristet_bis', 'pensum_pct']
    else array[]::text[] end;
$$;

-- lohn_aenderung_betrifft_ab wie Migration 364
create or replace function public.lohn_aenderung_betrifft_ab(p_tabelle text, p_op text, p_alt jsonb, p_neu jsonb)
returns date
language plpgsql
immutable
as $$
declare
  v_ign text[] := public.lohn_ignorierte_felder(p_tabelle);
  v_felder text[];
  v_von date;
  k text;
  v_a date;
  v_b date;
  v_jahre_alt integer[];
  v_jahre_neu integer[];
  v_j integer;
begin
  if p_op = 'INSERT' then
    return case p_tabelle when 'lohn_anstellungen' then (p_neu ->> 'eintritt')::date else (p_neu ->> 'effective_from')::date end;
  elsif p_op = 'DELETE' then
    return case p_tabelle when 'lohn_anstellungen' then (p_alt ->> 'eintritt')::date else (p_alt ->> 'effective_from')::date end;
  end if;

  select coalesce(array_agg(x), '{}') into v_felder
    from jsonb_object_keys(p_neu) x
   where p_neu -> x is distinct from p_alt -> x and not (x = any (v_ign));
  if coalesce(array_length(v_felder, 1), 0) = 0 then
    return null;
  end if;

  foreach k in array v_felder loop
    v_a := null;
    if p_tabelle in ('employee_compensation', 'payroll_defaults') then
      if k = 'effective_to' then
        -- Nur das Ende verschoben: betroffen ab dem früheren Ende + 1 Tag.
        v_a := least(coalesce((p_alt ->> 'effective_to')::date, 'infinity'::date),
                     coalesce((p_neu ->> 'effective_to')::date, 'infinity'::date));
        if v_a = 'infinity'::date then v_a := null; else v_a := v_a + 1; end if;
      else
        v_a := least((p_alt ->> 'effective_from')::date, (p_neu ->> 'effective_from')::date);
      end if;
    elsif p_tabelle = 'lohn_anstellungen' then
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
        -- Auszahlungsjahr J betrifft die Lohnmonate ab Dezember J-1.
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
    end if;
    if v_a is not null and (v_von is null or v_a < v_von) then v_von := v_a; end if;
  end loop;
  return v_von;
end;
$$;

-- lohn_tag_gesperrt wie Migration 364
create or replace function public.lohn_tag_gesperrt(p_tabelle text, p_tag date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_time_entry_locked((p_tag + time '12:00') at time zone 'Europe/Zurich')
      or exists (
           select 1 from public.lohn_momentaufnahmen m
            where (p_tabelle = 'payroll_defaults' and m.auszahlungsdatum >= p_tag)
               or (p_tabelle <> 'payroll_defaults' and make_date(m.jahr, m.monat, 1) + interval '1 month' > p_tag));
$$;

-- lohn_aenderung_protokollieren wie Migration 364
create or replace function public.lohn_aenderung_protokollieren()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alt jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_neu jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_felder text[];
  v_akteur uuid := public.lohn_akteur();
  v_name text;
  v_quelle text;
  v_antrag uuid := nullif(current_setting('lohn.antrag_id', true), '')::uuid;
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}') into v_felder
      from jsonb_object_keys(v_neu) k
     where v_neu -> k is distinct from v_alt -> k and k <> 'updated_at';
    if coalesce(array_length(v_felder, 1), 0) = 0 then
      return new;
    end if;
  end if;
  if v_akteur is not null then
    select full_name into v_name from public.profiles where id = v_akteur;
  end if;
  v_quelle := case
    when coalesce(current_setting('lohn.aenderung_antrag', true), '') = 'an' then 'antrag'
    when coalesce(current_setting('lohn.notweg', true), '') = 'an' then 'notweg'
    when v_akteur is not null then 'app'
    else 'sql' end;
  insert into public.lohn_aenderungen (tabelle, datensatz_id, profile_id, aktion, felder, alt, neu,
                                       akteur_id, akteur_name, quelle, antrag_id, grund)
  values (
    tg_table_name,
    coalesce((v_neu ->> 'id'), (v_alt ->> 'id'))::uuid,
    nullif(coalesce(v_neu ->> 'profile_id', v_alt ->> 'profile_id'), '')::uuid,
    case tg_op when 'INSERT' then 'angelegt' when 'UPDATE' then 'geaendert' else 'geloescht' end,
    coalesce(v_felder, '{}'),
    v_alt, v_neu, v_akteur,
    coalesce(v_name, nullif(current_setting('lohn.akteur_name', true), '')),
    v_quelle, v_antrag,
    nullif(current_setting('lohn.grund', true), ''));
  return coalesce(new, old);
end;
$$;

-- lohn_antrag_spalten wie Migration 364
create or replace function public.lohn_antrag_spalten(p_tabelle text)
returns text[]
language sql
immutable
as $$
  select case p_tabelle
    when 'employee_compensation' then array['profile_id', 'hourly_wage_chf', 'effective_from', 'effective_to', 'notes',
      'ahv_iv_eo_pct', 'alv_pct', 'nbu_pct', 'bvg_pct', 'ktg_pct', 'quellensteuer_pct',
      'employer_ahv_pct', 'employer_alv_pct', 'employer_fak_pct', 'employer_bu_pct', 'employer_bvg_pct', 'employer_verwaltung_pct',
      'uses_standard_lohn', 'ferienanteil_pct_override', 'wage_exempt', 'auto_lohnabrechnung', 'created_by', 'created_by_name']
    when 'payroll_defaults' then array['effective_from', 'default_ahv_iv_eo_pct', 'default_alv_pct', 'default_nbu_pct', 'default_bvg_pct',
      'default_ktg_pct', 'default_quellensteuer_pct', 'default_employer_ahv_pct', 'default_employer_alv_pct', 'default_employer_fak_pct',
      'default_employer_bu_pct', 'default_employer_bvg_pct', 'default_employer_verwaltung_pct', 'bvg_threshold_chf', 'notes',
      'created_by', 'created_by_name']
    when 'lohn_anstellungen' then array['profile_id', 'eintritt', 'austritt', 'ruhend_von', 'ruhend_bis', 'vertragsart', 'befristet_bis',
      'pensum_pct', 'ahv_verlangt_jahre', 'notiz', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name']
    end;
$$;

-- lohn_momentaufnahme_speichern wie Migration 364
create or replace function public.lohn_momentaufnahme_speichern(
  p_profile_id uuid,
  p_jahr integer,
  p_monat integer,
  p_art text,
  p_storage_path text,
  p_file_size bigint,
  p_pdf_sha256 text,
  p_actor uuid,
  p_actor_name text,
  p_nur_wenn_keine_gueltige boolean,
  p_auszahlungsdatum date,
  p_geschaetzt boolean,
  p_kern_version text,
  p_eingaben jsonb,
  p_ergebnis jsonb,
  p_pruefsumme text,
  p_werte jsonb,             -- {brutto, total_abzuege, netto, ahv_lohn, alv_lohn, uvg_lohn, uvg_art, quellensteuer}
  p_begruendung text default null,
  p_wage_document_id uuid default null   -- nur Altbestand: bestehende PDF-Zeile
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vor public.lohn_momentaufnahmen%rowtype;
  v_fassung integer;
  v_doc jsonb;
  v_doc_id uuid;
  v_pfad text;
  v_auszahlung numeric(12,2);
  v_id uuid;
  v_netto numeric(12,2) := (p_werte ->> 'netto')::numeric;
begin
  if p_art not in ('regulaer', 'korrektur', 'altbestand') then
    raise exception 'lohn_momentaufnahme_speichern: Art ungültig';
  end if;
  if coalesce(p_pruefsumme, '') = '' or p_ergebnis is null then
    raise exception 'lohn_momentaufnahme_speichern: Ergebnis/Prüfsumme fehlt';
  end if;
  -- Gleiche Sperre wie lohn_fassung_speichern (dieselbe Person/Periode nacheinander).
  perform pg_advisory_xact_lock(hashtextextended(
    'lohn_fassung|' || p_profile_id::text || '|lohnabrechnung|' || p_jahr || '|' || p_monat, 0));

  select * into v_vor from public.lohn_momentaufnahmen
   where profile_id = p_profile_id and jahr = p_jahr and monat = p_monat
   order by fassung desc limit 1;

  if p_art = 'altbestand' then
    if p_wage_document_id is null then raise exception 'Altbestand: PDF-Zeile fehlt'; end if;
    if exists (select 1 from public.lohn_momentaufnahmen where wage_document_id = p_wage_document_id and pdf_sha256 = p_pdf_sha256) then
      return jsonb_build_object('modus', 'vorhanden');
    end if;
    if v_vor.id is not null then
      raise exception 'Altbestand: für % % gibt es schon eine Momentaufnahme', p_jahr, p_monat;
    end if;
    if not exists (select 1 from public.wage_documents w where w.id = p_wage_document_id and w.profile_id = p_profile_id
                     and w.doc_type = 'lohnabrechnung' and w.year = p_jahr and w.period_month = p_monat) then
      raise exception 'Altbestand: PDF-Zeile passt nicht zu Person/Monat';
    end if;
    v_doc_id := p_wage_document_id;
    v_pfad := p_storage_path;
    v_auszahlung := v_netto;
  else
    if p_art = 'regulaer' then
      if v_vor.id is not null then
        raise exception 'Für %/% gibt es schon eine Fassung — nur eine Korrekturfassung ist möglich', p_monat, p_jahr;
      end if;
      -- Altes PDF ohne Momentaufnahme: erst übernehmen (scripts/lohn-altbestand.mjs),
      -- sonst würde der Monat doppelt ausbezahlt.
      if exists (select 1 from public.wage_documents w where w.profile_id = p_profile_id and w.doc_type = 'lohnabrechnung'
                   and w.year = p_jahr and w.period_month = p_monat and w.archived_at is null and w.superseded_at is null) then
        if p_nur_wenn_keine_gueltige then
          return jsonb_build_object('modus', 'vorhanden');
        end if;
        raise exception 'Für %/% liegt eine Lohnabrechnung ohne Momentaufnahme vor — zuerst den Altbestand übernehmen', p_monat, p_jahr;
      end if;
      v_auszahlung := v_netto;
    else
      if v_vor.id is null then
        raise exception 'Korrekturfassung: keine Vorfassung für %/%', p_monat, p_jahr;
      end if;
      if coalesce(trim(p_begruendung), '') = '' then
        raise exception 'Korrekturfassung: Begründung fehlt';
      end if;
      v_auszahlung := v_netto - v_vor.netto;
    end if;
    v_doc := public.lohn_fassung_speichern(
      p_profile_id, 'lohnabrechnung', p_jahr, p_monat, p_storage_path, p_file_size, 'auto',
      p_actor, p_actor_name, p_begruendung, p_nur_wenn_keine_gueltige and p_art = 'regulaer',
      jsonb_build_object('momentaufnahme', true, 'art', p_art, 'pruefsumme', p_pruefsumme));
    if v_doc ->> 'modus' = 'vorhanden' then
      return v_doc;
    end if;
    v_doc_id := (v_doc ->> 'id')::uuid;
    v_pfad := p_storage_path;
  end if;

  v_fassung := coalesce(v_vor.fassung, 0) + 1;
  insert into public.lohn_momentaufnahmen (
    profile_id, jahr, monat, fassung, art, wage_document_id, storage_path, pdf_sha256,
    auszahlungsdatum, auszahlungsdatum_geschaetzt, kern_version, eingaben, ergebnis, pruefsumme,
    brutto, total_abzuege, netto, ahv_lohn, alv_lohn, uvg_lohn, uvg_art, quellensteuer,
    auszahlung, vorfassung_id, begruendung, erstellt_von, erstellt_von_name)
  values (
    p_profile_id, p_jahr, p_monat, v_fassung, p_art, v_doc_id, v_pfad, p_pdf_sha256,
    p_auszahlungsdatum, coalesce(p_geschaetzt, false), p_kern_version, p_eingaben, p_ergebnis, p_pruefsumme,
    (p_werte ->> 'brutto')::numeric, (p_werte ->> 'total_abzuege')::numeric, v_netto,
    (p_werte ->> 'ahv_lohn')::numeric, (p_werte ->> 'alv_lohn')::numeric, (p_werte ->> 'uvg_lohn')::numeric,
    p_werte ->> 'uvg_art', coalesce((p_werte ->> 'quellensteuer')::numeric, 0),
    v_auszahlung, v_vor.id, nullif(trim(coalesce(p_begruendung, '')), ''), p_actor, p_actor_name)
  returning id into v_id;

  return coalesce(v_doc, '{}'::jsonb) || jsonb_build_object(
    'modus', coalesce(v_doc ->> 'modus', 'altbestand'),
    'momentaufnahme_id', v_id, 'fassung', v_fassung, 'auszahlung', v_auszahlung, 'wage_document_id', v_doc_id);
end;
$$;

-- lohn_schutz_stempel wie Migration 360
create or replace function public.lohn_schutz_stempel()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      raise exception 'time_entries: Stempel werden nie über eine Kaskade gelöscht (Lohngrundlage)' using errcode = 'P0001';
    end if;
    if public.is_time_entry_locked(old.clock_in) then
      raise exception 'time_entries: Stempel in abgerechneten Monaten sind nicht löschbar' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.user_id is not null and new.user_id is null then
    raise exception 'time_entries: Stempel dürfen ihre Person nicht verlieren (Lohngrundlage)' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid) to service_role;
revoke all on function public.lohn_tag_gesperrt(text, date) from public, anon, authenticated;
grant execute on function public.lohn_tag_gesperrt(text, date) to service_role;

-- Neue Hilfsfunktionen ohne Trigger mehr
drop function if exists public.time_entries_lohn_felder();
drop function if exists public.lohn_zusatzposten_lauf_bis();
drop function if exists public.lohn_dokument_zustellung_fassung();
