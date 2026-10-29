-- 367: Lohn-Umbau Phase 4 «Stempel und Monatsabschluss» — Teil 1 (additiv, idempotent).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026: 364 auf main, 365/366 auf
-- !! origin/vertrieb-kampagnen).
--
-- Reihenfolge Live: supabase/lokal/live-gang-phase4/LIVE-GANG.md
--   (Wartung «lohn» an → Sicherung → DIESE Migration → Code → 368 (Stempel-
--    Regeln, erst NACH dem Code mit den Klartext-Meldungen) → Wartung aus).
--
-- Inhalt (nichts davon weist normale Stempel ab — das macht erst 368):
--   1. time_entries: Begründung langer Stempel, «geprüft» (Lohnverwaltung),
--      Markierung Altfall Überlappung; Schutz dieser Felder vor dem Browser
--   2. Sperre auch für den Server: Stempel abgerechneter Monate nur per
--      Antrag (lohn_aenderungs_antraege, Bereich «stempel»), Protokoll bei
--      Antrag/Notweg; Löschen gesperrter Stempel nur per Antrag
--   3. lohn_zusatzposten: einmalige Lohnposten je Person und Monat
--      (Lohn / Rückerstattung eines Abzugs / Spesen); Sperre + Protokoll
--   4. lohn_momentaufnahmen.auszahlungsbetrag (Netto + Spesen), Speichern
--      rechnet die Auszahlung damit
--   5. lohn_auszahlungen: «ausbezahlt» von Hand (mit Datum, Storno statt Löschen)
--   6. lohn_lauf: Zähler «blockiert», Alarm-Protokoll
--   7. Zustellung: Wahl digital/Papier mit Historie, Zustellnachweis je Dokument
--   8. stempel_ueberlappung(): erste Überschneidung (für Klartext-Meldungen)
--   0. lohn_einstellungen.lauf_bis: letzter Lohnmonat des ERP (Entscheid Mischa
--      30.10.2026: ab Lohnmonat Dezember 2026 rechnet Trust flow/Bexio) — danach
--      keine Lohnabrechnung/Korrektur (lohn_momentaufnahme_speichern) und keine
--      Zusatzposten mehr, auch nicht per Antrag oder Notweg
--
-- Rückweg: supabase/lokal/live-gang-phase4/367_rueckweg.sql (Trigger und neue
-- Funktionen weg, Funktionen aus 364 wiederhergestellt; Tabellen/Spalten bleiben).

-- ===========================================================================
-- 0. Letzter Lohnmonat des ERP (lauf_bis)
-- ===========================================================================
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'lohn_einstellungen' and column_name = 'lauf_bis') then
    alter table public.lohn_einstellungen add column lauf_bis date;
    -- Einmalig beim Anlegen: November 2026 ist der letzte ERP-Lohnmonat.
    update public.lohn_einstellungen set lauf_bis = '2026-11-01' where id = 'default';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lohn_einstellungen_lauf_bis_check') then
    alter table public.lohn_einstellungen add constraint lohn_einstellungen_lauf_bis_check
      check (lauf_bis is null or (extract(day from lauf_bis) = 1 and lauf_bis >= lauf_ab));
  end if;
end $$;
comment on column public.lohn_einstellungen.lauf_bis is
  'Letzter Lohnmonat (1. des Monats), den das ERP abrechnet; danach Trust flow/Bexio. null = kein Ende. Stunden/Stempel/Prognosen laufen weiter.';

-- Klartext, wenn ein Lohnmonat nach lauf_bis liegt (sonst null). Gleicher
-- Wortlaut wie src/lib/lohn/zugriff.ts (meldungNachLaufBis).
create or replace function public.lohn_nach_lauf_bis(p_jahr integer, p_monat integer)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'Ab ' || (array['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'])
           [extract(month from (e.lauf_bis + interval '1 month'))::int]
         || ' ' || extract(year from (e.lauf_bis + interval '1 month'))::int
         || ' läuft der Lohn über Trust flow/Bexio — im ERP keine Lohnabrechnung, Korrektur oder Zusatzposten mehr für diesen Monat.'
    from public.lohn_einstellungen e
   where e.id = 'default' and e.lauf_bis is not null and make_date(p_jahr, p_monat, 1) > e.lauf_bis;
