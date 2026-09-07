-- 223_location_rate_tiers.sql
-- ============================================================
-- Verrechnungssaetze pro Standort in Modi (Normal / Pikett /
-- Administration / ...) — MIT PREIS-HISTORIE.
--
-- Zwei Tabellen:
--
--   1) location_rate_tiers           = Modus-Katalog pro Standort
--      (id, location_id, key, label, is_default, sort_order, is_archived).
--      KEIN Preis hier — der Katalog beschreibt nur "welche Modi gibt's".
--      Genau EIN Tier ist Default (partial unique index).
--
--   2) location_rate_tier_prices     = Preis-Historie je Tier
--      (id, tier_id, chf_per_hour, effective_from, effective_to, note).
--      Neue Preise werden per neuer Row mit effective_from>=heute angelegt.
--      Der Report/das Stempel-UI pickt den zum jeweiligen Datum aktiven
--      Preis via effective_from <= d < COALESCE(effective_to, +∞).
--
-- Warum getrennt? Wenn Preise direkt auf tier waeren, wuerde eine Aenderung
-- alte Stempel-Auswertungen ruecklaufig zerstoeren. Mit Historie:
--   - Stempelt jemand HEUTE auf "Normal" → gilt der HEUTE gueltige Preis.
--   - Legt Leo jetzt "Ab 2027-01: Normal = CHF 95" an → alle time_entries
--     ab 2027-01 rechnen mit CHF 95, alle davor bleiben unveraendert.
--
-- time_entries.rate_tier_id verweist auf den TIER (Kategorie), NICHT auf
-- eine Preis-Version. Beim Report wird via clock_in-Datum der Preis
-- zugeordnet.
--
-- Legacy-Migration: bestehende locations.default_hourly_rate_chf werden
-- als "Normal"-Tier + "Ur-Preis-Row" (effective_from=locations.created_at
-- oder 2020-01-01) angelegt. Die Legacy-Spalte bleibt bestehen (kann
-- spaeter in eigenem Migration-Schritt gedroppt werden — jetzt noch nicht,
-- damit alte Reports weiter funktionieren waehrend die neuen Modi
-- ausgerollt werden).
-- ============================================================

-- ---------------------------------------------------------------
-- 1) Tabelle location_rate_tiers (Modus-Katalog, ohne Preis)
-- ---------------------------------------------------------------
create table if not exists public.location_rate_tiers (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations(id) on delete cascade,
  key            text not null,           -- 'normal' | 'pikett' | 'admin' | 'aufbau' | custom slug
  label          text not null,           -- "Normal", "Pikett-Zuschlag", ...
  is_default     boolean not null default false,
  sort_order     int not null default 0,
  is_archived    boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint uniq_tier_key_per_location unique (location_id, key)
);

create unique index if not exists idx_one_default_per_location
  on public.location_rate_tiers (location_id)
  where is_default = true and is_archived = false;

create index if not exists idx_tiers_location_sort
  on public.location_rate_tiers (location_id, sort_order)
  where is_archived = false;

comment on table public.location_rate_tiers is
  'Modus-Katalog pro Standort (Normal/Pikett/Admin/Custom). Preise in location_rate_tier_prices (Historie).';

-- Touch-Trigger
create or replace function public.tg_location_rate_tiers_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists trg_location_rate_tiers_touch on public.location_rate_tiers;
create trigger trg_location_rate_tiers_touch
  before update on public.location_rate_tiers
  for each row execute function public.tg_location_rate_tiers_touch();

-- ---------------------------------------------------------------
-- 2) Tabelle location_rate_tier_prices (Preis-Historie)
-- ---------------------------------------------------------------
create table if not exists public.location_rate_tier_prices (
  id              uuid primary key default gen_random_uuid(),
  tier_id         uuid not null references public.location_rate_tiers(id) on delete cascade,
  chf_per_hour    numeric(8,2) not null check (chf_per_hour >= 0),
  effective_from  date not null,
  effective_to    date null,               -- exklusiv, NULL = bis auf weiteres
  note            text null,               -- z.B. "Preisanpassung 2027"
  created_at      timestamptz not null default now(),
  created_by      uuid null references public.profiles(id) on delete set null,

  constraint chk_effective_range check (effective_to is null or effective_from < effective_to)
);

