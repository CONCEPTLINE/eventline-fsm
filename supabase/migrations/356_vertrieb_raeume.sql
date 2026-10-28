-- Vertrieb neu: eine einfache Liste von Veranstaltungsraeumen.
--
-- Ersetzt die Akquise-Suche (akquise_locations). Leo und Mischa haben
-- immer rund fuenf Raeume im Kopf, die sie als Naechstes anschreiben
-- wollen — dafuer jedes Mal ein Projekt anzulegen ist zu viel. Ein
-- Eintrag haelt deshalb nur das Noetigste fest:
--   - wer und wo (Name, Ort, Kontakt)
--   - Infos zum Raum als freier Text
--   - PDF-Anhaenge (Bucket `documents`, Ordner `vertrieb/<id>/`)
--   - die Erstmail als Entwurf zum Kopieren
--   - Datum + Aufgabe: der naechste Schritt, erscheint im Kalender
--
-- akquise_locations bleibt vorerst stehen (B1: erst Code deployen, dann
-- droppen) und wird in einer eigenen spaeteren Migration entfernt.

create table if not exists public.vertrieb_raeume (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  ort text,
  ansprechperson text,
  email text,
  telefon text,
  website text,
  infos text,
  erstmail text,
  datum date,
  aufgabe text,
  -- [{ name, path, uploaded_at }] — gleiches Format wie rooms._docs
  dokumente jsonb not null default '[]'::jsonb,
  erstellt_von uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Kalender laedt per Datumsbereich
create index if not exists vertrieb_raeume_datum_idx
  on public.vertrieb_raeume (datum) where datum is not null;

drop trigger if exists vertrieb_raeume_updated_at on public.vertrieb_raeume;
create trigger vertrieb_raeume_updated_at
  before update on public.vertrieb_raeume
  for each row execute function public.update_updated_at();

alter table public.vertrieb_raeume enable row level security;

-- RLS (§5): alle vier Verben explizit, Admin kommt ueber has_permission()
-- immer durch. Wer kein Vertriebsrecht hat, sieht die Eintraege auch im
-- Kalender nicht — der Kalender fragt dieselbe Tabelle ab.
drop policy if exists vertrieb_raeume_select on public.vertrieb_raeume;
create policy vertrieb_raeume_select on public.vertrieb_raeume
  for select to authenticated using ((select public.has_permission('vertrieb:view')));

drop policy if exists vertrieb_raeume_insert on public.vertrieb_raeume;
create policy vertrieb_raeume_insert on public.vertrieb_raeume
  for insert to authenticated with check ((select public.has_permission('vertrieb:create')));

drop policy if exists vertrieb_raeume_update on public.vertrieb_raeume;
create policy vertrieb_raeume_update on public.vertrieb_raeume
  for update to authenticated
  using ((select public.has_permission('vertrieb:edit')))
  with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_raeume_delete on public.vertrieb_raeume;
create policy vertrieb_raeume_delete on public.vertrieb_raeume
  for delete to authenticated using ((select public.has_permission('vertrieb:delete')));

notify pgrst, 'reload schema';
