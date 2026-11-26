-- 392: Funktion der eingeteilten Person an einer Location (Leo, 26.11.2026,
-- Ressourcen › Planungsbrett): «leitung» oder «personal». Bisherige
-- Einteilungen gelten als «personal». Idempotent, nur additiv.
--
-- Solange diese Migration nicht eingespielt ist, zeigt das Planungsbrett alle
-- Eingeteilten unter «Personal» und meldet beim Feld «Leitung», dass die
-- Migration fehlt (src/app/api/ressourcen/einteilung/route.ts).

alter table public.standort_mitarbeiter
  add column if not exists funktion text not null default 'personal';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'standort_mitarbeiter_funktion_check'
  ) then
    alter table public.standort_mitarbeiter
      add constraint standort_mitarbeiter_funktion_check check (funktion in ('leitung', 'personal'));
  end if;
end $$;

comment on column public.standort_mitarbeiter.funktion is
  'Funktion an der Location: leitung oder personal (Ressourcen › Planungsbrett).';
