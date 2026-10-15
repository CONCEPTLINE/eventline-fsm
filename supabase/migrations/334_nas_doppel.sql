-- 334: Doppel-Prüfung der lokalen KI (docs/lokale-ki/SPEC.md §7, 2026-10-15; Masterplan E4.7,
-- freigegeben von Mischa: «ja Duplikate»). Nur additiv, idempotent.
--
-- a) nas_doppel — die Liste des Rigs (POST /api/ki/doppel, rig/eventline-ki/dienst/app/duplikate.py):
--    je Gruppe die Mitglieder. art 'gleich' = exakt gleiche Bytes oder gleicher Inhalt in anderer Form
--    (kopie: gleiche Zahl = gleiche Bytes), art 'fassung' = ein Paar neu → alt (rolle). Nur Pfad
--    (Schreibweise des Datei-Index), Grösse, Zeit, Ähnlichkeit — NIE Text, keine Hashes. Jeder Lauf ersetzt
--    die Liste (lauf_id); was ein Mensch entschieden hat, steht in b).
-- b) nas_doppel_behalten — «Beide behalten»: dieses Paar wird nicht mehr als Doppel gezeigt.
-- c) nas_vorschlaege.status + 'doppel' — eine ZZ-Datei wurde als Doppel in den Quarantäne-Ordner
--    99_System/Duplikate/<Datum>/… verschoben (nie gelöscht); zählt nicht als Ablage-Entscheid (kein Lernbeispiel).
--
-- Rechte: nur Admin, alle 4 Verben explizit ((select public.is_admin()), wie 303). Geschrieben wird über die
-- Service-Role in den Routen.

create table if not exists public.nas_doppel (
  id bigserial primary key,
  gruppe text not null check (char_length(gruppe) <= 40),
  art text not null check (art in ('gleich', 'fassung')),
  pfad text not null check (char_length(pfad) <= 1000),
  groesse bigint,
  geaendert timestamptz,
  kopie smallint check (kopie between 1 and 100),
  rolle text check (rolle in ('neu', 'alt')),
  aehnlichkeit real check (aehnlichkeit >= 0 and aehnlichkeit <= 1),
  lauf_id text not null check (char_length(lauf_id) <= 40),
  aktualisiert timestamptz not null default now(),
  unique (gruppe, pfad)
);
create index if not exists nas_doppel_pfad on public.nas_doppel (pfad);
create index if not exists nas_doppel_lauf on public.nas_doppel (lauf_id);

alter table public.nas_doppel enable row level security;
drop policy if exists nas_doppel_select on public.nas_doppel;
create policy nas_doppel_select on public.nas_doppel
  for select using ((select public.is_admin()));
drop policy if exists nas_doppel_insert on public.nas_doppel;
create policy nas_doppel_insert on public.nas_doppel
  for insert with check ((select public.is_admin()));
drop policy if exists nas_doppel_update on public.nas_doppel;
create policy nas_doppel_update on public.nas_doppel
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists nas_doppel_delete on public.nas_doppel;
create policy nas_doppel_delete on public.nas_doppel
  for delete using ((select public.is_admin()));

create table if not exists public.nas_doppel_behalten (
  pfad text not null check (char_length(pfad) <= 1000),
  anderer text not null check (char_length(anderer) <= 1000),
  entschieden_von uuid references public.profiles(id) on delete set null,
  entschieden_am timestamptz not null default now(),
  primary key (pfad, anderer)
);

alter table public.nas_doppel_behalten enable row level security;
drop policy if exists nas_doppel_behalten_select on public.nas_doppel_behalten;
create policy nas_doppel_behalten_select on public.nas_doppel_behalten
  for select using ((select public.is_admin()));
drop policy if exists nas_doppel_behalten_insert on public.nas_doppel_behalten;
create policy nas_doppel_behalten_insert on public.nas_doppel_behalten
  for insert with check ((select public.is_admin()));
drop policy if exists nas_doppel_behalten_update on public.nas_doppel_behalten;
create policy nas_doppel_behalten_update on public.nas_doppel_behalten
  for update using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists nas_doppel_behalten_delete on public.nas_doppel_behalten;
create policy nas_doppel_behalten_delete on public.nas_doppel_behalten
  for delete using ((select public.is_admin()));

-- Status-Check robust ersetzen (303 hat ihn unbenannt angelegt) — gleiche Werte plus 'doppel'.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.nas_vorschlaege'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.nas_vorschlaege drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.nas_vorschlaege
  add constraint nas_vorschlaege_status_check
  check (status in ('offen', 'angenommen', 'korrigiert', 'abgelehnt', 'erledigt', 'veraltet', 'doppel'));
