-- 364: Lohn-Umbau Phase 2 «Ein Rechenkern und Momentaufnahmen» (additiv, idempotent).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026: 363 auf lohn, 359 auf lena-telefon).
--
-- Reihenfolge Live: supabase/lokal/live-gang-phase2/LIVE-GANG.md
--   (Wartung «lohn» an → Sicherung → DIESE Migration → Code → Altbestand
--    übernehmen → Anstellungen erfassen → Wartung aus).
--
-- Inhalt:
--   1. lohn_einstellungen.auszahlung_arbeitstag (Auszahlungsdatum = n-ter Arbeitstag Folgemonat)
--   2. lohn_anstellungen: Eintritt, Austritt, ruhend, Vertragsart, Pensum, AHV-Wahl je Jahr
--   3. lohn_momentaufnahmen: jede Fassung mit Eingaben, Positionen, Prüfsumme
--      (regulär, Korrektur = Differenz zur Vorfassung, Altbestand = aus altem PDF)
--   4. lohn_aenderungen: Protokoll alt/neu/wer für Lohnzeilen, Firmensätze, Anstellungen
--   5. Sperre: Änderungen, die abgerechnete (gesperrte) Monate betreffen, nur per
--      Antrag mit Begründung und Vier Augen (lohn_aenderungs_antraege,
--      lohn_aenderung_ausfuehren) — gleiches Muster wie rechte_antraege (361)
--   6. lohn_korrektur_vorschlaege: Kern-Nachrechnung nach einer Korrektur
--   7. RPC lohn_momentaufnahme_speichern (PDF-Fassung + Momentaufnahme in EINER Transaktion)
--   8. Löschschutz, Rechte nur Server (service_role), anon/authenticated ohne Rechte
--
-- Rückweg: supabase/lokal/live-gang-phase2/364_rueckweg.sql (Trigger und Funktionen
-- weg; Tabellen und Protokolle bleiben).

-- ===========================================================================
-- 1. Auszahlungsdatum als Firmen-Einstellung
-- ===========================================================================
alter table public.lohn_einstellungen add column if not exists auszahlung_arbeitstag integer not null default 5;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lohn_einstellungen_auszahlung_arbeitstag_check') then
    alter table public.lohn_einstellungen add constraint lohn_einstellungen_auszahlung_arbeitstag_check
      check (auszahlung_arbeitstag between 1 and 20);
  end if;
end $$;
comment on column public.lohn_einstellungen.auszahlung_arbeitstag is
  'Lohn des Monats M wird am n-ten Arbeitstag (Mo–Fr ohne Feiertage BS) des Folgemonats ausbezahlt. Bestimmt Sätze und Auszahlungsjahr (Auszahlungsprinzip).';

-- ===========================================================================
-- 2. Anstellungen (nur was der Lohn im ERP braucht)
-- ===========================================================================
create table if not exists public.lohn_anstellungen (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  eintritt date not null,
  austritt date,
  ruhend_von date,
  ruhend_bis date,
  vertragsart text not null default 'abruf_unecht',
  befristet_bis date,
  pensum_pct numeric(5,2),
  -- Jahre (Auszahlungsjahr), in denen die Person AHV-Beiträge auch unter
  -- CHF 2'500 verlangt (Art. 34d Abs. 2 AHVV, unterschriebene Erklärung).
  ahv_verlangt_jahre integer[] not null default '{}',
  notiz text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text,
  constraint lohn_anstellungen_austritt_check check (austritt is null or austritt >= eintritt),
  constraint lohn_anstellungen_ruhend_check check (
    (ruhend_von is null and ruhend_bis is null) or (ruhend_von is not null and (ruhend_bis is null or ruhend_bis >= ruhend_von))),
  constraint lohn_anstellungen_vertragsart_check check (vertragsart in ('abruf_unecht', 'abruf_echt', 'fest')),
  constraint lohn_anstellungen_pensum_check check (pensum_pct is null or (pensum_pct > 0 and pensum_pct <= 100))
);
create index if not exists lohn_anstellungen_profil_idx on public.lohn_anstellungen (profile_id, eintritt);
alter table public.lohn_anstellungen enable row level security;
revoke all on public.lohn_anstellungen from public, anon, authenticated;
grant select, insert, update on public.lohn_anstellungen to service_role;

