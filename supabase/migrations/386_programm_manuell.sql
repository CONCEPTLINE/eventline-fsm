-- 386 — Programm-Termine: Handaenderungen und Loeschungen bleiben beim
-- Programmheft-Abgleich erhalten (Barakuba, Review 06.11.2026).
-- Vertrag: docs/barakuba/VERTRAG-KALENDER.md.
--
--   programm_manuell: ein Programm-Termin (quelle = 'programmheft') wurde von
--     Hand bearbeitet → der Abgleich (manuell + Cron) ueberschreibt ihn nicht mehr.
--   ausgeblendet: ein Programm-Termin wurde «geloescht» → die Zeile bleibt
--     (sonst legte der taegliche Abgleich ihn wieder an), wird aber nirgends
--     angezeigt und vom Abgleich nicht mehr als «neu» angeboten.
--
-- RLS/Grants unveraendert (Spalten der bestehenden Tabelle, Migration 382/384).
-- Idempotent und nur additiv.

alter table public.standort_termine add column if not exists programm_manuell boolean not null default false;
alter table public.standort_termine add column if not exists ausgeblendet boolean not null default false;

comment on column public.standort_termine.programm_manuell is
  'Programm-Termin von Hand geaendert — Programmheft-Abgleich ueberschreibt ihn nicht (Migration 386).';
comment on column public.standort_termine.ausgeblendet is
  'Programm-Termin geloescht/ausgeblendet — nirgends angezeigt, vom Abgleich nicht neu angelegt (Migration 386).';
