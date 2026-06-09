-- Team-Vertriebsziel: globales Ziel pro Periode.
--
-- Verwendung im /vertrieb-Tracker oben:
--   "Vom 01.06.2026 bis 30.06.2026 → 30 Leads bearbeiten" + Progress-Bar
--
-- Definition "bearbeitet": Leads die in der Periode auf Step >= 2 sind
-- (= Status 'kontaktiert' oder weiter). Der Counter laeuft live aus
-- vertrieb_contacts:
--   WHERE step >= 2 AND datum_kontakt BETWEEN start AND end
--
-- Nur ein aktives Ziel zur gleichen Zeit — gibt's mehrere mit ueber-
-- lappender Periode, nimmt die UI das zuletzt aktualisierte. Bewusst
-- KEIN unique constraint, damit historische Periodien beibehalten
-- werden koennen.

create table if not exists public.vertrieb_team_goal (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  target_count int not null check (target_count > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vertrieb_team_goal_period_idx
  on public.vertrieb_team_goal (end_date desc, start_date desc);

-- Trigger fuer updated_at — Pattern wie in anderen Tabellen.
create or replace function public.vertrieb_team_goal_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists vertrieb_team_goal_touch_trg on public.vertrieb_team_goal;
create trigger vertrieb_team_goal_touch_trg
  before update on public.vertrieb_team_goal
  for each row execute function public.vertrieb_team_goal_touch();

-- RLS: Lesen darf jeder authenticated (= alle Sales-Mitarbeiter sehen
-- das Team-Ziel). Schreiben nur Admin.
alter table public.vertrieb_team_goal enable row level security;

drop policy if exists "vertrieb_team_goal_select" on public.vertrieb_team_goal;
create policy "vertrieb_team_goal_select" on public.vertrieb_team_goal
  for select to authenticated using (true);

drop policy if exists "vertrieb_team_goal_insert" on public.vertrieb_team_goal;
create policy "vertrieb_team_goal_insert" on public.vertrieb_team_goal
  for insert to authenticated with check (public.is_admin());

drop policy if exists "vertrieb_team_goal_update" on public.vertrieb_team_goal;
create policy "vertrieb_team_goal_update" on public.vertrieb_team_goal
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "vertrieb_team_goal_delete" on public.vertrieb_team_goal;
create policy "vertrieb_team_goal_delete" on public.vertrieb_team_goal
  for delete to authenticated using (public.is_admin());
