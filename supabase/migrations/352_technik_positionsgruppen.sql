-- 352: Technik-Tab Umbau (Leo 2026-10-25) — Kundenwuensche werden
-- POSITIONSGRUPPEN, die flache Materialliste haengt an den Gruppen.
--
-- job_anforderungen = Positionsgruppe «Pos 01 – Rahmen: 3 m hoch, 4 m breit …»
--   + titel                 kurzer Titel (1–3 Woerter); text = Klartext-Beschreibung
--   + nummer                «Pos 01», je Auftrag fortlaufend (Trigger), bleibt beim
--                           Loeschen anderer Gruppen stehen (Bezug fuer den Lieferanten)
--   + manuell_geaendert_at  von Hand angepasst → die Eingang-KI aendert/loescht sie nie
--   + inhalt_geaendert_at   letzte Aenderung an Titel/Beschreibung (Trigger) —
--                           «Geaendert»-Markierung im Lieferantenportal
-- job_technik_positionen = Einzelpositionen einer Gruppe
--   + gruppe_id             → job_anforderungen, ON DELETE CASCADE (die Oberflaeche
--                           nennt vor dem Loeschen, was mitgeht: Einzelpositionen,
--                           Rueckmeldungen, Kommentare des Lieferanten)
--   + manuell_geaendert_at  von Hand angepasst → die KI fasst sie nicht mehr an
--
-- NUR additiv (B1): titel/gruppe_id bleiben nullable, solange der alte Code
-- live ist. NOT NULL + Drops (sort, masse, position, job_plan_objekte,
-- locations.plan_unterlage) folgen in einer eigenen Migration nach dem Deploy.
-- Bestand (25.10.): 19 Wuensche an 5 Auftraegen → Gruppen mit Kurztitel;
-- 2 Positionen an Auftraegen ohne Wuensche → je Gruppe «Weitere Positionen».
-- Idempotent.

-- 1. Spalten ---------------------------------------------------------------
alter table public.job_anforderungen
  add column if not exists titel text,
  add column if not exists nummer integer,
  add column if not exists manuell_geaendert_at timestamptz,
  add column if not exists inhalt_geaendert_at timestamptz;

alter table public.job_technik_positionen
  add column if not exists gruppe_id uuid references public.job_anforderungen(id) on delete cascade,
  add column if not exists manuell_geaendert_at timestamptz;

create index if not exists job_technik_positionen_gruppe_idx on public.job_technik_positionen(gruppe_id);

-- 2. Nummer je Auftrag (Trigger, gegen Parallel-Anlage per Advisory-Lock) --
create or replace function public.technik_gruppe_nummer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.nummer is null then
    perform pg_advisory_xact_lock(hashtextextended('technik_gruppe:' || new.job_id::text, 0));
    select coalesce(max(g.nummer), 0) + 1 into new.nummer
    from public.job_anforderungen g
    where g.job_id = new.job_id;
  end if;
  return new;
end;
$$;
revoke all on function public.technik_gruppe_nummer() from public, anon;

drop trigger if exists job_anforderungen_nummer on public.job_anforderungen;
create trigger job_anforderungen_nummer
  before insert on public.job_anforderungen
  for each row execute function public.technik_gruppe_nummer();

-- 3. Inhalt geaendert (Titel/Beschreibung) ---------------------------------
create or replace function public.technik_gruppe_inhalt_geaendert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.titel is distinct from old.titel or new.text is distinct from old.text then
    new.inhalt_geaendert_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.technik_gruppe_inhalt_geaendert() from public, anon;

drop trigger if exists job_anforderungen_inhalt on public.job_anforderungen;
create trigger job_anforderungen_inhalt
  before update on public.job_anforderungen
  for each row execute function public.technik_gruppe_inhalt_geaendert();

-- 4. Bestand: Nummern (Reihenfolge wie bisher: sort, created_at) ------------
with n as (
  select id, row_number() over (partition by job_id order by sort, created_at, id) as nr
  from public.job_anforderungen
)
update public.job_anforderungen g
set nummer = n.nr
from n
where g.id = n.id and g.nummer is null;

