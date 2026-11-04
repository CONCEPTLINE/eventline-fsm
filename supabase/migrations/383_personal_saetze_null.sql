-- 383: personal_saetze — Sätze dürfen leer sein (null).
--
-- Trust flow (Backoffice-Bestätigung 04.11.2026): Bei reinem Provisionslohn gibt
-- es keinen Stundensatz. Dann sendet Trust flow kosten_chf_h und/oder
-- netto_chf_h als null. Das ERP zeigt dann keine «ca. CHF»-Zahl und rechnet
-- Auftragskosten ohne diese Person.
--
-- Additiv und idempotent; die Prüfung «>= 0» bleibt (null besteht sie).

alter table public.personal_saetze alter column kosten_chf_h drop not null;
alter table public.personal_saetze alter column netto_chf_h drop not null;

comment on column public.personal_saetze.kosten_chf_h is 'Vollkosten Arbeitgeber je Stunde (CHF), laut Trust flow; null = kein Stundensatz (z. B. Provisionslohn).';
comment on column public.personal_saetze.netto_chf_h is 'Nettolohn je Stunde (CHF) inkl. AHV-Wahl, laut Trust flow; null = kein Stundensatz (z. B. Provisionslohn).';
