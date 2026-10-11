-- Verknuepfung Akquise-Kandidat → Projekt.
--
-- Wenn ein Haus ueberzeugt, wird daraus ein Projekt: ein interner
-- Zeit-Topf, auf den die Akquise-Arbeit gestempelt wird (Gespraeche,
-- Begehung, Konzept). Die Verknuepfung haelt fest, dass es dieses
-- Projekt schon gibt — sonst legt beim naechsten Durchklicken jemand
-- ein zweites an.
--
-- Bewusst nur eine Spalte auf der Akquise-Seite: `projects` bleibt
-- unveraendert, damit Projekte ohne Akquise-Herkunft (die Mehrheit)
-- nichts davon merken.

alter table public.akquise_locations
  add column if not exists projekt_id uuid
    references public.projects(id) on delete set null;

comment on column public.akquise_locations.projekt_id is
  'Projekt, das aus diesem Kandidaten entstanden ist. null = noch keines.';

create index if not exists akquise_locations_projekt_idx
  on public.akquise_locations (projekt_id) where projekt_id is not null;
