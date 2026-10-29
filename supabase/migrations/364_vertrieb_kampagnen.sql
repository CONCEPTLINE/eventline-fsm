-- 364: Vertrieb › Kampagnen (Leo, 29.10.2026).
--
-- !! Nummer beim Zusammenführen prüfen: höchste Nummer auf origin/main UND
-- !! allen Branches + 1 (Stand 29.10.2026: 363 auf main, 356 auf vertrieb-einfach).
-- !! Voraussetzung: 356_vertrieb_raeume.sql ist eingespielt (gleicher Branch).
--
-- Das FSM ersetzt die Excel-Listen der Akquise (Messen, Schulen). Je
-- Kampagne eine Liste von Kontakten mit Status und der versendeten Mail.
-- Der Status wird automatisch nachgeführt (gesendet / Antwort erhalten /
-- nicht zustellbar) über Leos Microsoft-365-Postfach (Cron
-- /api/cron/vertrieb-mail-sync, Logik src/lib/vertrieb/mail-sync.ts).
-- Setzt ein Mensch den Status, gilt status_manuell = true und die
-- Automatik überschreibt ihn nie mehr.
--
-- Inhalt (idempotent, nur additiv):
--   1. vertrieb_kampagnen            — z. B. «Messe 2027», «Schulen 2027»
--   2. vertrieb_kampagne_kontakte    — die Kontakte je Kampagne
--      + sortier_rang (generiert): Antworten zuerst, dann «Anrufen», …
--   3. vertrieb_kampagne_zahlen()    — Kennzahlen je Status + Gruppen in EINER Abfrage
--   4. vertrieb_m365_verbindung      — Refresh-Token + Sync-Stand, nur Server
--
-- RLS (§5): alle vier Verben explizit, Admin kommt über has_permission().
-- Lesen = vertrieb:view, Schreiben = vertrieb:edit. Löschen ebenfalls mit
-- vertrieb:edit (wie in der Vorgabe; die UI bietet in v1 kein Löschen an).

