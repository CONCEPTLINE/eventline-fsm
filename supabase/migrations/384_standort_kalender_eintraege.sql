-- 384 — Standort-Kalender Etappe 1 (Barakuba): Programm-Termine, Veranstaltungen
-- (einmalig/wiederkehrend), «EVENTLINE uebernimmt» und Mitarbeiter ↔ Location.
-- Vertrag: docs/barakuba/VERTRAG-KALENDER.md.
--
--   1. standort_termine: quelle / quelle_id (Programmheft-Eintrag, URL) + unique je Standort
--   2. standort_serien: Veranstaltung mit Wiederholungs-Regel und Ausnahmen (jsonb),
--      wird beim Laden zeitraum-begrenzt aufgeloest (src/lib/standort-kalender.ts)
--   3. standort_uebernahmen: «EVENTLINE uebernimmt alle Privatvermietungen von–bis»
--   4. standort_mitarbeiter: Mitarbeiter ↔ Location (n:m) fuer die Verfuegbarkeit
--   5. locations.programmheft_auto / programmheft_abgeglichen_am (taeglicher Abgleich,
--      /api/cron/programmheft)
--
-- Zugriff wie 382:
--   - Intern: RLS ueber is_internal_user() + has_permission('locations:view'/'locations:edit')
--     (Admin immer, §5). standort_mitarbeiter: lesen mit locations:view ODER Admin
--     (Personal-Verwaltung = Admin-Tab in den Einstellungen, /api/admin/users →
--     requireAdmin); schreiben nur Admin.
--   - Partner: KEINE Policy — nur ueber /api/partner/** mit Service-Rolle nach
--     requirePartnerPortal.
--   - anon: alles entzogen.
--
-- Idempotent und nur additiv.

-- ===========================================================================
-- 1. standort_termine: Programmheft-Herkunft
-- ===========================================================================
alter table public.standort_termine add column if not exists quelle text null;
alter table public.standort_termine add column if not exists quelle_id text null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'standort_termine_quelle_check'
                  and conrelid = 'public.standort_termine'::regclass) then
    alter table public.standort_termine add constraint standort_termine_quelle_check
      check (quelle is null or quelle in ('programmheft'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'standort_termine_quelle_id_check'
                  and conrelid = 'public.standort_termine'::regclass) then
    alter table public.standort_termine add constraint standort_termine_quelle_id_check
      check (quelle_id is null or char_length(quelle_id) <= 300);
  end if;
end $$;

create unique index if not exists standort_termine_quelle_uidx
  on public.standort_termine (location_id, quelle_id)
  where quelle_id is not null;

-- ===========================================================================
-- 2. standort_serien
-- ===========================================================================
create table if not exists public.standort_serien (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  titel text not null check (char_length(btrim(titel)) between 1 and 200),
  kunde text null check (char_length(kunde) <= 200),
  notiz text null check (char_length(notiz) <= 2000),
  datum date not null,
  ganztaegig boolean not null default false,
  von time null,
  bis time null,
  wiederholung text not null default 'nie' check (wiederholung in ('nie', 'woechentlich', 'monatlich')),
  wochentage smallint[] not null default '{}' check (wochentage <@ array[0,1,2,3,4,5,6]::smallint[]),
  bis_datum date null,
  ausnahmen jsonb not null default '{}'::jsonb check (jsonb_typeof(ausnahmen) = 'object'),
  erstellt_von uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint standort_serien_bis_datum_check check (
    (wiederholung = 'nie' and bis_datum is null)
    or (wiederholung <> 'nie' and (bis_datum is null or bis_datum >= datum))
  ),
  constraint standort_serien_zeit_check check (ganztaegig or von is not null)
);

create index if not exists standort_serien_location_idx
  on public.standort_serien (location_id, datum);

drop trigger if exists standort_serien_updated_at on public.standort_serien;
create trigger standort_serien_updated_at
  before update on public.standort_serien
  for each row execute function public.update_updated_at();

-- ===========================================================================
-- 3. standort_uebernahmen
-- ===========================================================================
create table if not exists public.standort_uebernahmen (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  von date not null,
  bis date not null,
  notiz text null check (char_length(notiz) <= 2000),
  erstellt_von uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint standort_uebernahmen_bis_check check (bis >= von)
);

create index if not exists standort_uebernahmen_location_idx
  on public.standort_uebernahmen (location_id, von);

drop trigger if exists standort_uebernahmen_updated_at on public.standort_uebernahmen;
create trigger standort_uebernahmen_updated_at
  before update on public.standort_uebernahmen
  for each row execute function public.update_updated_at();

-- ===========================================================================
-- 4. standort_mitarbeiter
-- ===========================================================================
create table if not exists public.standort_mitarbeiter (
  location_id uuid not null references public.locations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  erstellt_von uuid null references public.profiles(id) on delete set null,
  primary key (location_id, profile_id)
);

create index if not exists standort_mitarbeiter_profile_idx
  on public.standort_mitarbeiter (profile_id);

-- ===========================================================================
-- 5. locations: Programmheft automatisch
-- ===========================================================================
alter table public.locations add column if not exists programmheft_auto boolean not null default false;
alter table public.locations add column if not exists programmheft_abgeglichen_am timestamptz null;

-- ===========================================================================
-- 6. RLS
-- ===========================================================================
alter table public.standort_serien enable row level security;
alter table public.standort_uebernahmen enable row level security;
alter table public.standort_mitarbeiter enable row level security;

-- standort_serien
drop policy if exists standort_serien_select on public.standort_serien;
create policy standort_serien_select on public.standort_serien
  for select to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:view')));
drop policy if exists standort_serien_insert on public.standort_serien;
create policy standort_serien_insert on public.standort_serien
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));
drop policy if exists standort_serien_update on public.standort_serien;
create policy standort_serien_update on public.standort_serien
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:edit')))
  with check ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));
drop policy if exists standort_serien_delete on public.standort_serien;
create policy standort_serien_delete on public.standort_serien
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));

-- standort_uebernahmen
drop policy if exists standort_uebernahmen_select on public.standort_uebernahmen;
create policy standort_uebernahmen_select on public.standort_uebernahmen
  for select to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:view')));
drop policy if exists standort_uebernahmen_insert on public.standort_uebernahmen;
create policy standort_uebernahmen_insert on public.standort_uebernahmen
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));
drop policy if exists standort_uebernahmen_update on public.standort_uebernahmen;
create policy standort_uebernahmen_update on public.standort_uebernahmen
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:edit')))
  with check ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));
drop policy if exists standort_uebernahmen_delete on public.standort_uebernahmen;
create policy standort_uebernahmen_delete on public.standort_uebernahmen
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.has_permission('locations:edit')));

-- standort_mitarbeiter: lesen mit locations:view oder Admin (Personal), schreiben nur Admin
drop policy if exists standort_mitarbeiter_select on public.standort_mitarbeiter;
create policy standort_mitarbeiter_select on public.standort_mitarbeiter
  for select to authenticated
  using ((select public.is_internal_user())
         and ((select public.has_permission('locations:view')) or (select public.is_admin())));
drop policy if exists standort_mitarbeiter_insert on public.standort_mitarbeiter;
create policy standort_mitarbeiter_insert on public.standort_mitarbeiter
  for insert to authenticated
  with check ((select public.is_internal_user()) and (select public.is_admin()));
drop policy if exists standort_mitarbeiter_update on public.standort_mitarbeiter;
create policy standort_mitarbeiter_update on public.standort_mitarbeiter
  for update to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin()))
  with check ((select public.is_internal_user()) and (select public.is_admin()));
drop policy if exists standort_mitarbeiter_delete on public.standort_mitarbeiter;
create policy standort_mitarbeiter_delete on public.standort_mitarbeiter
  for delete to authenticated
  using ((select public.is_internal_user()) and (select public.is_admin()));

revoke all on public.standort_serien from anon;
revoke all on public.standort_uebernahmen from anon;
revoke all on public.standort_mitarbeiter from anon;
revoke truncate, references, trigger on public.standort_serien from authenticated;
revoke truncate, references, trigger on public.standort_uebernahmen from authenticated;
revoke truncate, references, trigger on public.standort_mitarbeiter from authenticated;
grant select, insert, update, delete on public.standort_serien to authenticated;
grant select, insert, update, delete on public.standort_uebernahmen to authenticated;
grant select, insert, update, delete on public.standort_mitarbeiter to authenticated;

notify pgrst, 'reload schema';
