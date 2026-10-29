-- 359_lena_protokoll.sql — Protokoll der Telefonassistentin «Lena» (Bland AI).
--
-- Lena ruft waehrend eines Telefonats die Endpunkte /api/lena/* auf
-- (Termine abfragen, Termin / To-do / Auftrags-Notiz anlegen). JEDER Aufruf —
-- auch abgelehnte (falscher Token, falscher Anrufer, falsche Methode,
-- ungueltige Eingabe) — bekommt hier genau eine Zeile.
--
-- Datensparsam: eingabe enthaelt nur das Noetigste (Titel auf 40 Zeichen
-- gekuerzt, Beschreibung und Notiztext nur als Laenge, bei abgelehnter
-- Anmeldung gar nichts); ergebnis ist ein kurzer Status ohne Inhalte
-- (z.B. «Termin angelegt <id> bei INT-26292», «401 Token falsch oder fehlt»).
--
-- Rechte:
--   SELECT  nur Admins (is_admin()), nur eingeloggt (TO authenticated).
--   INSERT  nur die Service-Rolle (die Lena-Routen); authenticated: nein.
--   UPDATE  niemand (Protokoll ist unveraenderlich).
--   DELETE  niemand (Aufraeumen spaeter nur serverseitig).
-- Alle vier Verben bewusst abgedeckt: Policies fuer authenticated + Entzug
-- der Tabellen-Rechte. anon und PUBLIC bekommen gar nichts (Supabase-Default-
-- Grants ausdruecklich entzogen, Referenz Migration 320).
--
-- Einspielen: node scripts/apply-migration.mjs supabase/migrations/359_lena_protokoll.sql
-- Idempotent, nur additiv.

create table if not exists public.lena_protokoll (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  endpunkt text not null,
  anrufer text,
  eingabe jsonb,
  ergebnis text,
  ok boolean not null default false
);

comment on table public.lena_protokoll is
  'Jeder Aufruf der Telefonassistentin Lena (/api/lena/*), auch abgelehnte. Eingabe minimiert, Ergebnis ohne Inhalte. Lesen nur Admins, Schreiben nur Service-Rolle.';

create index if not exists lena_protokoll_created_idx on public.lena_protokoll (created_at desc);

alter table public.lena_protokoll enable row level security;

-- SELECT: nur Admins.
drop policy if exists lena_protokoll_select on public.lena_protokoll;
create policy lena_protokoll_select on public.lena_protokoll
  for select to authenticated
  using ((select public.is_admin()));

-- INSERT/UPDATE/DELETE: fuer eingeloggte Nutzer ausdruecklich verboten
-- (die Service-Rolle umgeht RLS und schreibt das Protokoll).
drop policy if exists lena_protokoll_insert on public.lena_protokoll;
create policy lena_protokoll_insert on public.lena_protokoll
  for insert to authenticated
  with check (false);

drop policy if exists lena_protokoll_update on public.lena_protokoll;
create policy lena_protokoll_update on public.lena_protokoll
  for update to authenticated
  using (false)
  with check (false);

drop policy if exists lena_protokoll_delete on public.lena_protokoll;
create policy lena_protokoll_delete on public.lena_protokoll
  for delete to authenticated
  using (false);

-- Tabellen-Rechte (doppelt haelt besser): anon/PUBLIC nichts, authenticated
-- nur SELECT (gefiltert durch die Policy). Service-Rolle: lesen, anlegen und
-- (fuer spaeteres Aufraeumen) loeschen — aendern auch sie nicht.
revoke all on public.lena_protokoll from public, anon;
revoke insert, update, delete, truncate, references, trigger on public.lena_protokoll from authenticated;
grant select on public.lena_protokoll to authenticated;
revoke update, truncate, references, trigger on public.lena_protokoll from service_role;
grant select, insert, delete on public.lena_protokoll to service_role;