-- ===========================================================================
-- 1. vertrieb_kampagnen
-- ===========================================================================
create table if not exists public.vertrieb_kampagnen (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  beschreibung text,
  -- Bezeichnung der Gruppierung in der UI, z. B. «Messe» oder «Welle».
  gruppe_label text,
  sortierung int not null default 0,
  aktiv boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.vertrieb_kampagnen enable row level security;

drop policy if exists vertrieb_kampagnen_select on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_select on public.vertrieb_kampagnen
  for select to authenticated using ((select public.has_permission('vertrieb:view')));

drop policy if exists vertrieb_kampagnen_insert on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_insert on public.vertrieb_kampagnen
  for insert to authenticated with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_kampagnen_update on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_update on public.vertrieb_kampagnen
  for update to authenticated
  using ((select public.has_permission('vertrieb:edit')))
  with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_kampagnen_delete on public.vertrieb_kampagnen;
create policy vertrieb_kampagnen_delete on public.vertrieb_kampagnen
  for delete to authenticated using ((select public.has_permission('vertrieb:edit')));

-- ===========================================================================
-- 2. vertrieb_kampagne_kontakte
-- ===========================================================================
create table if not exists public.vertrieb_kampagne_kontakte (
  id uuid primary key default gen_random_uuid(),
  kampagne_id uuid not null references public.vertrieb_kampagnen(id) on delete cascade,
  -- Bestehende Lead-Nummer aus der Excel-Liste, z. B. «230» oder «S5».
  nr text not null check (length(btrim(nr)) > 0),
  firma text not null check (length(btrim(firma)) > 0),
  -- Messename bzw. Welle.
  gruppe text,
  prioritaet text,
  ansprechperson text,
  funktion text,
  email text,
  telefon text,
  website text,
  ort text,
  -- Kanton / Land.
  region text,
  hinweis text,
  -- Leos Notizen (in der App editierbar).
  notizen text,
  status text not null default 'offen'
    check (status in ('offen','geplant','gesendet','geantwortet','termin','offerte','auftrag','kein_bedarf','unzustellbar','anrufen')),
  -- Die Mail, wie sie (über die Microsoft-Planung) verschickt wird.
  mail_betreff text,
  mail_text text,
  mail_sprache text,
  -- Dateiname des Anhangs (nur der Name, die Datei liegt im Postfach).
  mail_anhang text,
  -- Empfängeradresse der Mail (kann von email abweichen).
  mail_an text,
  mail_geplant_am timestamptz,
  mail_gesendet_am timestamptz,
  graph_message_id text,
  -- Antworten: nur Zeit + Betreff, nie Inhalte (Mail.ReadBasic).
  letzte_antwort_am timestamptz,
  letzte_antwort_betreff text,
  antworten_anzahl int not null default 0,
  -- true, sobald ein Mensch den Status setzt → Automatik überschreibt nie.
  status_manuell boolean not null default false,
  -- Standard-Reihenfolge der Liste: wo Leo handeln muss, steht oben.
  -- 0 Antwort erhalten · 1 Anrufen · 2 Termin/Offerte · 3 offen/geplant/
  -- angeschrieben · 4 abgeschlossen (Auftrag, kein Interesse, nicht zustellbar).
  sortier_rang smallint generated always as (
    case status
      when 'geantwortet' then 0
      when 'anrufen' then 1
      when 'termin' then 2
      when 'offerte' then 2
      when 'offen' then 3
      when 'geplant' then 3
      when 'gesendet' then 3
      else 4
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint vertrieb_kampagne_kontakte_nr_unique unique (kampagne_id, nr)
);

create index if not exists vertrieb_kampagne_kontakte_status_idx
  on public.vertrieb_kampagne_kontakte (kampagne_id, status);
create index if not exists vertrieb_kampagne_kontakte_gruppe_idx
  on public.vertrieb_kampagne_kontakte (kampagne_id, gruppe);
create index if not exists vertrieb_kampagne_kontakte_mail_an_idx
  on public.vertrieb_kampagne_kontakte (lower(mail_an));
-- Liste: Standard-Sortierung (Rang, Firma, id) für die Keyset-Paginierung.
create index if not exists vertrieb_kampagne_kontakte_liste_idx
  on public.vertrieb_kampagne_kontakte (kampagne_id, sortier_rang, firma, id);

-- updated_at + updated_by: auth.uid() ist beim Server-Sync (service_role)
-- leer — dann bleibt updated_by leer, und man sieht: das war die Automatik.
create or replace function public.vertrieb_kampagne_kontakte_beruehrt()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists vertrieb_kampagne_kontakte_updated_at on public.vertrieb_kampagne_kontakte;
create trigger vertrieb_kampagne_kontakte_updated_at
  before update on public.vertrieb_kampagne_kontakte
  for each row execute function public.vertrieb_kampagne_kontakte_beruehrt();

alter table public.vertrieb_kampagne_kontakte enable row level security;

drop policy if exists vertrieb_kampagne_kontakte_select on public.vertrieb_kampagne_kontakte;
create policy vertrieb_kampagne_kontakte_select on public.vertrieb_kampagne_kontakte
  for select to authenticated using ((select public.has_permission('vertrieb:view')));

drop policy if exists vertrieb_kampagne_kontakte_insert on public.vertrieb_kampagne_kontakte;
create policy vertrieb_kampagne_kontakte_insert on public.vertrieb_kampagne_kontakte
  for insert to authenticated with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_kampagne_kontakte_update on public.vertrieb_kampagne_kontakte;
create policy vertrieb_kampagne_kontakte_update on public.vertrieb_kampagne_kontakte
  for update to authenticated
  using ((select public.has_permission('vertrieb:edit')))
  with check ((select public.has_permission('vertrieb:edit')));

drop policy if exists vertrieb_kampagne_kontakte_delete on public.vertrieb_kampagne_kontakte;
create policy vertrieb_kampagne_kontakte_delete on public.vertrieb_kampagne_kontakte
  for delete to authenticated using ((select public.has_permission('vertrieb:edit')));

-- ===========================================================================
-- 3. Kennzahlen + Gruppen einer Kampagne in EINER Abfrage:
--    art = 'status' → Anzahl je Status (Kennzahlen im Kopf)
--    art = 'gruppe' → Anzahl je Gruppe (Messen/Wellen fürs Auswahlfeld)
--    security invoker → dieselbe RLS wie die Tabelle (ohne vertrieb:view
--    kommt nichts zurück).
-- ===========================================================================
create or replace function public.vertrieb_kampagne_zahlen(p_kampagne uuid)
returns table (art text, wert text, anzahl int)
language sql
stable
security invoker
set search_path = public
as $$
  select 'status'::text, k.status, count(*)::int
  from public.vertrieb_kampagne_kontakte k
  where k.kampagne_id = p_kampagne
  group by k.status
  union all
  select 'gruppe'::text, k.gruppe, count(*)::int
  from public.vertrieb_kampagne_kontakte k
  where k.kampagne_id = p_kampagne and k.gruppe is not null and btrim(k.gruppe) <> ''
  group by k.gruppe;
$$;

revoke all on function public.vertrieb_kampagne_zahlen(uuid) from public, anon;
grant execute on function public.vertrieb_kampagne_zahlen(uuid) to authenticated, service_role;

-- ===========================================================================
-- 4. vertrieb_m365_verbindung — Singleton, NUR Server (service_role).
--    RLS an und keine Policies: Browser-Nutzer können weder lesen noch
--    schreiben (alle vier Verben verweigert). Die App zeigt den Sync-Stand
--    über /api/vertrieb/mail-sync (ohne Token).
-- ===========================================================================
create table if not exists public.vertrieb_m365_verbindung (
  id int primary key default 1 check (id = 1),
  postfach text,
  refresh_token text,
  aktualisiert_am timestamptz,
  letzter_sync_am timestamptz,
  letzter_sync_fehler text,
  -- Sperre gegen zwei gleichzeitige Läufe (Cron + «Jetzt abgleichen»).
  sync_gestartet_am timestamptz
);

alter table public.vertrieb_m365_verbindung enable row level security;
revoke all on public.vertrieb_m365_verbindung from public, anon, authenticated;
grant select, insert, update on public.vertrieb_m365_verbindung to service_role;

notify pgrst, 'reload schema';