$$;
revoke all on function public.lohn_nach_lauf_bis(integer, integer) from public, anon, authenticated;
grant execute on function public.lohn_nach_lauf_bis(integer, integer) to service_role;

-- Sperre je Tabelle (wie 364); Stempel nur nach der Monatssperre am 5.
-- (keine Momentaufnahme irgendeiner Person darf das Stempeln aller sperren).
create or replace function public.lohn_tag_gesperrt(p_tabelle text, p_tag date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_time_entry_locked((p_tag + time '12:00') at time zone 'Europe/Zurich')
      or (p_tabelle <> 'time_entries' and exists (
           select 1 from public.lohn_momentaufnahmen m
            where (p_tabelle = 'payroll_defaults' and m.auszahlungsdatum >= p_tag)
               or (p_tabelle <> 'payroll_defaults' and make_date(m.jahr, m.monat, 1) + interval '1 month' > p_tag)));
$$;
revoke all on function public.lohn_tag_gesperrt(text, date) from public, anon, authenticated;
grant execute on function public.lohn_tag_gesperrt(text, date) to service_role;

-- ===========================================================================
-- 1. time_entries: neue Felder
-- ===========================================================================
alter table public.time_entries add column if not exists lang_begruendung text;
alter table public.time_entries add column if not exists geprueft_at timestamptz;
alter table public.time_entries add column if not exists geprueft_von uuid;
alter table public.time_entries add column if not exists geprueft_von_name text;
alter table public.time_entries add column if not exists ueberlappung_altfall boolean not null default false;

comment on column public.time_entries.lang_begruendung is
  'Begründung bei Stempeln über 16 Stunden (Pflicht ab Migration 368, beim Ausstempeln mit Endzeit).';
comment on column public.time_entries.geprueft_at is
  'Lohnverwaltung hat den (langen) Stempel geprüft und als korrekt bestätigt — er blockiert den Lohnlauf nicht mehr. Ändert sich Beginn/Ende, fällt die Prüfung weg.';
comment on column public.time_entries.ueberlappung_altfall is
  'Altfall: überlappte schon vor der Regel 368 einen anderen Stempel derselben Person; von der Regel ausgenommen, nie gelöscht. Ändert sich Beginn/Ende, fällt die Ausnahme weg.';

-- Felder der Lohnverwaltung: nur der Server (service_role) bzw. die Datenbank
-- setzt sie. Ändert sich Beginn/Ende, fallen «geprüft» und «Altfall» weg.
create or replace function public.time_entries_lohn_felder()
returns trigger
language plpgsql
as $$
declare
  v_server boolean := current_user in ('service_role', 'postgres', 'supabase_admin');
begin
  if not v_server then
    if tg_op = 'INSERT' then
      if new.geprueft_at is not null or new.geprueft_von is not null or new.geprueft_von_name is not null or new.ueberlappung_altfall then
        raise exception 'time_entries: «geprüft» und «Altfall» setzt nur die Lohnverwaltung' using errcode = 'P0001';
      end if;
    elsif new.geprueft_at is distinct from old.geprueft_at
       or new.geprueft_von is distinct from old.geprueft_von
       or new.geprueft_von_name is distinct from old.geprueft_von_name
       or new.ueberlappung_altfall is distinct from old.ueberlappung_altfall then
      raise exception 'time_entries: «geprüft» und «Altfall» setzt nur die Lohnverwaltung' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.clock_in is distinct from old.clock_in or new.clock_out is distinct from old.clock_out) then
    -- Prüfung gilt nur für den geprüften Stand.
    if new.geprueft_at is not distinct from old.geprueft_at then
      new.geprueft_at := null;
      new.geprueft_von := null;
      new.geprueft_von_name := null;
    end if;
    if old.ueberlappung_altfall and new.ueberlappung_altfall is not distinct from old.ueberlappung_altfall then
      new.ueberlappung_altfall := false;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists time_entries_lohn_felder on public.time_entries;
create trigger time_entries_lohn_felder
  before insert or update on public.time_entries
  for each row execute function public.time_entries_lohn_felder();

-- ===========================================================================
-- 2. Sperre und Protokoll für Stempel und Zusatzposten
-- ===========================================================================

