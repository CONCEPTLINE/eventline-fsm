-- 372: Getränke-Catering im Auftrag (Leo 2026-11-02, INT-26404).
--
-- Aus dem Excel-Rechner wird ein Modul im Auftrag (Reiter «Catering»): Gäste,
-- Aufbau/Abbau/Länge und die drei Trinkphasen (Vorzeit, Pause, Nachzeit)
-- eingeben → Mindestumsatz (Variante B) und Fixpreis (Variante A) → Verträge
-- und Getränkekarte als PDF.
--
--   catering_getraenke      aktuelle Getränkekarte (Verkauf) mit Einkaufspreis. mix_anteil != null
--                           = Zeile zählt im gewichteten Durchschnitt (je Kategorie genau eine,
--                           zusammen 100 %). Die Karten-PDF wird aus dieser Tabelle erzeugt,
--                           damit Karte und Kalkulation nie auseinanderlaufen.
--   catering_einstellungen  genau EINE Zeile (id = true): Personalkosten, Gäste pro Kraft,
--                           Puffer, Aufschlag A, Trinkverhalten je Phase.
--   job_catering            Eingaben pro Auftrag + eingefrorenes Ergebnis (ergebnis jsonb: die
--                           Zahlen, die in Vertrag und Mail standen), 1 Zeile je Auftrag.
--
-- RLS (Muster Migration 330/355): Einkaufspreise, Personalkosten und Gewinn sind intern — lesen UND
-- schreiben nur mit has_permission('einstellungen:view') (Admins automatisch); die App-Routen laufen
-- zusätzlich über requireAdmin. Alle 4 Verben, anon gesperrt.
-- Archiv-Schutz (Migration 342) auf job_catering. NUR additiv (B1), idempotent.

create table if not exists public.catering_getraenke (
  id uuid primary key default gen_random_uuid(),
  kategorie text not null,
  name text not null,
  einheit text not null default '',
  verkauf numeric(10,2) not null,
  einkauf numeric(10,6) not null,
  mix_anteil numeric(5,4),
  sort integer not null default 0,
  aktiv boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catering_getraenke_kategorie_check check (kategorie in ('aperitif', 'weisswein', 'rotwein', 'bier', 'softdrink')),
  constraint catering_getraenke_preis_check check (verkauf >= 0 and einkauf >= 0),
  constraint catering_getraenke_mix_check check (mix_anteil is null or (mix_anteil > 0 and mix_anteil <= 1))
);
create index if not exists catering_getraenke_sort_idx on public.catering_getraenke(sort);

create table if not exists public.catering_einstellungen (
  id boolean primary key default true,
  lohn_pro_stunde numeric(8,2) not null default 32,
  gaeste_pro_kraft integer not null default 50,
  puffer numeric(5,4) not null default 0.10,
  aufschlag_a numeric(5,4) not null default 0.10,
  anteil_vor numeric(5,4) not null default 0.85,
  rate_vor numeric(6,2) not null default 1.2,
  anteil_pause numeric(5,4) not null default 0.90,
  rate_pause numeric(6,2) not null default 3,
  anteil_nach numeric(5,4) not null default 0.65,
  rate_nach numeric(6,2) not null default 1.2,
  updated_at timestamptz not null default now(),
  constraint catering_einstellungen_einzeilig check (id = true),
  constraint catering_einstellungen_check check (
    lohn_pro_stunde >= 0 and gaeste_pro_kraft >= 1 and puffer >= 0 and aufschlag_a >= 0
    and anteil_vor between 0 and 1 and anteil_pause between 0 and 1 and anteil_nach between 0 and 1
    and rate_vor >= 0 and rate_pause >= 0 and rate_nach >= 0
  )
);
insert into public.catering_einstellungen (id) values (true) on conflict (id) do nothing;

create table if not exists public.job_catering (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.jobs(id) on delete cascade,
  gaeste integer not null,
  aufbau_min integer not null default 60,
  gesamt_min integer not null,
  abbau_min integer not null default 30,
  vorzeit_min integer not null default 0,
  pause_min integer not null default 0,
  nachzeit_min integer not null default 0,
  ausschank_beginn text,
  ergebnis jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_catering_check check (
    gaeste between 1 and 5000
    and aufbau_min between 0 and 1440 and gesamt_min between 1 and 2880 and abbau_min between 0 and 1440
    and vorzeit_min between 0 and 1440 and pause_min between 0 and 1440 and nachzeit_min between 0 and 1440
    and vorzeit_min + pause_min + nachzeit_min <= gesamt_min
  )
);

