-- 198_payroll_defaults_baseline_gruendung.sql
-- ============================================================
-- Baseline-Zeile der payroll_defaults auf das Firmen-Gruendungsdatum
-- (2026-03-09, EVENTLINE GmbH) verschieben. In 195 hatte ich pauschal
-- 2020-01-01 als "weit-genug-in-der-Vergangenheit" gewaehlt — falsch,
-- weil die Firma erst seit 2026-03-09 existiert. Alte-Baseline-Zeilen
-- machen die Historie nur verwirrend.
--
-- Bedingt: nur updaten wenn die Baseline noch die ursprungliche
-- 2020-01-01-Zeile ist. Wenn Leo bereits eine Zeile davor angelegt
-- hat, nichts tun.
-- ============================================================

update public.payroll_defaults
   set effective_from = '2026-03-09',
       notes = coalesce(notes, '') ||
               case when notes is null or notes = '' then '' else ' — ' end
               || 'Gueltig ab EVENTLINE GmbH Gruendung'
 where effective_from = '2020-01-01'
   and notes like 'Baseline aus app_settings%';