-- Ignorierte Felder je Tabelle (kein Einfluss auf den Lohn). Neu: Stempel,
-- Zusatzposten. Bei Stempeln zählen nur Person, Beginn und Ende.
create or replace function public.lohn_ignorierte_felder(p_tabelle text)
returns text[]
language sql
immutable
as $$
  select case p_tabelle
    when 'employee_compensation' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'notes', 'auto_lohnabrechnung']
    when 'payroll_defaults' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'notes']
    when 'lohn_anstellungen' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name', 'notiz', 'vertragsart', 'befristet_bis', 'pensum_pct']
    when 'time_entries' then array['updated_at', 'created_at', 'notes', 'description', 'job_id', 'project_id', 'rate_tier_id',
      'user_id_name', 'entry_number', 'lang_begruendung', 'geprueft_at', 'geprueft_von', 'geprueft_von_name', 'ueberlappung_altfall']
    when 'lohn_zusatzposten' then array['updated_at', 'created_at', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name']
    else array[]::text[] end;
$$;

-- Lokaler Kalendertag (Zürich) eines Zeitpunkts aus JSON.
create or replace function public.lohn_lokaler_tag(p_zeitpunkt text)
returns date
language sql
immutable
as $$
  select case when p_zeitpunkt is null then null else ((p_zeitpunkt::timestamptz) at time zone 'Europe/Zurich')::date end;
$$;

-- Frühester Kalendertag, dessen Lohn die Änderung berührt (null = kein Einfluss).
-- Wie 364, ergänzt um time_entries (Tag des Beginns, alt und neu) und
-- lohn_zusatzposten (Erster des Lohnmonats, alt und neu).
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
  v_jahre_alt integer[];
  v_jahre_neu integer[];
  v_j integer;
begin
  if p_tabelle = 'time_entries' then
    if p_op = 'INSERT' then return public.lohn_lokaler_tag(p_neu ->> 'clock_in'); end if;
    if p_op = 'DELETE' then return public.lohn_lokaler_tag(p_alt ->> 'clock_in'); end if;
  elsif p_tabelle = 'lohn_zusatzposten' then
    if p_op = 'INSERT' then return make_date((p_neu ->> 'jahr')::int, (p_neu ->> 'monat')::int, 1); end if;
    if p_op = 'DELETE' then return make_date((p_alt ->> 'jahr')::int, (p_alt ->> 'monat')::int, 1); end if;
  elsif p_op = 'INSERT' then
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

  if p_tabelle = 'time_entries' then
    return least(public.lohn_lokaler_tag(p_alt ->> 'clock_in'), public.lohn_lokaler_tag(p_neu ->> 'clock_in'));
  elsif p_tabelle = 'lohn_zusatzposten' then
    return least(make_date((p_alt ->> 'jahr')::int, (p_alt ->> 'monat')::int, 1),
                 make_date((p_neu ->> 'jahr')::int, (p_neu ->> 'monat')::int, 1));
  end if;

  foreach k in array v_felder loop
    v_a := null;
    if p_tabelle in ('employee_compensation', 'payroll_defaults') then
      if k = 'effective_to' then
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

-- Wer ändert? Protokoll wie 364; profile_id fällt bei Stempeln auf user_id zurück.
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
    nullif(coalesce(v_neu ->> 'profile_id', v_alt ->> 'profile_id', v_neu ->> 'user_id', v_alt ->> 'user_id'), '')::uuid,
    case tg_op when 'INSERT' then 'angelegt' when 'UPDATE' then 'geaendert' else 'geloescht' end,
    coalesce(v_felder, '{}'),
    v_alt, v_neu, v_akteur,
    coalesce(v_name, nullif(current_setting('lohn.akteur_name', true), '')),
    v_quelle, v_antrag,
    nullif(current_setting('lohn.grund', true), ''));
  return coalesce(new, old);
end;
$$;

-- Stempel: Sperre für ALLE (auch den Server); der Browser scheitert schon an
-- RLS (Migration 214). Protokoll nur bei Antrag/Notweg (sonst wäre jedes
-- Ein-/Ausstempeln eine Zeile).
drop trigger if exists time_entries_lohn_sperre on public.time_entries;
create trigger time_entries_lohn_sperre
  before insert or update or delete on public.time_entries
  for each row execute function public.lohn_sperre_pruefen();
