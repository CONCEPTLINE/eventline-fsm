-- 353: Technik-Tab Umbau, Teil 2 (Leo 2026-10-25) — eingespielt NACH dem
-- Deploy von f1bbdb98 (Code ohne 2D-Plan und ohne die Spalten unten).
--
-- 1. 2D-Planeditor komplett weg («wenn weg, dann komplett weg»):
--    job_plan_objekte (live 0 Zeilen), locations.plan_unterlage (Saalplan-
--    Kalibrierung), job_technik_positionen.masse/position (nur fuer den
--    Aufbauplan). Die Saalplan-Dateien (SCALA BASEL) wurden vorher gesichert:
--    das PDF lag schon byte-gleich als Location-Dokument «plan_saal.pdf», das
--    gerenderte Bild ist jetzt Location-Dokument «Saalplan (Bild aus
--    plan_saal.pdf).png» (Ordner «Technik»); Backup unter
--    C:\tmp\eventline-backup\technik-umbau-2026-10-25.
-- 2. Positionsgruppen fest verdrahten: jede Einzelposition gehoert zu einer
--    Gruppe, jede Gruppe hat Titel und Nummer (Altlasten aus der Zeit zwischen
--    Migration 352 und Deploy vorher nachziehen). job_anforderungen.sort
--    ersetzt durch nummer.
-- Idempotent.

-- 2a. Einzelpositionen ohne Gruppe → «Weitere Positionen» je Auftrag
insert into public.job_anforderungen (job_id, titel, text, created_via)
select distinct p.job_id, 'Weitere Positionen', '', 'manuell'
from public.job_technik_positionen p
where p.gruppe_id is null
  and not exists (
    select 1 from public.job_anforderungen g
    where g.job_id = p.job_id and g.titel = 'Weitere Positionen'
  );

update public.job_technik_positionen p
set gruppe_id = (
  select g.id from public.job_anforderungen g
  where g.job_id = p.job_id and g.titel = 'Weitere Positionen'
  order by g.nummer limit 1
)
where p.gruppe_id is null;

-- 2b. Gruppen ohne Titel (alter Code) → Titel aus dem Text, ohne «geaendert»
alter table public.job_anforderungen disable trigger job_anforderungen_inhalt;
update public.job_anforderungen
set titel = coalesce(nullif(left(regexp_replace(trim(text), '\s+', ' ', 'g'), 60), ''), 'Ohne Titel')
where titel is null or trim(titel) = '';
alter table public.job_anforderungen enable trigger job_anforderungen_inhalt;

alter table public.job_technik_positionen alter column gruppe_id set not null;
alter table public.job_anforderungen alter column titel set not null;
alter table public.job_anforderungen alter column nummer set not null;
alter table public.job_anforderungen drop column if exists sort;

-- 1. 2D-Plan ------------------------------------------------------------------
alter table public.job_technik_positionen drop column if exists masse;
alter table public.job_technik_positionen drop column if exists position;
drop table if exists public.job_plan_objekte;
alter table public.locations drop column if exists plan_unterlage;
