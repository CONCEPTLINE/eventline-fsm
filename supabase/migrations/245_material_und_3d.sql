-- Material & 3D (Auftrags-Tab + Location-Raummodell)
--
-- 1. job_material: strukturierte Material-Positionen pro Auftrag — von der
--    Eingang-KI extrahiert (quelle_item_id) oder manuell erfasst. position
--    haelt die 3D-Platzierung im Raum der Location (pro Auftrag).
create table if not exists public.job_material (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  menge numeric not null default 1,
  bezeichnung text not null,
  details text,
  -- Masse in Metern, nur wenn woertlich bekannt: {l, b, h}
  masse jsonb,
  status text not null default 'gebucht' check (status in ('gebucht', 'storniert')),
  created_via text not null default 'manuell' check (created_via in ('ki', 'manuell')),
  quelle_item_id uuid references public.job_inbox_items(id) on delete set null,
  -- 3D-Platzierungen im Raum: [{x, y, rot}] je Stueck (Meter/Grad, Ursprung
  -- = Raum-Nullpunkt). null = noch nicht platziert.
  position jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_material_job_idx on public.job_material (job_id);

create trigger job_material_updated_at
  before update on public.job_material
  for each row execute function public.update_updated_at();

alter table public.job_material enable row level security;

-- Gleiche Sichtbarkeits-Logik wie job_zusagen (Migration 232): interne
-- Mitarbeiter ja, Portal-User (Partner/Lieferant) nein.
create policy "Material sehen"
  on public.job_material for select to authenticated
  using (not public.is_partner() and not public.is_lieferant());
create policy "Material anlegen"
  on public.job_material for insert to authenticated
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Material bearbeiten"
  on public.job_material for update to authenticated
  using (not public.is_partner() and not public.is_lieferant())
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Material loeschen"
  on public.job_material for delete to authenticated
  using (not public.is_partner() and not public.is_lieferant());

-- 2. Location: 3D-Raummodell (parametrisches Skelett als JSON: grundriss,
--    hoehe, buehne, tueren, fenster, hinweise, konfidenz) + Website-URL
--    als Bildquelle fuer die KI-Generierung.
alter table public.locations add column if not exists raum_modell jsonb;
alter table public.locations add column if not exists website_url text;