drop trigger if exists time_entries_lohn_protokoll on public.time_entries;
create trigger time_entries_lohn_protokoll
  after insert or update or delete on public.time_entries
  for each row
  when (coalesce(current_setting('lohn.aenderung_antrag', true), '') = 'an'
        or coalesce(current_setting('lohn.notweg', true), '') = 'an')
  execute function public.lohn_aenderung_protokollieren();

-- Löschen gesperrter Stempel: nur per bestätigtem Antrag bzw. Notweg (das
-- Protokoll behält die alte Zeile). Nie über eine Kaskade.
create or replace function public.lohn_schutz_stempel()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      raise exception 'time_entries: Stempel werden nie über eine Kaskade gelöscht (Lohngrundlage)' using errcode = 'P0001';
    end if;
    if public.is_time_entry_locked(old.clock_in)
       and coalesce(current_setting('lohn.aenderung_antrag', true), '') <> 'an'
       and coalesce(current_setting('lohn.notweg', true), '') <> 'an' then
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

-- ===========================================================================
-- 3. Zusatzposten (einmalig je Person und Lohnmonat)
-- ===========================================================================
create table if not exists public.lohn_zusatzposten (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  jahr integer not null check (jahr between 2020 and 2100),
  monat integer not null check (monat between 1 and 12),
  -- lohn: Lohnposten im Brutto (z. B. Übernahme Quellensteuer durch die Firma)
  -- rueckerstattung: Rückerstattung eines Abzugs (z. B. AHV/ALV unter CHF 2'500)
  -- spesen: effektive Spesen, nach dem Netto ausbezahlt (Lohnausweis Ziff. 13)
  art text not null default 'lohn',
  bezeichnung text not null,
  -- CHF in 5-Rappen-Schritten (eine Rundungsregel, Kern); negativ = Abzug/Rückforderung
  betrag numeric(12,2) not null,
  ahv_pflichtig boolean not null default true,
  steuerbar boolean not null default true,
  abzug_art text,
  begruendung text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text,
  constraint lohn_zusatzposten_art_check check (art in ('lohn', 'rueckerstattung', 'spesen')),
  constraint lohn_zusatzposten_bezeichnung_check check (length(trim(bezeichnung)) between 3 and 80),
  constraint lohn_zusatzposten_begruendung_check check (length(trim(begruendung)) >= 10),
  constraint lohn_zusatzposten_betrag_check check (betrag <> 0 and betrag * 20 = round(betrag * 20)),
  constraint lohn_zusatzposten_flags_check check (art = 'lohn' or (not ahv_pflichtig and not steuerbar)),
  constraint lohn_zusatzposten_abzug_check check (
    (art = 'rueckerstattung') = (abzug_art is not null)
    and (abzug_art is null or abzug_art in ('ahv_iv_eo', 'alv', 'nbu', 'bvg', 'ktg', 'quellensteuer')))
);
create index if not exists lohn_zusatzposten_periode_idx on public.lohn_zusatzposten (profile_id, jahr, monat);
alter table public.lohn_zusatzposten enable row level security;
revoke all on public.lohn_zusatzposten from public, anon, authenticated;
grant select, insert, update, delete on public.lohn_zusatzposten to service_role;
comment on table public.lohn_zusatzposten is
  'Einmalige Lohnposten je Person und Lohnmonat (Phase 4). Der Rechenkern rechnet sie in Brutto/Abzüge/Auszahlung; nach der Monatssperre nur per Antrag (Bereich «zusatzposten»).';

drop trigger if exists lohn_zusatzposten_updated_at on public.lohn_zusatzposten;
create trigger lohn_zusatzposten_updated_at
  before update on public.lohn_zusatzposten
  for each row execute function public.update_updated_at();
drop trigger if exists lohn_zusatzposten_lohn_sperre on public.lohn_zusatzposten;
create trigger lohn_zusatzposten_lohn_sperre
  before insert or update or delete on public.lohn_zusatzposten
  for each row execute function public.lohn_sperre_pruefen();
drop trigger if exists lohn_zusatzposten_lohn_protokoll on public.lohn_zusatzposten;
create trigger lohn_zusatzposten_lohn_protokoll
  after insert or update or delete on public.lohn_zusatzposten
  for each row execute function public.lohn_aenderung_protokollieren();

-- Nach dem letzten ERP-Lohnmonat keine Zusatzposten (auch nicht per Antrag/Notweg).
create or replace function public.lohn_zusatzposten_lauf_bis()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := public.lohn_nach_lauf_bis(new.jahr, new.monat);
begin
  if v is not null then
    raise exception 'lohn_zusatzposten: %', v using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.lohn_zusatzposten_lauf_bis() from public, anon, authenticated;
drop trigger if exists lohn_zusatzposten_lauf_bis on public.lohn_zusatzposten;
create trigger lohn_zusatzposten_lauf_bis
  before insert or update on public.lohn_zusatzposten
  for each row execute function public.lohn_zusatzposten_lauf_bis();

-- ===========================================================================
-- 4. Anträge: neue Bereiche und Spalten
-- ===========================================================================
alter table public.lohn_aenderungs_antraege drop constraint if exists lohn_aenderungs_antraege_bereich_check;
alter table public.lohn_aenderungs_antraege add constraint lohn_aenderungs_antraege_bereich_check
  check (bereich in ('lohnzeile', 'firmensaetze', 'anstellung', 'stempel', 'zusatzposten'));

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
    when 'time_entries' then array['user_id', 'clock_in', 'clock_out', 'lang_begruendung', 'job_id', 'project_id', 'rate_tier_id',
      'description', 'notes']
    when 'lohn_zusatzposten' then array['profile_id', 'jahr', 'monat', 'art', 'bezeichnung', 'betrag', 'ahv_pflichtig', 'steuerbar',
      'abzug_art', 'begruendung', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name']
    end;
$$;

-- ===========================================================================
-- 5. Momentaufnahmen: Auszahlungsbetrag (Netto + Spesen)
-- ===========================================================================
alter table public.lohn_momentaufnahmen add column if not exists auszahlungsbetrag numeric(12,2);
comment on column public.lohn_momentaufnahmen.auszahlungsbetrag is
  'Ausbezahlter Betrag der ganzen Fassung = Netto + Spesen-Zusatzposten (null bei Fassungen vor Phase 4 = Netto). «auszahlung» bleibt der an diesem Tag ausbezahlte Betrag (Korrektur = Differenz).';

create or replace view public.lohn_fassungen_gueltig
with (security_invoker = true) as
select distinct on (m.profile_id, m.jahr, m.monat) m.*
  from public.lohn_momentaufnahmen m
  left join public.wage_documents w on w.id = m.wage_document_id
 where w.id is null or w.archived_at is null
 order by m.profile_id, m.jahr, m.monat, m.fassung desc;
revoke all on public.lohn_fassungen_gueltig from public, anon, authenticated;
grant select on public.lohn_fassungen_gueltig to service_role;

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
  p_werte jsonb,             -- {brutto, total_abzuege, netto, auszahlungsbetrag?, ahv_lohn, alv_lohn, uvg_lohn, uvg_art, quellensteuer}
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
  -- Phase 4: ausbezahlt wird Netto + Spesen (ohne Angabe = Netto).
  v_betrag numeric(12,2) := coalesce((p_werte ->> 'auszahlungsbetrag')::numeric, (p_werte ->> 'netto')::numeric);
begin
  if p_art not in ('regulaer', 'korrektur', 'altbestand') then
    raise exception 'lohn_momentaufnahme_speichern: Art ungültig';
  end if;
  -- Nach dem letzten ERP-Lohnmonat (lauf_bis) rechnet Trust flow/Bexio.
  if p_art <> 'altbestand' and public.lohn_nach_lauf_bis(p_jahr, p_monat) is not null then
    raise exception '%', public.lohn_nach_lauf_bis(p_jahr, p_monat) using errcode = 'P0001';
  end if;
  if coalesce(p_pruefsumme, '') = '' or p_ergebnis is null then
    raise exception 'lohn_momentaufnahme_speichern: Ergebnis/Prüfsumme fehlt';
  end if;
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
    v_auszahlung := v_betrag;
  else
    if p_art = 'regulaer' then
      if v_vor.id is not null then
        raise exception 'Für %/% gibt es schon eine Fassung — nur eine Korrekturfassung ist möglich', p_monat, p_jahr;
      end if;
      if exists (select 1 from public.wage_documents w where w.profile_id = p_profile_id and w.doc_type = 'lohnabrechnung'
                   and w.year = p_jahr and w.period_month = p_monat and w.archived_at is null and w.superseded_at is null) then
        if p_nur_wenn_keine_gueltige then
          return jsonb_build_object('modus', 'vorhanden');
        end if;
        raise exception 'Für %/% liegt eine Lohnabrechnung ohne Momentaufnahme vor — zuerst den Altbestand übernehmen', p_monat, p_jahr;
      end if;
      v_auszahlung := v_betrag;
    else
      if v_vor.id is null then
        raise exception 'Korrekturfassung: keine Vorfassung für %/%', p_monat, p_jahr;
      end if;
      if coalesce(trim(p_begruendung), '') = '' then
        raise exception 'Korrekturfassung: Begründung fehlt';
      end if;
      v_auszahlung := v_betrag - coalesce(v_vor.auszahlungsbetrag, v_vor.netto);
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
    auszahlung, auszahlungsbetrag, vorfassung_id, begruendung, erstellt_von, erstellt_von_name)
  values (
    p_profile_id, p_jahr, p_monat, v_fassung, p_art, v_doc_id, v_pfad, p_pdf_sha256,
    p_auszahlungsdatum, coalesce(p_geschaetzt, false), p_kern_version, p_eingaben, p_ergebnis, p_pruefsumme,
    (p_werte ->> 'brutto')::numeric, (p_werte ->> 'total_abzuege')::numeric, v_netto,
    (p_werte ->> 'ahv_lohn')::numeric, (p_werte ->> 'alv_lohn')::numeric, (p_werte ->> 'uvg_lohn')::numeric,
    p_werte ->> 'uvg_art', coalesce((p_werte ->> 'quellensteuer')::numeric, 0),
    v_auszahlung, v_betrag, v_vor.id, nullif(trim(coalesce(p_begruendung, '')), ''), p_actor, p_actor_name)
  returning id into v_id;

  return coalesce(v_doc, '{}'::jsonb) || jsonb_build_object(
    'modus', coalesce(v_doc ->> 'modus', 'altbestand'),
    'momentaufnahme_id', v_id, 'fassung', v_fassung, 'auszahlung', v_auszahlung, 'wage_document_id', v_doc_id);
end;
$$;
revoke all on function public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid) to service_role;

