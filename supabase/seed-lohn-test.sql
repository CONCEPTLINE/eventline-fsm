-- ============================================================================
-- seed-lohn-test.sql — synthetische Testdaten für den Lohn-Umbau (NUR LOKAL)
-- ============================================================================
-- Alle Personen sind ERFUNDEN (Mails @example.com, RFC 2606 — gehen nie raus).
-- Zeitraum März 2026 bis Januar 2027. Idempotent: ein zweiter Lauf setzt den
-- gleichen Stand wieder her (Testpersonen-Daten werden gelöscht und neu angelegt).
--
-- Einspielen:  bash supabase/lokal/aufbauen.sh --nur-seed
--
-- Login lokal (http://localhost:3100/login):
--   lohn-admin@example.com  /  LohnTest-2026!     (Admin, Lohn-Seite)
--   lohn-admin2@example.com /  LohnTest-2026!     (zweiter Admin: Vier Augen, Gerätefreigabe;
--                                                  Cookie eventline_trusted_device = lokal-testgeraet-admin2)
--   Testpersonen: <vorname>.<nachname>@example.com / LohnTest-2026!
-- Vertrautes Gerät (Gerätesperre Lohn) für den Admin ist registriert:
--   Cookie  eventline_trusted_device = lokal-testgeraet-admin
--
-- Fälle (Person -> Sonderfall):
--   Lena Jung      unter 20, 20. Geburtstag mitten im Jahr (15.07.2026); Auffahrt; 1. August;
--                  neue Lohnzeile ab 01.10.2026 mit Ferienanteil-Override 8.33 % (wie Live-Fall)
--   Noah Brunner   Ferienanteil-Override 10.64 %; Nachtschichten; Schicht über Mitternacht
--                  UND Monatsende (31.05.->01.06.); Sonntag Sa 23–So 23 (08./09.08. und 16.08.);
--                  überlappende Stempel (11.09., als Altfall markiert, Migration 368); Silvester->Neujahr;
--                  offener Stempel 29.01.2027 (sein letzter — die Regel 368 lässt nach einem offenen
--                  Stempel derselben Person keinen weiteren zu)
--   Mia Keller     NBU: jede Woche 7.75 h -> Ø knapp UNTER 8 h
--   Elias Meier    NBU: jede Woche 8.25 h -> Ø knapp ÜBER 8 h
--   Sara Huber     NBU: sporadische Einsätze (5 h/Monat) + eine grosse Woche (08.–12.06., 42.5 h)
--   Jonas Frei     2'500-CHF-Grenze knapp DARUNTER (2026: 99 h x 25.00 = 2'475.00, keine Zuschläge)
--   Lara Steiner   2'500-CHF-Grenze knapp DARÜBER (2026: 2'532.00) + Lohnerhöhung mitten im
--                  Monat (26.00 -> 28.00 ab 15.09.2026)
--   Luca Rossi     eigene Sätze (uses_standard_lohn = false) inkl. Quellensteuer 10.58 %,
--                  Monatsbrutto um die BVG-Schwelle (8 vs. 9 Arbeitstage x 8 h x 29.00); 1. August
--   Ben Wyss       Austritt mitten im Jahr (Lohnzeile bis 30.06.2026, Profil inaktiv)
-- ============================================================================

set client_min_messages = warning;
begin;

-- Sicherung gegen Fehlbedienung: nur in einer DB ohne echte Konten laufen lassen.
do $$
begin
  if exists (select 1 from auth.users where email not like '%@example.com') then
    raise exception 'ABBRUCH: Diese Datenbank enthält Konten ausserhalb von @example.com — seed-lohn-test.sql ist nur für die lokale Testumgebung.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Standardwerte (Sätze wie Live; BVG-Schwelle 1890 / 1920)