-- Keine überlappenden Anstellungen derselben Person.
create or replace function public.lohn_anstellung_ueberlappung()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.lohn_anstellungen a
     where a.profile_id = new.profile_id and a.id <> new.id
       and a.eintritt <= coalesce(new.austritt, 'infinity'::date)
       and new.eintritt <= coalesce(a.austritt, 'infinity'::date)
  ) then
    raise exception 'lohn_anstellungen: überschneidet sich mit einer anderen Anstellung derselben Person' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists lohn_anstellungen_ueberlappung on public.lohn_anstellungen;
create trigger lohn_anstellungen_ueberlappung
  before insert or update on public.lohn_anstellungen
  for each row execute function public.lohn_anstellung_ueberlappung();

drop trigger if exists lohn_anstellungen_lohn_schutz on public.lohn_anstellungen;
create trigger lohn_anstellungen_lohn_schutz
  before delete on public.lohn_anstellungen
  for each row execute function public.lohn_schutz_nie_loeschen();

-- ===========================================================================
-- 3. Momentaufnahmen (jede Fassung einer Lohnabrechnung)
-- ===========================================================================
create table if not exists public.lohn_momentaufnahmen (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  jahr integer not null,
  monat integer not null check (monat between 1 and 12),
  fassung integer not null,
  art text not null check (art in ('regulaer', 'korrektur', 'altbestand')),
  wage_document_id uuid,
  storage_path text,
  pdf_sha256 text,
  -- Tag, an dem «auszahlung» ausbezahlt wird (Korrektur: eigener Tag).
  auszahlungsdatum date not null,
  auszahlungsdatum_geschaetzt boolean not null default false,
  kern_version text,
  eingaben jsonb,                 -- Kern-Eingabe (null bei Altbestand)
  ergebnis jsonb not null,        -- Kern-Ergebnis bzw. aus dem PDF gelesene Positionen
  pruefsumme text not null,       -- sha256 über das kanonische JSON {art, auszahlungsdatum, eingaben, ergebnis}
  brutto numeric(12,2) not null,
  total_abzuege numeric(12,2) not null,
  netto numeric(12,2) not null,
  ahv_lohn numeric(12,2) not null,
  alv_lohn numeric(12,2) not null,
  uvg_lohn numeric(12,2) not null,
  uvg_art text not null check (uvg_art in ('bu', 'bu_nbu')),
  quellensteuer numeric(12,2) not null default 0,
  -- Regulär/Altbestand = Netto; Korrektur = Netto − Netto der Vorfassung.
  auszahlung numeric(12,2) not null,
  vorfassung_id uuid references public.lohn_momentaufnahmen(id),
  begruendung text,
  erstellt_at timestamptz not null default now(),
  erstellt_von uuid,
  erstellt_von_name text,
  constraint lohn_momentaufnahmen_eindeutig unique (profile_id, jahr, monat, fassung)
);
create index if not exists lohn_momentaufnahmen_periode_idx on public.lohn_momentaufnahmen (jahr, monat, profile_id, fassung desc);
create index if not exists lohn_momentaufnahmen_auszahlung_idx on public.lohn_momentaufnahmen (auszahlungsdatum);
create unique index if not exists lohn_momentaufnahmen_altbestand_einmal
  on public.lohn_momentaufnahmen (wage_document_id, pdf_sha256) where art = 'altbestand';
alter table public.lohn_momentaufnahmen enable row level security;
revoke all on public.lohn_momentaufnahmen from public, anon, authenticated;
grant select, insert on public.lohn_momentaufnahmen to service_role;

drop trigger if exists lohn_momentaufnahmen_lohn_schutz on public.lohn_momentaufnahmen;
create trigger lohn_momentaufnahmen_lohn_schutz
  before update or delete on public.lohn_momentaufnahmen
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Je Person und Monat die gültige (letzte) Fassung — Listen zählen nur diese.
-- Liegt die Lohnabrechnung im Papierkorb, zählt der Monat nicht.
create or replace view public.lohn_fassungen_gueltig
with (security_invoker = true) as
select distinct on (m.profile_id, m.jahr, m.monat) m.*
  from public.lohn_momentaufnahmen m
  left join public.wage_documents w on w.id = m.wage_document_id
 where w.id is null or w.archived_at is null
 order by m.profile_id, m.jahr, m.monat, m.fassung desc;
revoke all on public.lohn_fassungen_gueltig from public, anon, authenticated;
grant select on public.lohn_fassungen_gueltig to service_role;