-- ===========================================================================
-- 6. «Ausbezahlt» von Hand (je Fassung; Storno statt Löschen)
-- ===========================================================================
create table if not exists public.lohn_auszahlungen (
  id uuid primary key default gen_random_uuid(),
  momentaufnahme_id uuid not null references public.lohn_momentaufnahmen(id),
  profile_id uuid not null,
  jahr integer not null,
  monat integer not null check (monat between 1 and 12),
  fassung integer not null,
  ausbezahlt_am date not null,
  -- = lohn_momentaufnahmen.auszahlung dieser Fassung (Korrektur: Differenz)
  betrag numeric(12,2) not null,
  notiz text,
  erfasst_at timestamptz not null default now(),
  erfasst_von uuid,
  erfasst_von_name text,
  storniert_at timestamptz,
  storniert_von uuid,
  storniert_von_name text,
  storno_grund text,
  constraint lohn_auszahlungen_storno_check check (storniert_at is null or length(trim(coalesce(storno_grund, ''))) >= 5)
);
create unique index if not exists lohn_auszahlungen_einmal on public.lohn_auszahlungen (momentaufnahme_id) where storniert_at is null;
create index if not exists lohn_auszahlungen_periode_idx on public.lohn_auszahlungen (jahr, monat, profile_id);
alter table public.lohn_auszahlungen enable row level security;
revoke all on public.lohn_auszahlungen from public, anon, authenticated;
grant select, insert, update on public.lohn_auszahlungen to service_role;
drop trigger if exists lohn_auszahlungen_lohn_schutz on public.lohn_auszahlungen;
create trigger lohn_auszahlungen_lohn_schutz
  before delete on public.lohn_auszahlungen
  for each row execute function public.lohn_schutz_nie_loeschen();

