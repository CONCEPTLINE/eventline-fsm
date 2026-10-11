-- Location-Akquise: Suchmaschine fuer Kooperations-Kandidaten.
--
-- Fachlicher Hintergrund: EVENTLINE vermarktet nicht mehr primaer eigene
-- Raeume, sondern bietet fremden Locations vier Kooperationsmodelle an
-- (Vermietungsmanagement / Vermietung + Betreuung / nur Betreuung wie im
-- Barakuba / nur Technikpartner). Diese Tabelle ist der Kandidaten-Pool:
-- je Zeile eine fremde Location, mit den Fakten die das passende Modell
-- und die Rentabilitaet bestimmen.
--
-- Abgrenzung zu `public.locations`: dort stehen die DREI eigenen bzw.
-- betreuten Standorte (operativer Betrieb, Jobs, Raeume). Hier stehen
-- Akquise-Kandidaten, die noch kein Vertragsverhaeltnis haben.
--
-- Datenherkunft: Fakten (Name, Adresse, Koordinaten, Typ, Kapazitaet)
-- kommen aus OpenStreetMap/Overpass — echte Orte, echte Adressen. Die
-- EVENTLINE-Einordnung (Eigentuemer-Typ, Modell, Score) setzt die KI
-- darauf; `bewertung` haelt die Begruendung samt Annahmen fest, damit
-- nachvollziehbar bleibt, warum ein Modell empfohlen wurde.

create sequence if not exists public.akquise_locations_nr_seq start 1;

create table if not exists public.akquise_locations (
  id   uuid primary key default gen_random_uuid(),
  nr   integer not null default nextval('public.akquise_locations_nr_seq'::regclass),

  -- === Stammdaten ===
  name        text not null,
  -- Freitext statt Enum: OSM liefert eine lange, offene Typ-Liste
  -- (saal, theater, halle, hotel, restaurant, museum, kirche, …).
  typ         text,
  strasse     text,
  plz         text,
  ort         text not null,
  -- Zweistelliges Kantonskuerzel (BS, BL, ZH …) — Suchachse neben `ort`.
  kanton      text,
  lat         double precision,
  lng         double precision,

  -- === Kontaktweg ===
  website     text,
  email       text,
  telefon     text,

  -- === Harte Fakten ===
  kapazitaet  integer,
  flaeche_m2  integer,

  -- === EVENTLINE-Faktoren ===
  -- Die vier Signale, aus denen sich das Kooperationsmodell ergibt.
  -- 'unklar' ist der ehrliche Default: aus OSM allein ist das nicht
  -- ableitbar, die KI schaetzt, der Mensch korrigiert.
  eigene_vermarktung text not null default 'unklar'
    check (eigene_vermarktung in ('ja', 'nein', 'unklar')),
  personal_vor_ort   text not null default 'unklar'
    check (personal_vor_ort in ('ja', 'nein', 'unklar')),
  technik_vorhanden  text not null default 'unklar'
    check (technik_vorhanden in ('ja', 'nein', 'unklar')),
  eigentuemer_typ    text not null default 'unbekannt'
    check (eigentuemer_typ in
      ('corporate', 'immobilien', 'kultur', 'oeffentlich', 'gastro', 'unbekannt')),

  -- === Bewertung ===
  empfohlenes_modell text
    check (empfohlenes_modell in
      ('vermietungsmanagement', 'vermietung_betreuung', 'betreuung', 'technikpartner', 'keins')),
  -- Geschaetzter EVENTLINE-Jahresbeitrag in CHF (ganze Franken, Schaetzung).
  rentabilitaet_chf integer,
  -- Gesamtattraktivitaet 0..100 — Sortierachse der Trefferliste.
  score integer check (score between 0 and 100),
  -- { begruendung, teilscores:{}, annahmen:[], modell_alternativen:[] }
  bewertung jsonb,

  -- === Herkunft ===
  quelle          text not null default 'manuell'
    check (quelle in ('osm', 'manuell', 'ki')),
  -- OSM-Elementkennung ("node/123", "way/456") — Dedupe-Schluessel, damit
  -- dieselbe Suche zweimal laufen kann ohne Dubletten zu erzeugen.
  osm_id          text,
  recherchiert_am timestamptz,

  -- === Anpinnen + Analyse ===
  angepinnt_am  timestamptz,
  angepinnt_von uuid references public.profiles(id) on delete set null,
  -- Detaillierte Bedarfsanalyse (Grundlage fuer das PDF).
  bedarfsanalyse      jsonb,
  -- Kooperationskonzept, aus der Bedarfsanalyse erzeugt.
  kooperationskonzept jsonb,

  notizen    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe: eine OSM-Location nur einmal. Partial, weil manuelle Eintraege
-- keine osm_id haben und NULL in Postgres beliebig oft vorkommen darf.
create unique index if not exists akquise_locations_osm_id_idx
  on public.akquise_locations (osm_id) where osm_id is not null;

-- Suchachsen: Kanton/Ort ist die Haupteingabe der Suchmaschine.
create index if not exists akquise_locations_kanton_ort_idx
  on public.akquise_locations (kanton, ort);
-- Angepinnte sind die Arbeitsliste — klein und oft gelesen.
create index if not exists akquise_locations_angepinnt_idx
  on public.akquise_locations (angepinnt_am desc) where angepinnt_am is not null;
-- Trefferliste sortiert nach Score.
create index if not exists akquise_locations_score_idx
  on public.akquise_locations (score desc nulls last);

drop trigger if exists akquise_locations_updated_at on public.akquise_locations;
create trigger akquise_locations_updated_at
  before update on public.akquise_locations
  for each row execute function public.update_updated_at();

alter table public.akquise_locations enable row level security;

-- RLS (§5): alle vier Verben explizit, Admin kommt ueber has_permission()
-- immer durch. Slug bleibt `vertrieb:*` — die Akquise ersetzt den Vertrieb
-- im selben Menuepunkt, so behalten bestehende Rollen ihren Zugriff ohne
-- dass Rechte neu verteilt werden muessen.
drop policy if exists akquise_locations_select on public.akquise_locations;
create policy akquise_locations_select on public.akquise_locations
  for select to authenticated using ((select public.has_permission('vertrieb:view')));

drop policy if exists akquise_locations_insert on public.akquise_locations;
create policy akquise_locations_insert on public.akquise_locations
  for insert to authenticated with check ((select public.has_permission('vertrieb:create')));

drop policy if exists akquise_locations_update on public.akquise_locations;
create policy akquise_locations_update on public.akquise_locations
  for update to authenticated
  using ((select public.has_permission('vertrieb:edit')))
  with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists akquise_locations_delete on public.akquise_locations;
create policy akquise_locations_delete on public.akquise_locations
  for delete to authenticated using ((select public.has_permission('vertrieb:delete')));