-- ---------------------------------------------------------------------------
-- Löschschutz Firmensätze (Migration 360) nur für das Neuladen kurz aus.
do $$
begin
  if to_regclass('public.lohn_dokument_protokoll') is not null then
    alter table public.payroll_defaults disable trigger payroll_defaults_lohn_schutz;
  end if;
  if to_regclass('public.lohn_momentaufnahmen') is not null then
    alter table public.payroll_defaults disable trigger payroll_defaults_lohn_sperre;
    alter table public.payroll_defaults disable trigger payroll_defaults_lohn_protokoll;
  end if;
end $$;
delete from public.payroll_defaults;
insert into public.payroll_defaults (
  effective_from, default_ahv_iv_eo_pct, default_alv_pct, default_nbu_pct, default_bvg_pct, default_ktg_pct,
  default_quellensteuer_pct, default_employer_ahv_pct, default_employer_alv_pct, default_employer_fak_pct,
  default_employer_bu_pct, default_employer_bvg_pct, default_employer_verwaltung_pct, bvg_threshold_chf, notes)
values
  ('2026-03-09', 5.30, 1.10, 1.45, 0, 0, 0, 5.30, 1.10, 1.35, 0.5742, 0, 0.11, 1890.00, 'Testumgebung: Baseline wie Live (Gründung EVENTLINE GmbH)'),
  ('2027-01-01', 5.30, 1.10, 1.44, 0, 0, 0, 5.30, 1.10, 1.35, 0.5829, 0, 0.11, 1920.00, 'Testumgebung: Standardwerte 2027 wie Live');

-- ---------------------------------------------------------------------------
-- Firma (fiktive Adresse, damit Test-PDFs nie mit echten verwechselt werden)
-- ---------------------------------------------------------------------------
insert into public.company_settings (id, name, street, zip, city, country, phone, email, website, uid_number, iban)
values ('default', 'EVENTLINE GmbH (TESTUMGEBUNG)', 'Teststrasse 1', '4000', 'Basel', 'Schweiz',
        '000 000 00 00', 'test@example.com', 'example.com', 'CHE-000.000.000', 'CH00 0000 0000 0000 0000 0')
on conflict (id) do update set
  name = excluded.name, street = excluded.street, zip = excluded.zip, city = excluded.city, country = excluded.country,
  phone = excluded.phone, email = excluded.email, website = excluded.website, uid_number = excluded.uid_number, iban = excluded.iban;

-- ---------------------------------------------------------------------------
-- Konten + Profile
-- ---------------------------------------------------------------------------
create temp table testperson (
  id uuid primary key, email text, full_name text, role text, birthdate date, is_active boolean
) on commit drop;
insert into testperson values
  ('a0000000-0000-4000-8000-000000000001', 'lohn-admin@example.com',    'Test Admin',    'admin',     '1985-02-01', true),
  ('a0000000-0000-4000-8000-000000000002', 'lohn-admin2@example.com',   'Test Admin Zwei', 'admin',   '1983-05-10', true),
  ('a0000000-0000-4000-8000-000000000011', 'lena.jung@example.com',     'Lena Jung',     'techniker', '2006-07-15', true),
  ('a0000000-0000-4000-8000-000000000012', 'noah.brunner@example.com',  'Noah Brunner',  'techniker', '1998-11-03', true),
  ('a0000000-0000-4000-8000-000000000013', 'mia.keller@example.com',    'Mia Keller',    'techniker', '2001-04-22', true),
  ('a0000000-0000-4000-8000-000000000014', 'elias.meier@example.com',   'Elias Meier',   'techniker', '1994-09-09', true),
  ('a0000000-0000-4000-8000-000000000015', 'sara.huber@example.com',    'Sara Huber',    'techniker', '1990-01-30', true),
  ('a0000000-0000-4000-8000-000000000016', 'jonas.frei@example.com',    'Jonas Frei',    'techniker', '1999-06-12', true),
  ('a0000000-0000-4000-8000-000000000017', 'lara.steiner@example.com',  'Lara Steiner',  'techniker', '2000-12-05', true),
  ('a0000000-0000-4000-8000-000000000018', 'luca.rossi@example.com',    'Luca Rossi',    'techniker', '1992-03-18', true),
  ('a0000000-0000-4000-8000-000000000019', 'ben.wyss@example.com',      'Ben Wyss',      'techniker', '1996-08-27', false);