-- ===========================================================================
-- 7. Lohnlauf: blockierte Monate und Alarm
-- ===========================================================================
alter table public.lohn_lauf add column if not exists blockiert integer not null default 0;
alter table public.lohn_lauf add column if not exists alarm_gesendet_at timestamptz;
alter table public.lohn_lauf add column if not exists alarm_empfaenger integer;
alter table public.lohn_lauf add column if not exists alarm_fehler text;
alter table public.lohn_lauf drop constraint if exists lohn_lauf_status_check;
alter table public.lohn_lauf add constraint lohn_lauf_status_check
  check (status in ('laeuft', 'ok', 'teilweise', 'fehler', 'abgebrochen', 'pausiert', 'blockiert'));

-- ===========================================================================
-- 8. Zustellung: Wahl digital/Papier (Historie) und Nachweis je Dokument
-- ===========================================================================
create table if not exists public.lohn_zustellung_wahl (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  wahl text not null check (wahl in ('digital', 'papier')),
  version text,                 -- Fassung des Einwilligungstexts (digital)
  gewaehlt_at timestamptz not null default now(),
  -- selbst = die Person; lohnverwaltung = auf Wunsch eingetragen; uebernommen = aus profiles (vor Phase 4)
  quelle text not null check (quelle in ('selbst', 'lohnverwaltung', 'uebernommen')),
  akteur_id uuid,
  akteur_name text,
  notiz text
);
create index if not exists lohn_zustellung_wahl_profil_idx on public.lohn_zustellung_wahl (profile_id, gewaehlt_at desc);
alter table public.lohn_zustellung_wahl enable row level security;
revoke all on public.lohn_zustellung_wahl from public, anon, authenticated;
grant select, insert on public.lohn_zustellung_wahl to service_role;
drop trigger if exists lohn_zustellung_wahl_lohn_schutz on public.lohn_zustellung_wahl;
create trigger lohn_zustellung_wahl_lohn_schutz
  before update or delete on public.lohn_zustellung_wahl
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Bisherige Einwilligungen (profiles.lohndokumente_digital_accepted_at) als
-- ersten Eintrag übernehmen — einmalig.
insert into public.lohn_zustellung_wahl (profile_id, wahl, version, gewaehlt_at, quelle, notiz)
select p.id, 'digital', p.lohndokumente_digital_accepted_version, p.lohndokumente_digital_accepted_at, 'uebernommen',
       'Einwilligung vor Phase 4 (profiles)'
  from public.profiles p
 where p.lohndokumente_digital_accepted_at is not null
   and not exists (select 1 from public.lohn_zustellung_wahl w where w.profile_id = p.id);

