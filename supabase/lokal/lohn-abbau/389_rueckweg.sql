-- Rückweg zu Migration 389 (Lohn-Abbau 11.11.2026) — nur falls die ERP-Lohnrechnung zurück muss.
--
-- Die Sicherung liegt ausserhalb des Repos (Personaldaten):
--   C:\Users\misch\projects\_artifacts\db-sicherung-erp\lohn-abbau-2026-11-11\
-- Aufruf aus diesem Sicherungsordner mit psql (Verbindung zur ERP-DB):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <repo>/supabase/lokal/lohn-abbau/389_rueckweg.sql
-- Danach den Code-Stand vor 4582a71f (Commit «Lohn-Abbau Phase 2») wieder deployen.

begin;
-- Funktionen zuerst ohne Prüfung der Körper (manche lesen die Tabellen, die erst danach entstehen).
set local check_function_bodies = off;
\i funktionen-vorher.sql

-- Tabellen in Fremdschlüssel-Reihenfolge (Struktur inkl. Trigger, RLS, Rechte).
\i employee_compensation.schema.sql
\i payroll_defaults.schema.sql
\i lohn_lauf.schema.sql
\i lohn_zusatzposten.schema.sql
\i lohn_auszahlungen.schema.sql
\i lohn_korrektur_vorschlaege.schema.sql

-- Daten ohne Schutz-/Sperr-Trigger einspielen (Monate sind gesperrt), danach wieder einschalten.
alter table public.employee_compensation disable trigger user;
alter table public.payroll_defaults disable trigger user;
alter table public.lohn_lauf disable trigger user;
alter table public.lohn_zusatzposten disable trigger user;
alter table public.lohn_auszahlungen disable trigger user;
alter table public.lohn_korrektur_vorschlaege disable trigger user;
commit;

\i employee_compensation.daten.sql
\i payroll_defaults.daten.sql
\i lohn_lauf.daten.sql
\i lohn_zusatzposten.daten.sql
\i lohn_auszahlungen.daten.sql
\i lohn_korrektur_vorschlaege.daten.sql

begin;
alter table public.employee_compensation enable trigger user;
alter table public.payroll_defaults enable trigger user;
alter table public.lohn_lauf enable trigger user;
alter table public.lohn_zusatzposten enable trigger user;
alter table public.lohn_auszahlungen enable trigger user;
alter table public.lohn_korrektur_vorschlaege enable trigger user;

-- Anträge wieder für alle früheren Bereiche.
alter table public.lohn_aenderungs_antraege drop constraint if exists lohn_aenderungs_antraege_bereich_check;
alter table public.lohn_aenderungs_antraege add constraint lohn_aenderungs_antraege_bereich_check
  check (bereich = any (array['lohnzeile'::text, 'firmensaetze'::text, 'anstellung'::text, 'stempel'::text, 'zusatzposten'::text]));
commit;

-- Prüfen (Soll laut README.md der Sicherung): 12 / 2 / 13 / 0 / 4 / 0 Zeilen.
select 'employee_compensation' t, count(*) from public.employee_compensation
union all select 'payroll_defaults', count(*) from public.payroll_defaults
union all select 'lohn_lauf', count(*) from public.lohn_lauf
union all select 'lohn_zusatzposten', count(*) from public.lohn_zusatzposten
union all select 'lohn_auszahlungen', count(*) from public.lohn_auszahlungen
union all select 'lohn_korrektur_vorschlaege', count(*) from public.lohn_korrektur_vorschlaege;
