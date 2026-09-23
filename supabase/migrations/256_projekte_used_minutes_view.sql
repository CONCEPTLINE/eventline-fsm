-- Projekt-Stunden fuer die /projekte-Karten: Summe in der DB statt
-- alle time_entries der Firma in den Browser zu laden (kippte bei
-- ~150 Projekten / ~10'000 Eintraegen). security_invoker: die RLS des
-- Aufrufers auf time_entries gilt weiter — jeder sieht exakt die
-- Minuten, die er auch als Einzeleintraege sehen duerfte (gleiches
-- Verhalten wie die bisherige Client-Summierung und die Detailseite).

create or replace view public.projekte_used_minutes
with (security_invoker = true) as
  select
    project_id,
    sum(greatest(1, ceil(extract(epoch from (clock_out - clock_in)) / 60)))::int as used_minutes,
    count(*) filter (where clock_out is null)::int as offene_stempel
  from public.time_entries
  where project_id is not null
  group by project_id;

grant select on public.projekte_used_minutes to authenticated;
