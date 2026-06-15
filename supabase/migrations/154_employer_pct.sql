-- Arbeitgeber-Anteil als Prozent vom Brutto statt CHF/Stunde.
-- Vorher hatte der Admin den AG-Anteil manuell als CHF-Betrag eingeben
-- muessen (haendisch ausgerechnet). Jetzt ist's ein Prozentwert (typisch
-- ~12% in der Schweiz fuer SME — AHV+ALV-AG-Mirror + FAK + BU + BVG-AG
-- + Verwaltung), und das System rechnet sich CHF/h = Brutto * pct/100
-- automatisch aus.
--
-- Migration:
-- 1. Neue Spalten employer_pct anlegen
-- 2. Bestehende CHF-Werte umrechnen (CHF / hourly_wage * 100, 2 Decimals)
-- 3. Default in app_settings auf 12 setzen (Sinnvoll fuer Bestandsdaten,
--    Admin kann via UI anpassen)
-- 4. Alte CHF-Spalten droppen (per "Wenn etwas weg, dann komplett weg")

-- 1. Neue Pct-Spalte in employee_compensation (nullable = nutze Standard).
alter table public.employee_compensation
  add column if not exists employer_pct numeric(5, 2);

-- 2. Bestandsdaten konvertieren: existing CHF-Override -> pct.
--    Schutz gegen Division durch 0 (theoretisch unmoeglich da hourly_wage
--    immer > 0, aber besser explizit).
update public.employee_compensation
set employer_pct = round((employer_costs_chf_per_hour / nullif(hourly_wage_chf, 0)) * 100, 2)
where employer_costs_chf_per_hour is not null
  and hourly_wage_chf > 0;

-- 3. Default in app_settings: neue Pct-Spalte + sinnvoller Startwert.
--    12% deckt typisch AHV-AG (5.3%) + ALV-AG (1.1%) + FAK (1.6%) + BU
--    (0.5%) + Verwaltung (0.5%) + BVG-AG (2-3%). Pro Firma anpassbar.
alter table public.app_settings
  add column if not exists default_employer_pct numeric(5, 2) not null default 12;

-- 3b. Falls vorher schon ein default_employer_costs_chf_per_hour gesetzt
--     war, koennte man den auch konvertieren — aber das braucht einen
--     'typischen Brutto'-Bezug der nicht existiert. Default 12 ist
--     besser als irgendwas mit fragwuerdigem CHF-Wert hochzurechnen.

-- 4. Alte CHF-Spalten weg.
alter table public.employee_compensation
  drop column if exists employer_costs_chf_per_hour;

alter table public.app_settings
  drop column if exists default_employer_costs_chf_per_hour;
