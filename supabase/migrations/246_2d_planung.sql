-- 2D-Aufbauplanung ersetzt das 3D-Raummodell (Leo, 2026-09-20):
-- Der ECHTE Saalplan der Location wird massstaebliche Unterlage, darauf
-- wird pro Auftrag geplant — keine KI-Raumrekonstruktion mehr.

-- 1. 3D-Reste komplett entfernen (Feature geloescht).
alter table public.locations drop column if exists raum_modell;
alter table public.locations drop column if exists website_url;

-- 2. Plan-Unterlage der Location: gerendertes Bild des Saalplans im
--    Storage + Massstab (px pro Meter, ueber 2-Punkte-Kalibrierung).
alter table public.locations add column if not exists plan_unterlage jsonb;

-- 3. Frei platzierte Plan-Objekte pro Auftrag (PA, Stageboxen, Stative,
--    Beschriftungen ...). Material-Platzierungen leben weiter in
--    job_material.position (jetzt Plan-Koordinaten in Metern).
create table if not exists public.job_plan_objekte (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  typ text not null check (typ in ('pa', 'stagebox', 'stativ', 'podest', 'tisch', 'text')),
  label text,
  x numeric not null default 0,
  y numeric not null default 0,
  rot numeric not null default 0,
  breite numeric,
  tiefe numeric,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_plan_objekte_job_idx on public.job_plan_objekte (job_id);

create trigger job_plan_objekte_updated_at
  before update on public.job_plan_objekte
  for each row execute function public.update_updated_at();

alter table public.job_plan_objekte enable row level security;

create policy "Plan-Objekte sehen"
  on public.job_plan_objekte for select to authenticated
  using (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Objekte anlegen"
  on public.job_plan_objekte for insert to authenticated
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Objekte bearbeiten"
  on public.job_plan_objekte for update to authenticated
  using (not public.is_partner() and not public.is_lieferant())
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Objekte loeschen"
  on public.job_plan_objekte for delete to authenticated
  using (not public.is_partner() and not public.is_lieferant());