create table if not exists public.lohn_dokument_zustellung (
  wage_document_id uuid primary key references public.wage_documents(id) on delete restrict,
  profile_id uuid not null,
  bereitgestellt_at timestamptz not null default now(),
  wahl text check (wahl in ('digital', 'papier')),
  benachrichtigt_at timestamptz,
  benachrichtigt_kanaele text[],
  erstmals_geoeffnet_at timestamptz,
  zuletzt_geoeffnet_at timestamptz,
  anzahl_geoeffnet integer not null default 0,
  ausgedruckt_at timestamptz,
  ausgedruckt_von_name text
);
create index if not exists lohn_dokument_zustellung_profil_idx on public.lohn_dokument_zustellung (profile_id, bereitgestellt_at desc);
alter table public.lohn_dokument_zustellung enable row level security;
revoke all on public.lohn_dokument_zustellung from public, anon, authenticated;
grant select, insert, update on public.lohn_dokument_zustellung to service_role;
drop trigger if exists lohn_dokument_zustellung_lohn_schutz on public.lohn_dokument_zustellung;
create trigger lohn_dokument_zustellung_lohn_schutz
  before delete on public.lohn_dokument_zustellung
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Nachweis je Fassung: Eine Korrekturfassung behält die wage_documents-Zeile
-- (neue Version, neue PDF) und setzt den Nachweis zurück. Der bisherige
-- Nachweis wandert dabei unverändert in den Verlauf (nur anhängen).
alter table public.lohn_dokument_zustellung add column if not exists fassung integer;
comment on column public.lohn_dokument_zustellung.fassung is 'wage_documents.version, die bereitgestellt wurde (Trigger).';
create table if not exists public.lohn_dokument_zustellung_verlauf (
  id uuid primary key default gen_random_uuid(),
  wage_document_id uuid not null,
  profile_id uuid not null,
  fassung integer,
  nachweis jsonb not null,          -- die abgelöste Zeile lohn_dokument_zustellung
  abgeloest_at timestamptz not null default now()
);
create index if not exists lohn_dokument_zustellung_verlauf_doc_idx on public.lohn_dokument_zustellung_verlauf (wage_document_id, abgeloest_at desc);
alter table public.lohn_dokument_zustellung_verlauf enable row level security;
revoke all on public.lohn_dokument_zustellung_verlauf from public, anon, authenticated;
grant select, insert on public.lohn_dokument_zustellung_verlauf to service_role;
drop trigger if exists lohn_dokument_zustellung_verlauf_lohn_schutz on public.lohn_dokument_zustellung_verlauf;
create trigger lohn_dokument_zustellung_verlauf_lohn_schutz
  before update or delete on public.lohn_dokument_zustellung_verlauf
  for each row execute function public.lohn_schutz_nie_loeschen();