-- Getränkekarte Stand 02.11.2026 (nur wenn die Tabelle noch leer ist) ---------
insert into public.catering_getraenke (kategorie, name, einheit, verkauf, einkauf, mix_anteil, sort)
select * from (values
  ('aperitif',  'Aperol Spritz',                         '20 cl',                  8.00, 2.600000, 0.10, 10),
  ('weisswein', 'St. Saphorin Terravin, Lavaux AOC',     'Glas · 1 dl',            8.00, 2.466667, 0.10, 20),
  ('weisswein', 'St. Saphorin Terravin, Lavaux AOC',     'Flasche · 75 cl',       55.00, 18.500000, null, 21),
  ('rotwein',   'Pinot Noir de Salquenen, Valais AOC',   'Glas · 1 dl',            8.00, 2.386667, 0.10, 30),
  ('rotwein',   'Pinot Noir de Salquenen, Valais AOC',   'Flasche · 75 cl',       55.00, 17.900000, null, 31),
  ('bier',      'Birra Moretti',                         '33 cl',                  6.50, 1.850000, 0.35, 40),
  ('bier',      'Birra Moretti, alkoholfrei',            '33 cl',                  6.50, 1.850000, null, 41),
  ('softdrink', 'Eptinger rot',                          'mit Kohlensäure · 33 cl', 5.50, 1.200000, 0.35, 50),
  ('softdrink', 'Eptinger blau',                         'ohne Kohlensäure · 33 cl', 5.50, 1.200000, null, 51),
  ('softdrink', 'Coca-Cola',                             '33 cl',                  5.50, 1.200000, null, 52),
  ('softdrink', 'Coca-Cola Zero',                        '33 cl',                  5.50, 1.200000, null, 53)
) as v(kategorie, name, einheit, verkauf, einkauf, mix_anteil, sort)
where not exists (select 1 from public.catering_getraenke);

-- RLS --------------------------------------------------------------------------
alter table public.catering_getraenke enable row level security;
alter table public.catering_einstellungen enable row level security;
alter table public.job_catering enable row level security;

drop policy if exists catering_getraenke_select on public.catering_getraenke;
create policy catering_getraenke_select on public.catering_getraenke
  for select to authenticated using ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));
drop policy if exists catering_getraenke_insert on public.catering_getraenke;
create policy catering_getraenke_insert on public.catering_getraenke
  for insert to authenticated with check ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));
drop policy if exists catering_getraenke_update on public.catering_getraenke;
create policy catering_getraenke_update on public.catering_getraenke
  for update to authenticated using ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')))
  with check ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));
drop policy if exists catering_getraenke_delete on public.catering_getraenke;
create policy catering_getraenke_delete on public.catering_getraenke
  for delete to authenticated using ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));

drop policy if exists catering_einstellungen_select on public.catering_einstellungen;
create policy catering_einstellungen_select on public.catering_einstellungen
  for select to authenticated using ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));
drop policy if exists catering_einstellungen_insert on public.catering_einstellungen;
create policy catering_einstellungen_insert on public.catering_einstellungen
  for insert to authenticated with check ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));
drop policy if exists catering_einstellungen_update on public.catering_einstellungen;
create policy catering_einstellungen_update on public.catering_einstellungen
  for update to authenticated using ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')))
  with check ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));
drop policy if exists catering_einstellungen_delete on public.catering_einstellungen;
create policy catering_einstellungen_delete on public.catering_einstellungen
  for delete to authenticated using ((select public.is_internal_user()) and (select public.has_permission('einstellungen:view')));

drop policy if exists job_catering_select on public.job_catering;
create policy job_catering_select on public.job_catering
  for select to authenticated using (
    (select public.is_internal_user()) and (select public.has_permission('einstellungen:view'))
    and exists (select 1 from public.jobs j where j.id = job_catering.job_id)
  );
drop policy if exists job_catering_insert on public.job_catering;
create policy job_catering_insert on public.job_catering
  for insert to authenticated with check (
    (select public.is_internal_user()) and (select public.has_permission('einstellungen:view'))
    and exists (select 1 from public.jobs j where j.id = job_catering.job_id)
  );
drop policy if exists job_catering_update on public.job_catering;
create policy job_catering_update on public.job_catering
  for update to authenticated using (
    (select public.is_internal_user()) and (select public.has_permission('einstellungen:view'))
    and exists (select 1 from public.jobs j where j.id = job_catering.job_id)
  ) with check (
    (select public.is_internal_user()) and (select public.has_permission('einstellungen:view'))
    and exists (select 1 from public.jobs j where j.id = job_catering.job_id)
  );
drop policy if exists job_catering_delete on public.job_catering;
create policy job_catering_delete on public.job_catering
  for delete to authenticated using (
    (select public.is_internal_user()) and (select public.has_permission('einstellungen:view'))
    and exists (select 1 from public.jobs j where j.id = job_catering.job_id)
  );

revoke all on public.catering_getraenke from anon;
revoke all on public.catering_einstellungen from anon;
revoke all on public.job_catering from anon;

-- Archiv = nur lesen (Migration 342) --------------------------------------------
drop trigger if exists archiv_schutz on public.job_catering;
create trigger archiv_schutz
  before insert or update or delete on public.job_catering
  for each row execute function public.archiv_schutz_kind(
    'auftrag', 'job_id',
    'Der Auftrag ist archiviert (abgeschlossen oder storniert) und kann nur noch gelesen werden.'
  );
