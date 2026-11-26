-- 392: Ressourcen › Planungsbrett (Leo, 26.11.2026)
--   1. standort_mitarbeiter.funktion: «geschaeftsleitung», «betriebsleitung»
--      oder «personal». Bisherige Einteilungen gelten als «personal».
--   2. planung_fiktives_personal: fiktive Personen für die Planung (im Brett
--      gelb) — Leute, die es noch nicht gibt oder die noch kein Konto haben.
--   3. standort_planstellen: Planstellen einer Location, die NICHT mit einem
--      echten Konto besetzt sind: mit fiktiver Person (fiktiv_id gesetzt,
--      gelb) oder offen (fiktiv_id leer, im Brett rot).
-- Idempotent, nur additiv.
--
-- Rechte wie standort_mitarbeiter (Migration 384): lesen mit locations:view
-- oder Admin, direkt schreiben nur Admin. Wer locations:edit hat, schreibt
-- über die Serverwege /api/ressourcen/einteilung und /api/ressourcen/planung.
-- Solange diese Migration fehlt, zeigt das Brett alle Eingeteilten unter
-- «Personal» und sperrt Leitung, fiktives Personal und offene Stellen.

-- 1. Funktion ---------------------------------------------------------------
alter table public.standort_mitarbeiter
  add column if not exists funktion text not null default 'personal';

alter table public.standort_mitarbeiter
  drop constraint if exists standort_mitarbeiter_funktion_check;
alter table public.standort_mitarbeiter
  add constraint standort_mitarbeiter_funktion_check
  check (funktion in ('geschaeftsleitung', 'betriebsleitung', 'personal'));

comment on column public.standort_mitarbeiter.funktion is
  'Funktion an der Location: geschaeftsleitung, betriebsleitung oder personal (Ressourcen › Planungsbrett).';

-- 2. Fiktives Personal --------------------------------------------------------
create table if not exists public.planung_fiktives_personal (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  erstellt_von uuid null references public.profiles(id) on delete set null
);

-- 3. Planstellen ------------------------------------------------------------
create table if not exists public.standort_planstellen (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  funktion text not null check (funktion in ('geschaeftsleitung', 'betriebsleitung', 'personal')),
  fiktiv_id uuid null references public.planung_fiktives_personal(id) on delete cascade,
  created_at timestamptz not null default now(),
  erstellt_von uuid null references public.profiles(id) on delete set null
);

-- Eine fiktive Person steht je Location höchstens einmal; offene Stellen
-- (fiktiv_id leer) darf es mehrere geben.
create unique index if not exists standort_planstellen_fiktiv_uidx
  on public.standort_planstellen (location_id, fiktiv_id) where fiktiv_id is not null;
create index if not exists standort_planstellen_location_idx
  on public.standort_planstellen (location_id);

-- RLS -----------------------------------------------------------------------
alter table public.planung_fiktives_personal enable row level security;
alter table public.standort_planstellen enable row level security;

drop policy if exists planung_fiktives_personal_select on public.planung_fiktives_personal;
create policy planung_fiktives_personal_select on public.planung_fiktives_personal
  for select to authenticated
  using ((select public.is_internal_user())
         and ((select public.has_permission('locations:view')) or (select public.is_admin())));
drop policy if exists planung_fiktives_personal_insert on public.planung_fiktives_personal;
create policy planung_fiktives_personal_insert on public.planung_fiktives_personal
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.is_admin()));
drop policy if exists planung_fiktives_personal_update on public.planung_fiktives_personal;
create policy planung_fiktives_personal_update on public.planung_fiktives_personal
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin()))
  with check ((select public.is_internal_user()) and (select public.is_admin()));
drop policy if exists planung_fiktives_personal_delete on public.planung_fiktives_personal;
create policy planung_fiktives_personal_delete on public.planung_fiktives_personal
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin()));

drop policy if exists standort_planstellen_select on public.standort_planstellen;
create policy standort_planstellen_select on public.standort_planstellen
  for select to authenticated
  using ((select public.is_internal_user())
         and ((select public.has_permission('locations:view')) or (select public.is_admin())));
drop policy if exists standort_planstellen_insert on public.standort_planstellen;
create policy standort_planstellen_insert on public.standort_planstellen
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.is_admin()));
drop policy if exists standort_planstellen_update on public.standort_planstellen;
create policy standort_planstellen_update on public.standort_planstellen
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin()))
  with check ((select public.is_internal_user()) and (select public.is_admin()));
drop policy if exists standort_planstellen_delete on public.standort_planstellen;
create policy standort_planstellen_delete on public.standort_planstellen
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin()));

revoke all on public.planung_fiktives_personal from anon;
revoke all on public.standort_planstellen from anon;
revoke truncate, references, trigger on public.planung_fiktives_personal from authenticated;
revoke truncate, references, trigger on public.standort_planstellen from authenticated;
grant select, insert, update, delete on public.planung_fiktives_personal to authenticated;
grant select, insert, update, delete on public.standort_planstellen to authenticated;