-- ===========================================================================
-- 4. Änderungsprotokoll (alt/neu/wer) — nur anhängen
-- ===========================================================================
create table if not exists public.lohn_aenderungen (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  tabelle text not null,
  datensatz_id uuid,
  profile_id uuid,
  aktion text not null check (aktion in ('angelegt', 'geaendert', 'geloescht')),
  felder text[] not null default '{}',
  alt jsonb,
  neu jsonb,
  akteur_id uuid,
  akteur_name text,
  -- app = Server mit Benutzer; antrag = bestätigter Antrag (Vier Augen);
  -- notweg = Skript mit Grund; sql = direkt in der Datenbank
  quelle text not null check (quelle in ('app', 'antrag', 'notweg', 'sql')),
  antrag_id uuid,
  grund text
);
-- Mehrere Änderungen in einer Transaktion: Reihenfolge über die Uhrzeit der Zeile.
alter table public.lohn_aenderungen alter column occurred_at set default clock_timestamp();
create index if not exists lohn_aenderungen_profil_idx on public.lohn_aenderungen (profile_id, occurred_at desc);
create index if not exists lohn_aenderungen_tabelle_idx on public.lohn_aenderungen (tabelle, occurred_at desc);
alter table public.lohn_aenderungen enable row level security;
revoke all on public.lohn_aenderungen from public, anon, authenticated;
grant select, insert on public.lohn_aenderungen to service_role;

drop trigger if exists lohn_aenderungen_lohn_schutz on public.lohn_aenderungen;
create trigger lohn_aenderungen_lohn_schutz
  before update or delete on public.lohn_aenderungen
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Wer ändert? Reihenfolge: Antrag/Notweg (GUC) → Kopfzeile x-lohn-akteur des
-- Servers (PostgREST request.headers) → auth.uid() → unbekannt (SQL).
create or replace function public.lohn_akteur()
returns uuid
language plpgsql
stable
as $$
declare
  v text;
begin
  v := nullif(current_setting('lohn.akteur_id', true), '');
  if v is null then
    begin
      v := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-lohn-akteur';
    exception when others then
      v := null;
    end;
  end if;
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return auth.uid();
end;
$$;

-- Ignorierte Felder je Tabelle (kein Einfluss auf den Lohn).
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

-- ===========================================================================
-- 5. Sperre: abgerechnete Monate nur per Antrag (Begründung, Vier Augen)
-- ===========================================================================

-- Frühester Kalendertag, dessen Lohn die Änderung berührt (null = kein Einfluss).
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

-- Ist der Tag (Lohnzeile/Anstellung) bzw. «gültig ab» (Firmensätze) schon abgerechnet?
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

