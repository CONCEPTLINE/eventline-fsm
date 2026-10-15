-- 329: Namensvorschlag fuer den Rueckstau ZZ (nas_vorschlaege, 303) und
-- Umbenennen beim Verschieben (ablage_moves, 282). Nur additiv, idempotent.
--
-- Die Nachtarbeit auf dem Rig liefert je zz-Vorschlag optional
--   rezept          — Version der Vorschlags-Regeln (z.B. «zz/v3»); kommt
--                     ein offener Vorschlag mit anderem/keinem Rezept neu,
--                     wird der alte (nie entschiedene) geloescht und der
--                     neue ersetzt ihn,
--   name_vorschlag  — neuer Dateiname inkl. Endung (geprueft in
--                     lib/ki/dateiname: gleiche Endung, keine Inhaltsangaben
--                     wie Betraege, Nummern, Adressen, Gesundheitswoerter).
-- Beim «Uebernehmen» haelt gewaehlt_name den Namen fest, den der Admin
-- bestaetigt hat; ablage_moves.neuer_name sagt dem Sync-Client, unter
-- welchem Namen er die Datei im Zielordner ablegt (leer = Name bleibt).
-- Nie Dokumentinhalt.
--
-- Rechte unveraendert (303, 282): (select public.is_admin()), alle 4 Verben.

alter table public.nas_vorschlaege
  add column if not exists rezept text check (char_length(rezept) <= 20),
  add column if not exists name_vorschlag text check (char_length(name_vorschlag) <= 160),
  add column if not exists gewaehlt_name text check (char_length(gewaehlt_name) <= 160);

alter table public.ablage_moves
  add column if not exists neuer_name text check (char_length(neuer_name) <= 160);

-- ── Rueckstau ZZ mit Claude (Kurswechsel 2026-10-15) ──────────────────
-- Fuer ZZ-Dateien (rezept «zz/v3») liefert das Rig kein Ziel mehr, sondern
-- einen gefilterten Beschrieb + Fakten-Hinweise (nas_zz_beschriebe). Die App
-- fragt Claude nach Zielordner / neuem Ordner / Dateiname
-- (lib/ki/zz-warteschlange); ein Admin gibt frei.
--   ziel_neu — das Ziel ist ein vorgeschlagener NEUER Ordner (noch nicht in
--              ablage_ordner); angelegt wird er erst beim «Uebernehmen».
--   quelle   — zusaetzlich 'claude'.

alter table public.nas_vorschlaege
  add column if not exists ziel_neu boolean not null default false;

-- Quelle-Check robust ersetzen (303 hat ihn unbenannt angelegt).
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.nas_vorschlaege'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%quelle%'
  loop
    execute format('alter table public.nas_vorschlaege drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.nas_vorschlaege
  add constraint nas_vorschlaege_quelle_check
  check (quelle in ('regel', 'vorbild', 'modell', 'claude'));

-- Warteschlange der ZZ-Beschriebe vom Rig. Nur Metadaten: der Beschrieb ist
-- auf dem Rig und im FSM gefiltert (lib/ki/zz-entscheid, leseZzBeschrieb),
-- `fehler` ist nur ein Kurzgrund, nie Inhalt. Der Beschrieb bleibt nach dem
-- Entscheid stehen — die Ablage lernt aus den menschlichen Entscheiden
-- (nas_ablage_lernbeispiele).
create table if not exists public.nas_zz_beschriebe (
  id uuid primary key default gen_random_uuid(),
  pfad text not null,
  sha256 text,
  ordner_ist text not null,
  rezept text not null check (char_length(rezept) <= 20),
  beschrieb jsonb not null,
  fakten jsonb not null default '[]'::jsonb,
  kandidaten text[] not null default '{}',
  status text not null default 'wartet'
    check (status in ('wartet', 'in_arbeit', 'fertig', 'fehler', 'verworfen')),
  versuche int not null default 0,
  fehler text check (char_length(fehler) <= 60),
  lauf_id text,
  modell text,
  vorschlag_id uuid references public.nas_vorschlaege(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Eine Zeile je Datei-Inhalt und Rezept (sha256 fehlt -> trotzdem eindeutig).
create unique index if not exists nas_zz_beschriebe_uq
  on public.nas_zz_beschriebe (pfad, sha256, rezept) nulls not distinct;
create index if not exists nas_zz_beschriebe_status
  on public.nas_zz_beschriebe (status, created_at);
create index if not exists nas_zz_beschriebe_vorschlag
  on public.nas_zz_beschriebe (vorschlag_id);

alter table public.nas_zz_beschriebe enable row level security;

drop policy if exists nas_zz_beschriebe_select on public.nas_zz_beschriebe;
create policy nas_zz_beschriebe_select on public.nas_zz_beschriebe
  for select using ((select public.is_admin()));
drop policy if exists nas_zz_beschriebe_insert on public.nas_zz_beschriebe;
create policy nas_zz_beschriebe_insert on public.nas_zz_beschriebe
  for insert with check ((select public.is_admin()));
drop policy if exists nas_zz_beschriebe_update on public.nas_zz_beschriebe;
create policy nas_zz_beschriebe_update on public.nas_zz_beschriebe
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists nas_zz_beschriebe_delete on public.nas_zz_beschriebe;
create policy nas_zz_beschriebe_delete on public.nas_zz_beschriebe
  for delete using ((select public.is_admin()));

-- Lernbeispiele: je menschlichem Entscheid ueber einen Claude-Vorschlag
-- (angenommen / korrigiert / abgelehnt) — vorgeschlagen vs. final. Nur
-- Metadaten (gefilterter Beschrieb, Dokumentart, Ordner, Dateinamen).
-- verarbeiteZzWarteschlange gibt Claude die passendsten als Beispiele mit.
create table if not exists public.nas_ablage_lernbeispiele (
  id uuid primary key default gen_random_uuid(),
  vorschlag_id uuid references public.nas_vorschlaege(id) on delete set null,
  aktion text not null check (aktion in ('angenommen', 'korrigiert', 'abgelehnt')),
  beschrieb jsonb not null,
  dokart text,
  original_name text,
  vorgeschlagen_ordner text,
  final_ordner text,                 -- null bei abgelehnt
  vorgeschlagen_name text,
  final_name text,
  ordner_geaendert boolean,
  name_geaendert boolean,
  entschieden_von uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists nas_ablage_lernbeispiele_neu
  on public.nas_ablage_lernbeispiele (created_at desc);
create index if not exists nas_ablage_lernbeispiele_dokart
  on public.nas_ablage_lernbeispiele (dokart);

alter table public.nas_ablage_lernbeispiele enable row level security;

drop policy if exists nas_ablage_lernbeispiele_select on public.nas_ablage_lernbeispiele;
create policy nas_ablage_lernbeispiele_select on public.nas_ablage_lernbeispiele
  for select using ((select public.is_admin()));
drop policy if exists nas_ablage_lernbeispiele_insert on public.nas_ablage_lernbeispiele;
create policy nas_ablage_lernbeispiele_insert on public.nas_ablage_lernbeispiele
  for insert with check ((select public.is_admin()));
drop policy if exists nas_ablage_lernbeispiele_update on public.nas_ablage_lernbeispiele;
create policy nas_ablage_lernbeispiele_update on public.nas_ablage_lernbeispiele
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists nas_ablage_lernbeispiele_delete on public.nas_ablage_lernbeispiele;
create policy nas_ablage_lernbeispiele_delete on public.nas_ablage_lernbeispiele
  for delete using ((select public.is_admin()));
