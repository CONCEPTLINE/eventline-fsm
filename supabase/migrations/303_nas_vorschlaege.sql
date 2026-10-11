-- 303: Vorschlaege der Nachtarbeit (docs/lokale-ki/MASTERPLAN.md §4 «N+1»).
-- Nur additiv, idempotent.
--
-- Das Hauptmodell auf dem Rig schlaegt nachts Zielordner vor:
--   zz           — Rueckstau in den ZZ_*-Ordnern (Gruppe «Rueckstau ZZ» im
--                  Tab «Ablage», Etappe 3),
--   nachpruefung — «zweiter Blick» auf die Ablage des Tages.
-- Angelegt nur ueber POST /api/ki/nachtarbeit (Service-Role, geprueft gegen
-- Datei-Index und aktive Ordnerliste); bestaetigt/korrigiert/abgelehnt von
-- Admins. Nur Pfade, Ordner, Sicherheit und eine minimierte Begruendung
-- (<= 120 Zeichen, bei Personalakten keine) — nie Dokumentinhalt.
--
-- Rechte wie die NAS-Seite (271, 277, 282): (select public.is_admin()),
-- alle 4 Verben.

create table if not exists public.nas_vorschlaege (
  id uuid primary key default gen_random_uuid(),
  art text not null check (art in ('zz', 'nachpruefung')),
  pfad text not null,                  -- relativer Vollpfad inkl. Dateiname
  sha256 text,
  ordner_ist text not null,
  ziel_ordner text not null,
  alternativen text[] not null default '{}' check (cardinality(alternativen) <= 2),
  sicherheit text not null check (sicherheit in ('hoch', 'mittel', 'niedrig')),
  quelle text not null check (quelle in ('regel', 'vorbild', 'modell')),
  begruendung text check (char_length(begruendung) <= 120),
  modell text,
  lauf_id text,
  status text not null default 'offen'
    check (status in ('offen', 'angenommen', 'korrigiert', 'abgelehnt', 'erledigt', 'veraltet')),
  gewaehlt_ordner text,
  entschieden_von uuid references public.profiles(id) on delete set null,
  entschieden_am timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hoechstens ein offener Vorschlag je (art, pfad) — Nachtarbeit idempotent.
create unique index if not exists nas_vorschlaege_offen_uq
  on public.nas_vorschlaege (art, pfad) where status = 'offen';
create index if not exists nas_vorschlaege_status
  on public.nas_vorschlaege (status, art, created_at);
-- Abgleich je Datei (Nachtarbeit: offen/abgelehnt; Sync: verschoben).
create index if not exists nas_vorschlaege_pfad
  on public.nas_vorschlaege (pfad);

alter table public.nas_vorschlaege enable row level security;

drop policy if exists nas_vorschlaege_select on public.nas_vorschlaege;
create policy nas_vorschlaege_select on public.nas_vorschlaege
  for select using ((select public.is_admin()));
drop policy if exists nas_vorschlaege_insert on public.nas_vorschlaege;
create policy nas_vorschlaege_insert on public.nas_vorschlaege
  for insert with check ((select public.is_admin()));
drop policy if exists nas_vorschlaege_update on public.nas_vorschlaege;
create policy nas_vorschlaege_update on public.nas_vorschlaege
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists nas_vorschlaege_delete on public.nas_vorschlaege;
create policy nas_vorschlaege_delete on public.nas_vorschlaege
  for delete using ((select public.is_admin()));