create or replace function public.lohn_sperre_pruefen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ab date;
begin
  if coalesce(current_setting('lohn.aenderung_antrag', true), '') = 'an'
     or coalesce(current_setting('lohn.notweg', true), '') = 'an' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_ab := public.lohn_aenderung_betrifft_ab(
    tg_table_name, tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  if v_ab is not null and public.lohn_tag_gesperrt(tg_table_name, v_ab) then
    raise exception '%: die Änderung betrifft abgerechnete Monate (ab %) — nur per Antrag mit Begründung, den eine zweite Person bestätigt (Vier Augen)',
      tg_table_name, to_char(v_ab, 'DD.MM.YYYY') using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['employee_compensation', 'payroll_defaults', 'lohn_anstellungen'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_lohn_sperre', t);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.lohn_sperre_pruefen()', t || '_lohn_sperre', t);
    execute format('drop trigger if exists %I on public.%I', t || '_lohn_protokoll', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.lohn_aenderung_protokollieren()', t || '_lohn_protokoll', t);
  end loop;
end $$;

-- Anträge
create table if not exists public.lohn_aenderungs_antraege (
  id uuid primary key default gen_random_uuid(),
  bereich text not null check (bereich in ('lohnzeile', 'firmensaetze', 'anstellung')),
  profile_id uuid,
  ziel_name text,
  beschreibung text not null,
  begruendung text not null check (length(trim(begruendung)) >= 10),
  -- [{op: insert|update|delete, tabelle, id?, werte?}]
  operationen jsonb not null,
  betrifft_ab date,
  status text not null default 'offen' check (status in ('offen', 'bestaetigt', 'abgelehnt')),
  beantragt_von uuid not null,
  beantragt_von_name text,
  beantragt_at timestamptz not null default now(),
  gueltig_bis timestamptz not null default now() + interval '24 hours',
  entschieden_von uuid,
  entschieden_von_name text,
  entschieden_at timestamptz,
  ablehnung_grund text,
  notweg_grund text
);
create index if not exists lohn_aenderungs_antraege_offen_idx on public.lohn_aenderungs_antraege (beantragt_at desc) where status = 'offen';
alter table public.lohn_aenderungs_antraege enable row level security;
revoke all on public.lohn_aenderungs_antraege from public, anon, authenticated;
grant select, insert, update on public.lohn_aenderungs_antraege to service_role;
drop trigger if exists lohn_aenderungs_antraege_lohn_schutz on public.lohn_aenderungs_antraege;
create trigger lohn_aenderungs_antraege_lohn_schutz
  before delete on public.lohn_aenderungs_antraege
  for each row execute function public.lohn_schutz_nie_loeschen();

-- Erlaubte Spalten je Tabelle für Antrags-Operationen.
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

-- Antrag ausführen (nur service_role). Prüft: offen, nicht abgelaufen,
-- Bestätiger = aktiver Admin oder die Vertretung, nicht der Antragsteller,
-- nicht die betroffene Person. Das vertraute Gerät prüft der Server.
-- Notweg: p_bestaetiger null + p_notweg_grund (Mischa, protokolliert).
create or replace function public.lohn_aenderung_ausfuehren(
  p_id uuid,
  p_bestaetiger uuid,
  p_bestaetiger_name text,
  p_notweg_grund text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.lohn_aenderungs_antraege%rowtype;
  v_notweg boolean := coalesce(trim(p_notweg_grund), '') <> '';
  v_darf boolean;
  o jsonb;
  v_tab text;
  v_op text;
  v_werte jsonb;
  v_spalten text[];
  v_cols text;
  v_n integer;
  k text;
begin
  select * into a from public.lohn_aenderungs_antraege where id = p_id for update;
  if a.id is null then raise exception 'Antrag nicht gefunden'; end if;
  if a.status <> 'offen' then raise exception 'Antrag ist nicht mehr offen'; end if;
  if a.gueltig_bis <= now() then raise exception 'Antrag ist abgelaufen (älter als 24 h) — bitte neu stellen'; end if;

  if not v_notweg then
    if p_bestaetiger is null then raise exception 'Bestätiger fehlt'; end if;
    select (p.is_active and (p.role = 'admin'
             or p.id = (select e.vertretung_profile_id from public.lohn_einstellungen e where e.id = 'default')))
      into v_darf from public.profiles p where p.id = p_bestaetiger;
    if coalesce(v_darf, false) is false then raise exception 'Bestätigen kann nur ein aktiver Admin oder die Vertretung'; end if;
    if p_bestaetiger = a.beantragt_von then raise exception 'Den eigenen Antrag bestätigt eine zweite Person (Vier Augen)'; end if;
    if a.profile_id is not null and p_bestaetiger = a.profile_id then
      raise exception 'Den eigenen Lohn bestätigt eine zweite Person (Vier Augen)';
    end if;
  end if;

  perform set_config('lohn.aenderung_antrag', 'an', true);
  perform set_config('lohn.antrag_id', a.id::text, true);
  perform set_config('lohn.akteur_id', coalesce(p_bestaetiger::text, ''), true);
  perform set_config('lohn.akteur_name', coalesce(p_bestaetiger_name, 'Notweg'), true);
  perform set_config('lohn.grund', left(a.begruendung, 500), true);

  for o in select * from jsonb_array_elements(a.operationen) loop
    v_tab := o ->> 'tabelle';
    v_op := o ->> 'op';
    v_werte := coalesce(o -> 'werte', '{}'::jsonb);
    v_spalten := public.lohn_antrag_spalten(v_tab);
    if v_spalten is null then raise exception 'Antrag: Tabelle % nicht erlaubt', v_tab; end if;
    for k in select jsonb_object_keys(v_werte) loop
      if not (k = any (v_spalten)) then raise exception 'Antrag: Feld %.% nicht erlaubt', v_tab, k; end if;
    end loop;
    select string_agg(format('%I', x), ', ') into v_cols from jsonb_object_keys(v_werte) x;
    if v_op = 'insert' then
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', v_tab, v_cols, v_cols, v_tab)
        using v_werte;
    elsif v_op = 'update' then
      if v_cols is null then continue; end if;
      execute format('update public.%I t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where t.id = $2',
                     v_tab, v_cols, v_cols, v_tab)
        using v_werte, (o ->> 'id')::uuid;
      get diagnostics v_n = row_count;
      if v_n <> 1 then raise exception 'Antrag: Datensatz % in % nicht gefunden', o ->> 'id', v_tab; end if;
    elsif v_op = 'delete' then
      execute format('delete from public.%I where id = $1', v_tab) using (o ->> 'id')::uuid;
      get diagnostics v_n = row_count;
      if v_n <> 1 then raise exception 'Antrag: Datensatz % in % nicht gefunden', o ->> 'id', v_tab; end if;
    else
      raise exception 'Antrag: Operation % unbekannt', v_op;
    end if;
  end loop;

  -- Freigabe nur für diese Operationen, nicht für den Rest der Transaktion.
  perform set_config('lohn.aenderung_antrag', '', true);
  perform set_config('lohn.antrag_id', '', true);
  perform set_config('lohn.akteur_id', '', true);
  perform set_config('lohn.akteur_name', '', true);
  perform set_config('lohn.grund', '', true);

  update public.lohn_aenderungs_antraege
     set status = 'bestaetigt', entschieden_von = p_bestaetiger,
         entschieden_von_name = case when v_notweg then 'Notweg: ' || coalesce(p_bestaetiger_name, '?') else p_bestaetiger_name end,
         entschieden_at = now(), notweg_grund = case when v_notweg then trim(p_notweg_grund) end
   where id = a.id;

  return jsonb_build_object('id', a.id, 'bereich', a.bereich, 'profile_id', a.profile_id, 'betrifft_ab', a.betrifft_ab);
end;
$$;

revoke all on function public.lohn_aenderung_ausfuehren(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.lohn_aenderung_ausfuehren(uuid, uuid, text, text) to service_role;

-- ===========================================================================
-- 6. Korrektur-Vorschläge (Kern rechnet nach einer Korrektur die Monate des
--    Jahres neu; je abweichendem Monat ein Vorschlag)
-- ===========================================================================
create table if not exists public.lohn_korrektur_vorschlaege (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  jahr integer not null,
  monat integer not null check (monat between 1 and 12),
  antrag_id uuid references public.lohn_aenderungs_antraege(id),
  vorfassung_id uuid not null references public.lohn_momentaufnahmen(id),
  brutto_alt numeric(12,2) not null,
  brutto_neu numeric(12,2) not null,
  netto_alt numeric(12,2) not null,
  netto_neu numeric(12,2) not null,
  differenz numeric(12,2) not null,
  status text not null default 'offen' check (status in ('offen', 'erledigt', 'verworfen')),
  erstellt_at timestamptz not null default now(),
  erledigt_at timestamptz,
  erledigt_von uuid,
  erledigt_von_name text,
  momentaufnahme_id uuid references public.lohn_momentaufnahmen(id)
);
create unique index if not exists lohn_korrektur_vorschlaege_offen
  on public.lohn_korrektur_vorschlaege (profile_id, jahr, monat) where status = 'offen';
alter table public.lohn_korrektur_vorschlaege enable row level security;
revoke all on public.lohn_korrektur_vorschlaege from public, anon, authenticated;
grant select, insert, update on public.lohn_korrektur_vorschlaege to service_role;
drop trigger if exists lohn_korrektur_vorschlaege_lohn_schutz on public.lohn_korrektur_vorschlaege;
create trigger lohn_korrektur_vorschlaege_lohn_schutz
  before delete on public.lohn_korrektur_vorschlaege
  for each row execute function public.lohn_schutz_nie_loeschen();

-- ===========================================================================
-- 7. Momentaufnahme speichern (mit PDF-Fassung in EINER Transaktion)
-- ===========================================================================
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

revoke all on function public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.lohn_momentaufnahme_speichern(uuid, integer, integer, text, text, bigint, text, uuid, text, boolean, date, boolean, text, jsonb, jsonb, text, jsonb, text, uuid) to service_role;

-- Hilfsfunktionen nur für den Server / die Trigger
revoke all on function public.lohn_akteur() from public, anon, authenticated;
revoke all on function public.lohn_tag_gesperrt(text, date) from public, anon, authenticated;
revoke all on function public.lohn_aenderung_betrifft_ab(text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.lohn_tag_gesperrt(text, date) to service_role;
grant execute on function public.lohn_aenderung_betrifft_ab(text, text, jsonb, jsonb) to service_role;