-- Vier-Augen-Schutz für Rollen (Migration 361) nur für das Anlegen der
-- Testkonten kurz aus (Admin-Testkonten entstehen sonst nur per Antrag).
do $$
begin
  if to_regclass('public.rechte_antraege') is not null then
    alter table public.profiles disable trigger profiles_lohn_rechte_schutz;
  end if;
end $$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000', t.id, 'authenticated', 'authenticated', t.email,
       extensions.crypt('LohnTest-2026!', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('full_name', t.full_name, 'role', t.role),
       '2026-03-01', now(), '', '', '', ''
from testperson t
on conflict (id) do update set
  email = excluded.email, encrypted_password = excluded.encrypted_password,
  email_confirmed_at = excluded.email_confirmed_at, raw_user_meta_data = excluded.raw_user_meta_data,
  banned_until = null, deleted_at = null, updated_at = now();

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select t.id::text, t.id, jsonb_build_object('sub', t.id::text, 'email', t.email, 'email_verified', true),
       'email', null, '2026-03-01', now()
from testperson t
on conflict (provider_id, provider) do nothing;

-- Profil (handle_new_user legt es beim Konto an; hier Stammdaten setzen)
insert into public.profiles (id, email, full_name, role)
select t.id, t.email, t.full_name, t.role from testperson t
on conflict (id) do nothing;
update public.profiles p set
  email = t.email, full_name = t.full_name, role = t.role, birthdate = t.birthdate, is_active = t.is_active,
  datenschutz_akzeptiert_at = '2026-03-09', datenschutz_akzeptiert_version = coalesce(p.datenschutz_akzeptiert_version, '1')
from testperson t where t.id = p.id;

-- ---------------------------------------------------------------------------
-- Vertrautes Gerät für den Admin (Gerätesperre der Lohn-Seite, regulär registriert)
-- Cookie-Wert im Browser: eventline_trusted_device = lokal-testgeraet-admin
-- ---------------------------------------------------------------------------
delete from public.trusted_devices where user_id in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002');
insert into public.trusted_devices (user_id, cookie_token_hash, device_name, user_agent_hint, status, approved_at, approved_by_email, expires_at)
values ('a0000000-0000-4000-8000-000000000001',
        encode(extensions.digest('lokal-testgeraet-admin', 'sha256'), 'hex'),
        'Testgerät (lokal)', 'lokale Testumgebung', 'approved', now(), 'lohn-admin@example.com', now() + interval '5 years'),
       -- Zweiter Admin (Vier Augen, Gerätefreigabe): Cookie lokal-testgeraet-admin2
       ('a0000000-0000-4000-8000-000000000002',
        encode(extensions.digest('lokal-testgeraet-admin2', 'sha256'), 'hex'),
        'Testgerät Admin Zwei (lokal)', 'lokale Testumgebung', 'approved', now(), 'lohn-admin2@example.com', now() + interval '5 years');
-- Wie auf Live nach Migration 360: bestehende Freigaben gelten als «alter Mail-Link».
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trusted_devices' and column_name = 'freigabe_art') then
    update public.trusted_devices set freigabe_art = 'mail_link' where status = 'approved' and freigabe_art is null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Lohnzeilen
-- ---------------------------------------------------------------------------
-- Löschschutz-Trigger (Migration 360) NUR hier, nur für das Neuladen der
-- Testdaten, kurz ausschalten (in dieser Transaktion; der Kopf-Check oben
-- bricht in jeder DB mit echten Konten ab). Am Ende wieder eingeschaltet.
do $$
begin
  if to_regclass('public.lohn_dokument_protokoll') is not null then
    alter table public.wage_documents disable trigger wage_documents_lohn_schutz;
    alter table public.employee_compensation disable trigger employee_compensation_lohn_schutz;
    alter table public.time_entries disable trigger time_entries_lohn_schutz_loeschen;
  end if;
end $$;
-- Phase 4 (Migration 367/368): Sperre/Protokoll auf Stempeln und Zusatzposten,
-- Löschschutz der Auszahlungen und der Zustellung für das Neuladen aus; diese
-- Daten der Testpersonen neu (vor den Momentaufnahmen und PDF-Zeilen, FK).
do $$
begin
  if to_regclass('public.lohn_zusatzposten') is not null then
    alter table public.time_entries disable trigger time_entries_lohn_sperre;
    alter table public.time_entries disable trigger time_entries_lohn_protokoll;
    alter table public.lohn_zusatzposten disable trigger lohn_zusatzposten_lohn_sperre;
    alter table public.lohn_zusatzposten disable trigger lohn_zusatzposten_lohn_protokoll;
    alter table public.lohn_auszahlungen disable trigger lohn_auszahlungen_lohn_schutz;
    alter table public.lohn_dokument_zustellung disable trigger lohn_dokument_zustellung_lohn_schutz;
    alter table public.lohn_dokument_zustellung_verlauf disable trigger lohn_dokument_zustellung_verlauf_lohn_schutz;
    alter table public.lohn_zustellung_wahl disable trigger lohn_zustellung_wahl_lohn_schutz;
    delete from public.lohn_auszahlungen where profile_id in (select id from testperson);
    delete from public.lohn_dokument_zustellung_verlauf where profile_id in (select id from testperson);
    delete from public.lohn_dokument_zustellung where profile_id in (select id from testperson);
    delete from public.lohn_zustellung_wahl where profile_id in (select id from testperson);
    delete from public.lohn_zusatzposten where profile_id in (select id from testperson);
  end if;
end $$;
-- Phase 2 (Migration 364): Sperre und Änderungsprotokoll für das Neuladen aus
-- (Testdaten liegen in abgerechneten Monaten); Momentaufnahmen und Anstellungen
-- der Testpersonen neu.
do $$
declare t text;
begin
  if to_regclass('public.lohn_momentaufnahmen') is not null then
    foreach t in array array['employee_compensation', 'payroll_defaults', 'lohn_anstellungen'] loop
      execute format('alter table public.%I disable trigger %I', t, t || '_lohn_sperre');
      execute format('alter table public.%I disable trigger %I', t, t || '_lohn_protokoll');
    end loop;
    alter table public.lohn_momentaufnahmen disable trigger lohn_momentaufnahmen_lohn_schutz;
    alter table public.lohn_korrektur_vorschlaege disable trigger lohn_korrektur_vorschlaege_lohn_schutz;
    alter table public.lohn_anstellungen disable trigger lohn_anstellungen_lohn_schutz;
    delete from public.lohn_korrektur_vorschlaege where profile_id in (select id from testperson);
    delete from public.lohn_momentaufnahmen where profile_id in (select id from testperson);
    delete from public.lohn_anstellungen where profile_id in (select id from testperson);
  end if;
end $$;
-- Schnittstelle Trust flow (Migration 369): Lohnabrechnungen aus Bexio der Testpersonen
-- verweisen auf wage_documents — für das Neuladen weg (Löschschutz nur hier kurz aus).
do $$
begin
  if to_regclass('public.lohn_bexio_fassungen') is not null then
    alter table public.lohn_bexio_fassungen disable trigger lohn_bexio_fassungen_lohn_schutz;
    delete from public.lohn_bexio_fassungen where profile_id in (select id from testperson);
    alter table public.lohn_bexio_fassungen enable trigger lohn_bexio_fassungen_lohn_schutz;
  end if;
end $$;
delete from public.wage_documents where profile_id in (select id from testperson);
delete from public.employee_compensation where profile_id in (select id from testperson);

insert into public.employee_compensation (profile_id, hourly_wage_chf, effective_from, effective_to, uses_standard_lohn, ferienanteil_pct_override, notes)
values
  ('a0000000-0000-4000-8000-000000000011', 24.00, '2026-03-09', '2026-09-30', true, null,  'Test: unter 20, Geburtstag 15.07.'),
  ('a0000000-0000-4000-8000-000000000011', 24.00, '2026-10-01', null,         true, 8.33,  'Test: wie Live-Fall — neue Zeile ab 01.10. mit Override 8.33 %'),
  ('a0000000-0000-4000-8000-000000000012', 30.00, '2026-03-09', null,         true, 10.64, 'Test: Ferienanteil-Override 10.64 %'),
  ('a0000000-0000-4000-8000-000000000013', 27.00, '2026-03-09', null,         true, null,  'Test: NBU Ø 7.75 h'),
  ('a0000000-0000-4000-8000-000000000014', 27.00, '2026-03-09', null,         true, null,  'Test: NBU Ø 8.25 h'),
  ('a0000000-0000-4000-8000-000000000015', 28.00, '2026-03-09', null,         true, null,  'Test: sporadisch + grosse Woche'),
  ('a0000000-0000-4000-8000-000000000016', 25.00, '2026-03-09', null,         true, null,  'Test: 2500 knapp darunter'),
  ('a0000000-0000-4000-8000-000000000017', 26.00, '2026-03-09', '2026-09-14', true, null,  'Test: vor Lohnerhöhung'),
  ('a0000000-0000-4000-8000-000000000017', 28.00, '2026-09-15', null,         true, null,  'Test: Lohnerhöhung ab 15.09.'),
  ('a0000000-0000-4000-8000-000000000019', 26.50, '2026-03-09', '2026-06-30', true, null,  'Test: Austritt 30.06.');

-- Luca Rossi: eigene Sätze (= Standard + Quellensteuer 10.58 %), 2027 mit den Standardwerten 2027
insert into public.employee_compensation (
  profile_id, hourly_wage_chf, effective_from, effective_to, uses_standard_lohn,
  ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct,
  employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, notes)
values
  ('a0000000-0000-4000-8000-000000000018', 29.00, '2026-03-09', '2026-12-31', false,
   5.30, 1.10, 1.45, 0, 0, 10.58, 5.30, 1.10, 1.35, 0.5742, 0, 0.11, 'Test: eigene Sätze 2026 inkl. QST'),
  ('a0000000-0000-4000-8000-000000000018', 29.00, '2027-01-01', null, false,
   5.30, 1.10, 1.44, 0, 0, 10.58, 5.30, 1.10, 1.35, 0.5829, 0, 0.11, 'Test: eigene Sätze 2027 inkl. QST');

-- ---------------------------------------------------------------------------
-- Stempelzeiten (Wanduhr Europe/Zurich; Dauer = echt gearbeitete Zeit).
-- Keine Einsätze vor dem 09.03.2026 (Gründung = Beginn aller Lohnzeilen).
-- ---------------------------------------------------------------------------
delete from public.time_entries where user_id in (select id from testperson);

create function pg_temp.st(p_user uuid, p_tag date, p_von time, p_dauer interval, p_notiz text default null)
returns void language sql as $f$
  insert into public.time_entries (user_id, clock_in, clock_out, description)
  values (p_user, (p_tag + p_von) at time zone 'Europe/Zurich',
          ((p_tag + p_von) at time zone 'Europe/Zurich') + p_dauer, coalesce(p_notiz, 'Testeinsatz'));
$f$;

-- n-ter Wochentag (isodow 1=Mo … 7=So) eines Monats
create function pg_temp.nter(p_monat date, p_isodow int, p_n int) returns date language sql as $f$
  select (date_trunc('month', p_monat)::date
          + ((p_isodow - extract(isodow from date_trunc('month', p_monat))::int + 7) % 7)
          + 7 * (p_n - 1))::date;
$f$;

-- Feiertage, die der Code kennt (src/lib/swiss-holidays.ts), für 2026/2027
create temp table feiertag (tag date primary key) on commit drop;
insert into feiertag values
  ('2026-01-01'),('2026-01-02'),('2026-04-03'),('2026-04-06'),('2026-05-01'),('2026-05-14'),('2026-05-25'),
  ('2026-08-01'),('2026-12-25'),('2026-12-26'),('2027-01-01'),('2027-01-02');

-- Lena Jung: 2. und 4. Donnerstag 16:00–22:00 (März 2026 – Jan 2027) + 1. August 18:00–23:30
select pg_temp.st('a0000000-0000-4000-8000-000000000011', pg_temp.nter(m::date, 4, n), '16:00', '6 hours')
from generate_series('2026-03-01'::date, '2027-01-01', '1 month') m, unnest(array[2,4]) n;
select pg_temp.st('a0000000-0000-4000-8000-000000000011', '2026-08-01', '18:00', '5 hours 30 minutes', 'Test: Bundesfeiertag');

-- Noah Brunner: 1. und 3. Freitag Nacht 22:00–04:00 + Sonderfälle
select pg_temp.st('a0000000-0000-4000-8000-000000000012', pg_temp.nter(m::date, 5, n), '22:00', '6 hours', 'Test: Nachtschicht')
from generate_series('2026-03-01'::date, '2027-01-01', '1 month') m, unnest(array[1,3]) n
where pg_temp.nter(m::date, 5, n) >= '2026-03-09';
select pg_temp.st('a0000000-0000-4000-8000-000000000012', '2026-05-31', '22:00', '6 hours', 'Test: über Mitternacht und Monatsende (So->Mo)');
select pg_temp.st('a0000000-0000-4000-8000-000000000012', '2026-08-08', '21:00', '8 hours', 'Test: Sa 21:00 -> So 05:00 (Sonntag laut Vertrag ab Sa 23)');
select pg_temp.st('a0000000-0000-4000-8000-000000000012', '2026-08-16', '20:00', '4 hours 30 minutes', 'Test: So 20:00 -> Mo 00:30 (Sonntag laut Vertrag bis So 23)');
-- Überlappung 11.09.: Altfall (vor der Regel 368 entstanden, markiert, ausgenommen)
insert into public.time_entries (user_id, clock_in, clock_out, description, ueberlappung_altfall)
values ('a0000000-0000-4000-8000-000000000012', ('2026-09-11'::date + time '18:00') at time zone 'Europe/Zurich',
        ('2026-09-11'::date + time '18:00') at time zone 'Europe/Zurich' + interval '4 hours', 'Test: Überlappung Teil 1 (Altfall)', true),
       ('a0000000-0000-4000-8000-000000000012', ('2026-09-11'::date + time '21:30') at time zone 'Europe/Zurich',
        ('2026-09-11'::date + time '21:30') at time zone 'Europe/Zurich' + interval '2 hours 15 minutes', 'Test: Überlappung Teil 2 (30 min doppelt, Altfall)', true);
select pg_temp.st('a0000000-0000-4000-8000-000000000012', '2026-12-31', '22:00', '6 hours', 'Test: Silvester -> Neujahr (Jahreswechsel, Feiertag)');
-- Offener Stempel: Noahs letzter (danach kein weiterer Stempel möglich, Regel 368)
insert into public.time_entries (user_id, clock_in, clock_out, description)
values ('a0000000-0000-4000-8000-000000000012', ('2027-01-29'::date + time '18:00') at time zone 'Europe/Zurich', null,
        'Test: offener Stempel (nie ausgestempelt)');

-- Mia Keller: jeden Dienstag 08:00–15:45 (7.75 h)
select pg_temp.st('a0000000-0000-4000-8000-000000000013', d::date, '08:00', '7 hours 45 minutes', 'Test: 7.75 h')
from generate_series('2026-03-10'::date, '2027-01-26', '1 week') d;

-- Elias Meier: jeden Mittwoch 08:00–16:15 (8.25 h)
select pg_temp.st('a0000000-0000-4000-8000-000000000014', d::date, '08:00', '8 hours 15 minutes', 'Test: 8.25 h')
from generate_series('2026-03-11'::date, '2027-01-27', '1 week') d;

-- Sara Huber: sporadisch je 5 h + grosse Woche 08.–12.06. (5 x 8.5 h)
select pg_temp.st('a0000000-0000-4000-8000-000000000015', d, '09:00', '5 hours', 'Test: sporadisch')
from unnest(array['2026-03-18','2026-04-15','2026-05-13','2026-07-15','2026-09-16','2026-11-18','2027-01-13']::date[]) d;
select pg_temp.st('a0000000-0000-4000-8000-000000000015', d::date, '07:30', '8 hours 30 minutes', 'Test: grosse Woche')
from generate_series('2026-06-08'::date, '2026-06-12', '1 day') d;

-- Jonas Frei: 22 x 4.5 h (1./3. Dienstag, im März 2./3., + 2. Di Nov/Dez, 13:00–17:30) = 99 h 2026, keine Zuschläge
select pg_temp.st('a0000000-0000-4000-8000-000000000016', pg_temp.nter(m::date, 2, n), '13:00', '4 hours 30 minutes', 'Test: 2500 knapp darunter')
from generate_series('2026-03-01'::date, '2026-12-01', '1 month') m, unnest(array[1,3]) n
where pg_temp.nter(m::date, 2, n) >= '2026-03-09';
select pg_temp.st('a0000000-0000-4000-8000-000000000016', pg_temp.nter(d, 2, 2), '13:00', '4 hours 30 minutes', 'Test: 2500 knapp darunter')
from unnest(array['2026-03-01','2026-11-01','2026-12-01']::date[]) d;

-- Lara Steiner: 1. und 3. Donnerstag 10:00–16:00 (März–Aug; im März 12./19.), 10.09. (alter Lohn), 17.09. (neuer Lohn), 01.10., 05.11.
select pg_temp.st('a0000000-0000-4000-8000-000000000017', pg_temp.nter(m::date, 4, n), '10:00', '6 hours', 'Test: 2500 knapp darüber')
from generate_series('2026-03-01'::date, '2026-08-01', '1 month') m, unnest(array[1,3]) n
where pg_temp.nter(m::date, 4, n) >= '2026-03-09';
select pg_temp.st('a0000000-0000-4000-8000-000000000017', d, '10:00', '6 hours', 'Test: 2500 knapp darüber')
from unnest(array['2026-03-12','2026-09-10','2026-09-17','2026-10-01','2026-11-05']::date[]) d;

-- Luca Rossi: Montag + Mittwoch 09:00–17:00 (8 h), ohne Feiertage, + 1. August 10:00–16:00
select pg_temp.st('a0000000-0000-4000-8000-000000000018', d::date, '09:00', '8 hours', 'Test: eigene Sätze')
from generate_series('2026-03-09'::date, '2027-01-31', '1 day') d
where extract(isodow from d) in (1, 3) and d::date not in (select tag from feiertag);
select pg_temp.st('a0000000-0000-4000-8000-000000000018', '2026-08-01', '10:00', '6 hours', 'Test: Bundesfeiertag');

-- Ben Wyss: Dienstag 08:00–12:00 bis zum Austritt 30.06.2026
select pg_temp.st('a0000000-0000-4000-8000-000000000019', d::date, '08:00', '4 hours', 'Test: vor Austritt')
from generate_series('2026-03-10'::date, '2026-06-30', '1 week') d;

-- ---------------------------------------------------------------------------
-- Kontrolle
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_j numeric; v_l numeric;
begin
  select count(*) into v_n from public.time_entries where user_id in (select id from testperson);
  select round(sum(extract(epoch from clock_out - clock_in) / 3600) * 25, 2) into v_j
    from public.time_entries where user_id = 'a0000000-0000-4000-8000-000000000016' and clock_in < '2027-01-01';
  if v_j <> 2475.00 then raise exception 'Seed-Kontrolle: Jonas 2026 = % statt 2475.00', v_j; end if;
  select round(sum(extract(epoch from t.clock_out - t.clock_in) / 3600 * c.hourly_wage_chf), 2) into v_l
    from public.time_entries t join public.employee_compensation c
      on c.profile_id = t.user_id and (t.clock_in at time zone 'Europe/Zurich')::date between c.effective_from and coalesce(c.effective_to, '9999-12-31')
    where t.user_id = 'a0000000-0000-4000-8000-000000000017' and t.clock_in < '2027-01-01';
  if v_l <> 2532.00 then raise exception 'Seed-Kontrolle: Lara 2026 = % statt 2532.00', v_l; end if;
  raise warning 'Seed ok: % Testpersonen, % Stempelzeiten (Jonas 2026: %, Lara 2026: %)',
    (select count(*) from testperson), v_n, v_j, v_l;
end $$;

-- Anstellungen (Phase 2): Eintritt 09.03.2026; Ben Austritt 30.06.2026;
-- Elias ohne Anstellung (Fall «Anstellung nicht erfasst»).
do $$
begin
  if to_regclass('public.lohn_anstellungen') is not null then
    insert into public.lohn_anstellungen (profile_id, eintritt, austritt, vertragsart, notiz)
    select id, '2026-03-09', case when id = 'a0000000-0000-4000-8000-000000000019' then '2026-06-30'::date end,
           'abruf_unecht', 'Testumgebung'
      from testperson
     where id not in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
                      'a0000000-0000-4000-8000-000000000014');
  end if;
