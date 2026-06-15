-- Pct-Spalten von numeric(5,2) auf numeric(7,4) erweitern.
-- 4 Nachkommastellen statt 2 -> 0.5742% wird exakt gespeichert statt
-- auf 0.57 gerundet. Bei Brutto 22.50 CHF/h macht das pro Monat ca.
-- 0.39 CHF Unterschied — nicht riesig, aber 'minimale Abweichungen'
-- die der Admin nicht erklaeren kann sind genug Grund.

-- 1. app_settings: alle 12 Default-Pcts (6 AN + 6 AG)
alter table public.app_settings
  alter column default_ahv_iv_eo_pct          type numeric(7, 4),
  alter column default_alv_pct                type numeric(7, 4),
  alter column default_nbu_pct                type numeric(7, 4),
  alter column default_bvg_pct                type numeric(7, 4),
  alter column default_ktg_pct                type numeric(7, 4),
  alter column default_quellensteuer_pct      type numeric(7, 4),
  alter column default_employer_ahv_pct       type numeric(7, 4),
  alter column default_employer_alv_pct       type numeric(7, 4),
  alter column default_employer_fak_pct       type numeric(7, 4),
  alter column default_employer_bu_pct        type numeric(7, 4),
  alter column default_employer_bvg_pct       type numeric(7, 4),
  alter column default_employer_verwaltung_pct type numeric(7, 4);

-- 2. employee_compensation: gleiche 12 Pct-Spalten (Pro-MA-Overrides)
alter table public.employee_compensation
  alter column ahv_iv_eo_pct          type numeric(7, 4),
  alter column alv_pct                type numeric(7, 4),
  alter column nbu_pct                type numeric(7, 4),
  alter column bvg_pct                type numeric(7, 4),
  alter column ktg_pct                type numeric(7, 4),
  alter column quellensteuer_pct      type numeric(7, 4),
  alter column employer_ahv_pct       type numeric(7, 4),
  alter column employer_alv_pct       type numeric(7, 4),
  alter column employer_fak_pct       type numeric(7, 4),
  alter column employer_bu_pct        type numeric(7, 4),
  alter column employer_bvg_pct       type numeric(7, 4),
  alter column employer_verwaltung_pct type numeric(7, 4);