-- Ein Tier darf zu einem bestimmten effective_from nur einen Preis haben
-- (verhindert Doppel-Eintraege). Aber KEIN globales unique auf (tier, from)
-- weil Setup-Preis + Zukunftspreis unterschiedliche from's haben.
create unique index if not exists uniq_tier_effective_from
  on public.location_rate_tier_prices (tier_id, effective_from);

create index if not exists idx_tier_prices_tier_from
  on public.location_rate_tier_prices (tier_id, effective_from desc);

comment on table public.location_rate_tier_prices is
  'Preis-Historie je Tier. Preis fuer ein Datum d = row mit MAX(effective_from) wo effective_from <= d AND (effective_to IS NULL OR d < effective_to).';

-- ---------------------------------------------------------------
-- 3) time_entries.rate_tier_id (unveraendert)
-- ---------------------------------------------------------------
alter table public.time_entries
  add column if not exists rate_tier_id uuid references public.location_rate_tiers(id) on delete set null;

create index if not exists idx_time_entries_rate_tier
  on public.time_entries (rate_tier_id)
  where rate_tier_id is not null;

comment on column public.time_entries.rate_tier_id is
  'Kategorie/Tier der Stempelung. Preis wird zur clock_in-Zeit historisch aus location_rate_tier_prices gepickt.';

-- ---------------------------------------------------------------
-- 4) Migration: locations.default_hourly_rate_chf -> Normal-Tier
-- ---------------------------------------------------------------
insert into public.location_rate_tiers
  (location_id, key, label, is_default, sort_order)
select l.id, 'normal', 'Normal', true, 0
from public.locations l
where l.default_hourly_rate_chf is not null
  and not exists (select 1 from public.location_rate_tiers t where t.location_id = l.id);

-- Erster Preis-Eintrag: nimm eventuell l.created_at::date, sonst 2020-01-01
insert into public.location_rate_tier_prices
  (tier_id, chf_per_hour, effective_from, note)
select t.id,
       l.default_hourly_rate_chf,
       coalesce(l.created_at::date, date '2020-01-01'),
       'Legacy-Uebernahme aus locations.default_hourly_rate_chf'
from public.location_rate_tiers t
join public.locations l on l.id = t.location_id
where t.key = 'normal'
  and l.default_hourly_rate_chf is not null
  and not exists (select 1 from public.location_rate_tier_prices p where p.tier_id = t.id);

-- ---------------------------------------------------------------
-- 5) VIEW: aktueller Preis pro Tier zum heutigen Datum
-- ---------------------------------------------------------------
create or replace view public.v_location_rate_tiers_current as
select
  t.id,
  t.location_id,
  t.key,
  t.label,
  t.is_default,
  t.sort_order,
  t.is_archived,
  t.created_at,
  t.updated_at,
  cur.chf_per_hour  as current_chf_per_hour,
  cur.effective_from as current_effective_from,
  next_p.chf_per_hour as next_chf_per_hour,
  next_p.effective_from as next_effective_from
from public.location_rate_tiers t
left join lateral (
  select p.chf_per_hour, p.effective_from
  from public.location_rate_tier_prices p
  where p.tier_id = t.id
    and p.effective_from <= current_date
    and (p.effective_to is null or current_date < p.effective_to)
  order by p.effective_from desc
  limit 1
) cur on true
left join lateral (
  select p.chf_per_hour, p.effective_from
  from public.location_rate_tier_prices p
  where p.tier_id = t.id
    and p.effective_from > current_date
  order by p.effective_from asc
  limit 1
) next_p on true;

comment on view public.v_location_rate_tiers_current is
  'Katalog + aktueller Preis (heute) + naechster geplanter Preis (Zukunft). UI-Convenience.';

