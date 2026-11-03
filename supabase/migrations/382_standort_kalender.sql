-- Standort-Kalender (Partnerportal + interner Belegungsplan pro Standort).
--
-- Partner Basil (Location «Barakuba») traegt im Belegungsplan des Partner-
-- portals eigene Termine ein, aendert und loescht sie, und sieht dort alle
-- EVENTLINE-Auftraege seines Standorts mit Titel, Status und Kunde. Intern
-- gibt es pro Standort denselben Belegungsplan. Freigeschaltet nur fuer
-- Standorte mit locations.partner_kalender = true (vorerst nur Barakuba);
-- alle anderen Standorte bleiben im Portal wie bisher («belegt»).
--
-- Zugriff:
--   - Intern: RLS ueber has_permission('locations:view' / 'locations:edit')
--     (Admin immer, §5), nur interne Konten.
--   - Partner: KEINE Policy — nur ueber /api/partner/** mit Service-Rolle
--     nach requirePartnerPortal (wie seit Migration 346 ueberall).
--   - anon: alles entzogen.
--
-- Neues Partner-Recht partner:belegungsplan:edit — an jede Rolle, die heute
-- partner:belegungsplan:view hat (gleiche Technik wie Migration 216).
--
-- Idempotent und nur additiv.

-- 1) Schalter pro Standort
alter table public.locations
  add column if not exists partner_kalender boolean not null default false;

update public.locations
set partner_kalender = true
where name ilike 'barakuba%'
  and partner_kalender is distinct from true;

-- 2) Eigene Termine eines Standorts
create table if not exists public.standort_termine (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  titel text not null check (char_length(btrim(titel)) between 1 and 200),
  kunde text null check (char_length(kunde) <= 200),
  start_at timestamptz not null,
  end_at timestamptz null check (end_at is null or end_at >= start_at),
  ganztaegig boolean not null default false,
  notiz text null check (char_length(notiz) <= 2000),
  erstellt_von uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists standort_termine_location_start_idx
  on public.standort_termine (location_id, start_at);

drop trigger if exists standort_termine_updated_at on public.standort_termine;
create trigger standort_termine_updated_at
  before update on public.standort_termine
  for each row execute function public.update_updated_at();

alter table public.standort_termine enable row level security;

-- RLS (§5): alle vier Verben explizit, nur interne Konten; Admin kommt ueber
-- has_permission() immer durch.
drop policy if exists standort_termine_select on public.standort_termine;
create policy standort_termine_select on public.standort_termine
  for select to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:view')));

drop policy if exists standort_termine_insert on public.standort_termine;
create policy standort_termine_insert on public.standort_termine
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));

drop policy if exists standort_termine_update on public.standort_termine;
create policy standort_termine_update on public.standort_termine
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:edit')))
  with check ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));

drop policy if exists standort_termine_delete on public.standort_termine;
create policy standort_termine_delete on public.standort_termine
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));

revoke all on public.standort_termine from anon;
revoke truncate, references, trigger on public.standort_termine from authenticated;
grant select, insert, update, delete on public.standort_termine to authenticated;

-- 3) Partner-Recht partner:belegungsplan:edit (dedup via jsonb_agg DISTINCT)
update public.roles
set permissions = (
  select jsonb_agg(distinct perm)
  from jsonb_array_elements_text(
    coalesce(permissions, '[]'::jsonb) || jsonb_build_array('partner:belegungsplan:edit')
  ) as perm
)
where permissions ? 'partner:belegungsplan:view'
  and not (permissions ? 'partner:belegungsplan:edit');

notify pgrst, 'reload schema';
