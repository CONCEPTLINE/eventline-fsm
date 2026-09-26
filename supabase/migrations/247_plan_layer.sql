-- Plan-Layer der Location: die Inhalte der uebrigen Plaene (Zuege,
-- Bestandslichter, Anschluesse ...) liegen als ein-/ausblendbare Layer
-- ueber der Grundriss-Unterlage — als ausgerichtetes Bild-Overlay UND/
-- ODER als strukturierte, editierbare Objekte (KI-extrahiert).

create table if not exists public.location_plan_layer (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  name text not null,
  art text not null check (art in ('bild', 'objekte')),
  sichtbar boolean not null default true,
  sort int not null default 0,
  -- Quellplan (Anzeigename) + gerendertes Quell-Bild (auch beim
  -- objekte-Layer als Kontroll-Overlay einblendbar).
  quelle text,
  bild_path text,
  quell_pdf_path text,
  quell_breite_px int,
  quell_hoehe_px int,
  -- Transform Quelle -> Basis-Unterlage: basis_px = quell_px * scale + offset
  scale numeric not null default 1,
  offset_x numeric not null default 0,
  offset_y numeric not null default 0,
  opacity numeric not null default 0.5,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists location_plan_layer_loc_idx on public.location_plan_layer (location_id);

create trigger location_plan_layer_updated_at
  before update on public.location_plan_layer
  for each row execute function public.update_updated_at();

alter table public.location_plan_layer enable row level security;

create policy "Plan-Layer sehen"
  on public.location_plan_layer for select to authenticated
  using (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Layer anlegen"
  on public.location_plan_layer for insert to authenticated
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Layer bearbeiten"
  on public.location_plan_layer for update to authenticated
  using (not public.is_partner() and not public.is_lieferant())
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Layer loeschen"
  on public.location_plan_layer for delete to authenticated
  using (not public.is_partner() and not public.is_lieferant());

-- Objekte eines Layers. Koordinaten in QUELL-Pixeln des Layers (der
-- Layer-Transform bringt sie auf die Basis); beim manuellen Layer ohne
-- Quelle gilt scale=1/offset=0, also direkt Basis-Pixel.
create table if not exists public.location_plan_objekte (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  layer_id uuid not null references public.location_plan_layer(id) on delete cascade,
  typ text not null check (typ in ('zug', 'licht', 'anschluss', 'marker')),
  -- licht: profiler/fresnel/par/washer/bar/sonstig
  -- anschluss: strom/dmx/socapex/audio/netzwerk/sonstig
  untertyp text,
  label text,
  details text,
  x numeric not null,
  y numeric not null,
  -- Linien-Ende (nur typ 'zug')
  x2 numeric,
  y2 numeric,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists location_plan_objekte_layer_idx on public.location_plan_objekte (layer_id);
create index if not exists location_plan_objekte_loc_idx on public.location_plan_objekte (location_id);

create trigger location_plan_objekte_updated_at
  before update on public.location_plan_objekte
  for each row execute function public.update_updated_at();

alter table public.location_plan_objekte enable row level security;

create policy "Plan-Objekte(Loc) sehen"
  on public.location_plan_objekte for select to authenticated
  using (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Objekte(Loc) anlegen"
  on public.location_plan_objekte for insert to authenticated
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Objekte(Loc) bearbeiten"
  on public.location_plan_objekte for update to authenticated
  using (not public.is_partner() and not public.is_lieferant())
  with check (not public.is_partner() and not public.is_lieferant());
create policy "Plan-Objekte(Loc) loeschen"
  on public.location_plan_objekte for delete to authenticated
  using (not public.is_partner() and not public.is_lieferant());