-- ---------------------------------------------------------------
-- 6) Helper-Function: Preis fuer einen Tier zu einem Datum
-- ---------------------------------------------------------------
create or replace function public.get_tier_price_at(p_tier_id uuid, p_at date default current_date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select chf_per_hour
  from public.location_rate_tier_prices
  where tier_id = p_tier_id
    and effective_from <= p_at
    and (effective_to is null or p_at < effective_to)
  order by effective_from desc
  limit 1;
$$;

revoke execute on function public.get_tier_price_at(uuid, date) from public, anon;
grant  execute on function public.get_tier_price_at(uuid, date) to authenticated;

-- ---------------------------------------------------------------
-- 7) Upsert-RPC fuer Preise: setzt neue Preis-Row + schliesst
--    vorherige Row (effective_to = neuer from). Atomar.
-- ---------------------------------------------------------------
create or replace function public.upsert_tier_price(
  p_tier_id       uuid,
  p_chf_per_hour  numeric,
  p_effective_from date,
  p_note          text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_id uuid;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  if p_chf_per_hour < 0 then
    raise exception 'chf_per_hour must be >= 0';
  end if;

  -- Vorherige offene Preis-Row (effective_to IS NULL) auf p_effective_from schliessen,
  -- SOFERN sie vor dem neuen from beginnt. Sonst waer's Ueberlappung.
  update public.location_rate_tier_prices
     set effective_to = p_effective_from
   where tier_id = p_tier_id
     and effective_to is null
     and effective_from < p_effective_from;

  -- Neue Preis-Row anlegen. Bei Duplikat-Datum (uniq_tier_effective_from)
  -- machen wir UPDATE statt INSERT — Leo hat vielleicht die selbe Zukunfts-
  -- Row nochmal edited.
  insert into public.location_rate_tier_prices (tier_id, chf_per_hour, effective_from, note, created_by)
       values (p_tier_id, p_chf_per_hour, p_effective_from, p_note, auth.uid())
  on conflict (tier_id, effective_from) do update
     set chf_per_hour = excluded.chf_per_hour,
         note         = excluded.note
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke execute on function public.upsert_tier_price(uuid, numeric, date, text) from public, anon;
grant  execute on function public.upsert_tier_price(uuid, numeric, date, text) to authenticated;

-- ---------------------------------------------------------------
-- 8) RPC: sichere Default-Umschaltung
-- ---------------------------------------------------------------
create or replace function public.set_default_rate_tier(p_tier_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loc uuid;
begin
  if not public.is_admin() then
    raise exception 'forbidden';
  end if;
  select location_id into v_loc from public.location_rate_tiers where id = p_tier_id;
  if v_loc is null then raise exception 'tier not found'; end if;
  update public.location_rate_tiers
     set is_default = false
   where location_id = v_loc and id <> p_tier_id;
  update public.location_rate_tiers
     set is_default = true
   where id = p_tier_id;
end;
$$;

revoke execute on function public.set_default_rate_tier(uuid) from public, anon;
grant  execute on function public.set_default_rate_tier(uuid) to authenticated;

-- ---------------------------------------------------------------
-- 9) RLS
-- ---------------------------------------------------------------
alter table public.location_rate_tiers        enable row level security;
alter table public.location_rate_tier_prices  enable row level security;

drop policy if exists "rate_tiers_read_authenticated" on public.location_rate_tiers;
create policy "rate_tiers_read_authenticated"
  on public.location_rate_tiers for select
  to authenticated using (true);

drop policy if exists "rate_tiers_write_admin" on public.location_rate_tiers;
create policy "rate_tiers_write_admin"
  on public.location_rate_tiers for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "rate_prices_read_authenticated" on public.location_rate_tier_prices;
create policy "rate_prices_read_authenticated"
  on public.location_rate_tier_prices for select
  to authenticated using (true);

drop policy if exists "rate_prices_write_admin" on public.location_rate_tier_prices;
create policy "rate_prices_write_admin"
  on public.location_rate_tier_prices for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