end $$;

do $$
declare t text;
begin
  if to_regclass('public.lohn_momentaufnahmen') is not null then
    foreach t in array array['employee_compensation', 'payroll_defaults', 'lohn_anstellungen'] loop
      execute format('alter table public.%I enable trigger %I', t, t || '_lohn_sperre');
      execute format('alter table public.%I enable trigger %I', t, t || '_lohn_protokoll');
    end loop;
    alter table public.lohn_momentaufnahmen enable trigger lohn_momentaufnahmen_lohn_schutz;
    alter table public.lohn_korrektur_vorschlaege enable trigger lohn_korrektur_vorschlaege_lohn_schutz;
    alter table public.lohn_anstellungen enable trigger lohn_anstellungen_lohn_schutz;
  end if;
end $$;

do $$
begin
  if to_regclass('public.lohn_dokument_protokoll') is not null then
    alter table public.wage_documents enable trigger wage_documents_lohn_schutz;
    alter table public.employee_compensation enable trigger employee_compensation_lohn_schutz;
    alter table public.time_entries enable trigger time_entries_lohn_schutz_loeschen;
    alter table public.payroll_defaults enable trigger payroll_defaults_lohn_schutz;
  end if;
  if to_regclass('public.lohn_zusatzposten') is not null then
    alter table public.time_entries enable trigger time_entries_lohn_sperre;
    alter table public.time_entries enable trigger time_entries_lohn_protokoll;
    alter table public.lohn_zusatzposten enable trigger lohn_zusatzposten_lohn_sperre;
    alter table public.lohn_zusatzposten enable trigger lohn_zusatzposten_lohn_protokoll;
    alter table public.lohn_auszahlungen enable trigger lohn_auszahlungen_lohn_schutz;
    alter table public.lohn_dokument_zustellung enable trigger lohn_dokument_zustellung_lohn_schutz;
    alter table public.lohn_dokument_zustellung_verlauf enable trigger lohn_dokument_zustellung_verlauf_lohn_schutz;
    alter table public.lohn_zustellung_wahl enable trigger lohn_zustellung_wahl_lohn_schutz;
  end if;
  if to_regclass('public.rechte_antraege') is not null then
    alter table public.profiles enable trigger profiles_lohn_rechte_schutz;
  end if;
end $$;

commit;