create or replace function public.lohn_dokument_zustellung_fassung()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.bereitgestellt_at is distinct from old.bereitgestellt_at then
    select w.version into new.fassung from public.wage_documents w where w.id = new.wage_document_id;
  end if;
  if tg_op = 'UPDATE' and new.bereitgestellt_at is distinct from old.bereitgestellt_at then
    insert into public.lohn_dokument_zustellung_verlauf (wage_document_id, profile_id, fassung, nachweis)
    values (old.wage_document_id, old.profile_id, old.fassung, to_jsonb(old));
  end if;
  return new;
end;
$$;
revoke all on function public.lohn_dokument_zustellung_fassung() from public, anon, authenticated;
drop trigger if exists lohn_dokument_zustellung_fassung on public.lohn_dokument_zustellung;
create trigger lohn_dokument_zustellung_fassung
  before insert or update on public.lohn_dokument_zustellung
  for each row execute function public.lohn_dokument_zustellung_fassung();

-- Öffnen zählen (atomar, ein Aufruf je Abruf durch die Person selbst).
create or replace function public.lohn_dokument_geoeffnet(p_wage_document_id uuid, p_profile_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.lohn_dokument_zustellung (wage_document_id, profile_id, bereitgestellt_at, erstmals_geoeffnet_at, zuletzt_geoeffnet_at, anzahl_geoeffnet)
  select w.id, w.profile_id, coalesce(w.uploaded_at, now()), now(), now(), 1
    from public.wage_documents w where w.id = p_wage_document_id and w.profile_id = p_profile_id
  on conflict (wage_document_id) do update
     set erstmals_geoeffnet_at = coalesce(public.lohn_dokument_zustellung.erstmals_geoeffnet_at, now()),
         zuletzt_geoeffnet_at = now(),
         anzahl_geoeffnet = public.lohn_dokument_zustellung.anzahl_geoeffnet + 1;
$$;
revoke all on function public.lohn_dokument_geoeffnet(uuid, uuid) from public, anon, authenticated;
grant execute on function public.lohn_dokument_geoeffnet(uuid, uuid) to service_role;

-- ===========================================================================
-- 9. Erste Überschneidung eines Zeitraums mit Stempeln der Person
--    (Klartext-Meldungen vor/nach der Regel 368; RLS gilt: invoker)
-- ===========================================================================
create or replace function public.stempel_ueberlappung(p_user uuid, p_von timestamptz, p_bis timestamptz, p_ohne uuid default null)
returns table (id uuid, clock_in timestamptz, clock_out timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, t.clock_in, t.clock_out
    from public.time_entries t
   where t.user_id = p_user
     and (p_ohne is null or t.id <> p_ohne)
     and not t.ueberlappung_altfall
     and tstzrange(t.clock_in, coalesce(t.clock_out, 'infinity'::timestamptz), '[)')
         && tstzrange(p_von, coalesce(p_bis, 'infinity'::timestamptz), '[)')
   order by t.clock_in
   limit 1;
$$;
revoke all on function public.stempel_ueberlappung(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.stempel_ueberlappung(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;

-- Hilfsfunktionen nur für Server / Trigger
revoke all on function public.lohn_lokaler_tag(text) from public, anon, authenticated;
revoke all on function public.time_entries_lohn_felder() from public, anon, authenticated;