create unique index if not exists job_anforderungen_job_nummer_uq
  on public.job_anforderungen(job_id, nummer);

-- 5. Bestand: Kurztitel der 19 Wuensche (Beschreibung = bisheriger Text) ----
-- Ohne inhalt_geaendert_at: der Titel ist eine Einordnung, keine Aenderung.
alter table public.job_anforderungen disable trigger job_anforderungen_inhalt;
update public.job_anforderungen g
set titel = v.titel
from (values
  ('fb5b1b4b-785a-43a2-a5fb-8ce65b05e891'::uuid, 'Sicherheitsdienst'),
  ('e317f9bb-c5f9-49f8-b61d-bd8ffb021638'::uuid, 'Einsatzzeiten'),
  ('01703ea5-e658-4fa2-8273-46a444dbb17b'::uuid, 'Stundensatz'),
  ('09d300db-5a8c-436e-8205-75a20d2d36ef'::uuid, 'Anlieferung'),
  ('33b0502e-dfde-45c7-bcef-e3747007a993'::uuid, 'Schlüsselübergabe'),
  ('92753848-69e4-4811-a340-b03cf5240b82'::uuid, 'Projektorleinwände'),
  ('5fe43d33-ff19-4f4d-9036-a3c910270703'::uuid, 'Beschallung'),
  ('cb1d17ec-25f0-4e16-81e6-8e2469aad7ed'::uuid, 'Headsets'),
  ('40851c85-2b7c-405e-ad1f-49d6df7e426b'::uuid, 'Handmikrofon'),
  ('f0c27464-6f04-413d-b957-09260c04416b'::uuid, 'Laptop-Anschluss'),
  ('072a603e-eaec-4811-b744-5d1ea17b0216'::uuid, 'Technikcheck'),
  ('d692937e-deff-4ea2-81ee-f1faa23254ac'::uuid, 'Technische Betreuung'),
  ('3c66bdca-64d6-4b06-9a03-7e309ff089ff'::uuid, 'Keine Aufzeichnung'),
  ('6897853d-6260-478d-a189-44cc135da29c'::uuid, 'Licht'),
  ('33881190-9724-485e-a0c2-9af5e165c9f8'::uuid, 'Sound-Setup'),
  ('162f513f-32c0-4dd5-91bd-3bbae477e769'::uuid, 'Betreuung Vormittag'),
  ('2dcb6922-ea9f-445f-bb87-9534db55b78b'::uuid, 'Betreuung Nachmittag'),
  ('917631eb-a69a-42c9-b90f-2da9303882eb'::uuid, 'Begehung'),
  ('0c2179d4-7ab8-46fb-b411-b30ed594f9ba'::uuid, 'Vorhangsystem')
) as v(id, titel)
where g.id = v.id and g.titel is null;
alter table public.job_anforderungen enable trigger job_anforderungen_inhalt;

-- 6. Bestand: Positionen ohne Gruppe → «Weitere Positionen» je Auftrag ------
insert into public.job_anforderungen (job_id, titel, text, created_via)
select distinct p.job_id, 'Weitere Positionen', '', 'manuell'
from public.job_technik_positionen p
where p.gruppe_id is null
  and not exists (
    select 1 from public.job_anforderungen g
    where g.job_id = p.job_id and g.titel = 'Weitere Positionen'
  );

update public.job_technik_positionen p
set gruppe_id = g.id
from public.job_anforderungen g
where p.gruppe_id is null
  and g.job_id = p.job_id
  and g.titel = 'Weitere Positionen';

-- 7. 3D-Visualisierungen: fester Dokument-Ordner «3D» -----------------------
-- Der Technik-Tab erkennt eine 3D-Ansicht als HTML-Dokument am Auftrag im
-- Ordner «3D» (Namensmuster «…_3D_v<N>.html» als Rueckfall). Bestand
-- (5 Dateien, alle ohne Ordner) einmalig einordnen.
update public.documents
set folder = '3D'
where job_id is not null
  and mime_type ilike 'text/html%'
  and folder is null
  and name ~* '_3D_v[0-9]+\.html?$';
