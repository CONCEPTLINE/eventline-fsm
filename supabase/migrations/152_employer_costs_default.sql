-- Arbeitgeber-Kosten: Standard-Wert in app_settings + per-Mitarbeiter-
-- Override. Vorher hat jede Lohn-Zeile zwingend einen eigenen Betrag
-- gespeichert (NOT NULL DEFAULT 0), was bei sauberer Pflege bedeutete
-- dass man bei jedem neuen Mitarbeiter den gleichen Wert wieder eintippt.
--
-- Neues Schema:
--   - app_settings.default_employer_costs_chf_per_hour: firmenweiter Standard
--   - employee_compensation.employer_costs_chf_per_hour: nullable
--     -> NULL  = nutze Standard aus app_settings
--     -> Wert  = expliziter Override fuer diesen Mitarbeiter
--
-- Bestehende Daten bleiben unangetastet — Werte > 0 sind Overrides, Werte
-- = 0 bleiben '0 als Override' (Admin kann sie via UI bei Bedarf clearen).

-- 1. Firmenweiter Standard in app_settings.
alter table public.app_settings
  add column if not exists default_employer_costs_chf_per_hour numeric(8, 2) not null default 0;

-- 2. Override-Spalte nullable machen.
alter table public.employee_compensation
  alter column employer_costs_chf_per_hour drop not null;

-- 3. Default abbauen damit Inserts ohne Wert NULL liefern (statt 0).
alter table public.employee_compensation
  alter column employer_costs_chf_per_hour drop default;

-- Seed-Row in app_settings garantieren (war in 148 schon, falls neu auf
-- leerer DB).
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
